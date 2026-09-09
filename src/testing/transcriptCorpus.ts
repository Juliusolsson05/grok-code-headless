import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { normalizeTranscript } from './normalizeTranscript.js'

export interface TranscriptFixtureManifest {
  version: 1
  source: 'native Grok chat_history.jsonl'
  normalization: 'shape-only-v1'
  sessions: Array<{
    file: string
    records: number
    bytes: number
    sha256: string
    types: Record<string, number>
    syntheticReasons: Record<string, number>
  }>
}

export async function generateTranscriptFixtures(source: string, output?: string): Promise<TranscriptFixtureManifest> {
  if (output && process.env.UPDATE_FIXTURES !== '1') throw new Error('Set UPDATE_FIXTURES=1 to generate fixtures')
  const sourceRoot = await realpath(source).catch(() => { throw new Error('Cannot resolve source storage') })
  let outputRoot: string | undefined
  if (output) {
    const destination = resolve(output)
    const parent = await realpath(dirname(destination)).catch(() => { throw new Error('Cannot resolve output parent') })
    outputRoot = join(parent, basename(destination))
    const contains = (root: string, path: string) => {
      const child = relative(root, path)
      return child === '' || (child !== '..' && !child.startsWith(`..${sep}`))
    }
    if (contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot)) throw new Error('Source and output must not overlap')
  }
  const directories = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true })
      .catch(() => { throw new Error('Cannot enumerate source storage') })
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error('Symlinked source directories are not supported')
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  }

  const manifest: TranscriptFixtureManifest = {
    version: 1, source: 'native Grok chat_history.jsonl', normalization: 'shape-only-v1', sessions: [],
  }
  const files: string[] = []
  let sourceIndex = 0
  for (const project of await directories(sourceRoot)) {
    for (const session of await directories(join(sourceRoot, project))) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)) continue
      sourceIndex += 1
      const file = await open(join(sourceRoot, project, session, 'chat_history.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null // Native sessions can exist before their first chat item.
          throw new Error(`Cannot read source session ${sourceIndex}`)
        })
      if (!file) continue
      let raw: string
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw new Error('Unsupported source')
        // Read only the original size, not a growing stream with no EOF. The
        // post-read stat detects append/rewrite during capture; refusing it is
        // safer than teaching replay tests that a partial turn was complete.
        const buffer = Buffer.alloc(Number(before.size))
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
          if (bytesRead === 0) throw new Error('Source was truncated')
          offset += bytesRead
        }
        const after = await file.stat({ bigint: true })
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Source changed')
        raw = buffer.toString('utf8')
      } catch {
        throw new Error(`Cannot read stable source session ${sourceIndex}`)
      } finally { await file.close() }

      const records: Record<string, unknown>[] = []
      const lines = raw.split('\n')
      if (lines.at(-1) === '') lines.pop()
      for (const [index, line] of lines.entries()) {
        let value: unknown
        try { value = JSON.parse(line) } catch {
          // JSON.parse errors include an excerpt of the private input. Never
          // attach the original exception as a cause or print source paths.
          throw new Error(`Source session ${sourceIndex} has malformed JSON at line ${index + 1}`)
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Source session ${sourceIndex} has a non-object record at line ${index + 1}`)
        records.push(value as Record<string, unknown>)
      }
      const normalized = normalizeTranscript(records)
      const jsonl = normalized.map(record => JSON.stringify(record) + '\n').join('')
      files.push(jsonl)
      const count = (key: string) => {
        const result: Record<string, number> = {}
        for (const record of normalized) {
          const value = record[key]
          if (typeof value === 'string') result[value] = (result[value] ?? 0) + 1
        }
        return result
      }
      manifest.sessions.push({
        file: `session-${String(files.length).padStart(3, '0')}.jsonl`,
        records: normalized.length, bytes: Buffer.byteLength(jsonl),
        // Hash the published, normalized evidence only. Source hashes and
        // origin paths are unnecessary correlations to a user's private work.
        sha256: createHash('sha256').update(jsonl).digest('hex'),
        types: count('type'), syntheticReasons: count('synthetic_reason'),
      })
    }
  }
  if (outputRoot) {
    // Exclusive publication never overwrites previous evidence or native
    // files. The manifest is written last: a failed export is not a corpus.
    try {
      await mkdir(outputRoot, { mode: 0o700 })
      for (const [index, session] of manifest.sessions.entries()) {
        await writeFile(join(outputRoot, session.file), files[index], { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch { throw new Error('Cannot create fixture output; use a new writable directory. A partial export without a manifest must not be used.') }
  }
  return manifest
}
