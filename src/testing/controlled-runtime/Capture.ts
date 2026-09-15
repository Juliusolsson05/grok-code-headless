import { closeSync, constants, fsyncSync, openSync, renameSync, writeSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

type BlobRef = { path: string; bytes: number; sha256: string }
export type CaptureEvent = { sequence: number; atMs: number; channel: string; kind: string; data: unknown; blob?: BlobRef }
export type CaptureManifest = {
  schemaVersion: 1 | 2; metadata: Record<string, unknown>; captureComplete: boolean
  captureCompletenessScope?: 'storage-integrity-only'
  scenarioOutcome: 'passed' | 'failed'; observations: number; droppedObservations: number
  failure: string | null; channelCounts: Record<string, number>; journal: BlobRef; totalBytes: number
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const LIMIT = 256 * 1024 * 1024

/**
 * Refuse private capture storage inside any git work tree.
 *
 * WHY enforce this in code rather than with a .gitignore entry or the runner's
 * documented `--output` convention: an exact capture retains prompts, raw IPC
 * bytes, native session files, absolute paths, PIDs and fixture credentials,
 * and the Stage 1 plan requires those originals to stay out of every repository
 * until a separate privacy review produces derived fixtures. An ignore pattern
 * only covers the names somebody anticipated, and `git add -f`, a renamed output
 * directory or a different repository bypass it silently. RuntimeCapture is the
 * single owner of private disk writes, so checking at creation covers the
 * runner, tests and any future entrypoint; the runner also calls this before it
 * creates its output directory because its batch index is not a RuntimeCapture.
 *
 * The requested path may not exist yet, so its nearest existing ancestor decides
 * membership. `.git` is a FILE in linked worktrees and submodule checkouts (this
 * package is developed in one), so mere existence is the marker.
 *
 * Known limit: only `.git` markers are recognised. A work tree defined purely by
 * GIT_DIR/GIT_WORK_TREE, `core.worktree`, or a bare repository driven with
 * `--work-tree` (common for dotfiles in $HOME) has no marker and is not detected.
 * Asking git itself would put a subprocess and the caller's git environment into
 * every capture for setups this recorder is never pointed at.
 */
export async function assertPrivateCaptureLocation(path: string): Promise<void> {
  let existing = resolve(path)
  for (;;) {
    try { existing = await realpath(existing); break } catch (error) {
      const parent = dirname(existing)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error
      existing = parent
    }
  }
  for (let current = existing; ; current = dirname(current)) {
    if (await hasGitMarker(current)) throw new Error(`Private runtime captures cannot be stored inside a git work tree: ${current}`)
    if (dirname(current) === current) return
  }
}

function hasGitMarker(directory: string): Promise<boolean> {
  return lstat(join(directory, '.git')).then(() => true, (error: NodeJS.ErrnoException) => {
    // Fail closed on anything except "missing": an ancestor we cannot inspect
    // cannot prove the capture is outside a repository.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  })
}

/** Explicit test-only recorder. Exact bytes go to private blobs, never through
 * JSON decoding or a semantic projection. Synchronous bounded writes preserve
 * observer arrival order; they are not a claim about native execution order or
 * uninstrumented timing. A failed recorder stops accepting data and marks loss,
 * rather than aborting the real provider or publishing a complete-looking trace. */
export class RuntimeCapture {
  private readonly started = performance.now()
  private readonly journalHash = createHash('sha256')
  private readonly counts: Record<string, number> = Object.create(null)
  private fd: number
  private sequence = 0
  private journalBytes = 0
  private totalBytes = 0
  private dropped = 0
  private failure: string | null = null
  private sealed = false
  private constructor(readonly directory: string, private readonly metadata: Record<string, unknown>, private readonly maxBytes: number) {
    this.fd = openSync(join(directory, 'events.jsonl'), 'wx', 0o600)
  }
  static async create(parent: string, metadata: Record<string, unknown>, options: { maxBytes?: number } = {}): Promise<RuntimeCapture> {
    const maxBytes = options.maxBytes ?? 128 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > LIMIT) throw new Error('Invalid capture budget')
    const encoded = JSON.stringify(metadata)
    if (Buffer.byteLength(encoded) > 65536) throw new Error('Capture metadata too large')
    // Check and create through the SAME resolved path. Resolving `..` lexically
    // for the check but through symlinks for mkdtemp would approve one directory
    // and write into another (`link/../captures` where `link` points into a repo).
    const real = await realpath(parent)
    await assertPrivateCaptureLocation(real)
    const directory = await mkdtemp(join(real, 'grok-recording-'))
    try {
      await mkdir(join(directory, 'blobs'), { mode: 0o700 })
      return new RuntimeCapture(directory, JSON.parse(encoded), maxBytes)
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }
  record(channel: string, kind: string, data: unknown = {}, bytes?: Uint8Array): boolean {
    if (this.sealed) throw new Error('Capture observation window is sealed')
    if (this.failure) { this.dropped++; return false }
    try {
      if (!channel || !kind || channel.length > 128 || kind.length > 128) throw new Error('Invalid capture label')
      const sequence = this.sequence + 1
      const blob = bytes ? { path: `blobs/${String(sequence).padStart(8, '0')}.bin`, bytes: bytes.byteLength, sha256: digest(bytes) } : undefined
      const event: CaptureEvent = { sequence, atMs: performance.now() - this.started, channel, kind, data, ...(blob ? { blob } : {}) }
      const line = Buffer.from(JSON.stringify(event) + '\n')
      if (line.length > 2 * 1024 * 1024 || this.totalBytes + line.length + (bytes?.byteLength ?? 0) > this.maxBytes) {
        this.failure = 'capacity'; this.dropped++; return false
      }
      if (blob && bytes) {
        const fd = openSync(join(this.directory, blob.path), 'wx', 0o600)
        try { writeAll(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
        this.totalBytes += bytes.byteLength
      }
      writeAll(this.fd, line, part => { this.journalHash.update(part); this.journalBytes += part.byteLength; this.totalBytes += part.byteLength })
      this.sequence = sequence
      this.counts[`${channel}:${kind}`] = (this.counts[`${channel}:${kind}`] ?? 0) + 1
      return true
    } catch { this.failure = 'serialization-or-io'; this.dropped++; return false }
  }
  finish(outcome: 'passed' | 'failed'): CaptureManifest {
    if (this.sealed) throw new Error('Capture observation window is sealed')
    this.sealed = true
    try { fsyncSync(this.fd) } catch { this.failure ??= 'sync' }
    finally { closeSync(this.fd); this.fd = -1 }
    const manifest: CaptureManifest = {
      schemaVersion: 2, metadata: this.metadata, captureComplete: this.failure === null,
      // Coverage is established by scenario assertions and the later observed-
      // case catalog. This flag certifies only that the recorder retained every
      // observation offered to it and that its artifact set verifies intact.
      captureCompletenessScope: 'storage-integrity-only',
      scenarioOutcome: outcome, observations: this.sequence, droppedObservations: this.dropped,
      failure: this.failure, channelCounts: this.counts,
      journal: { path: 'events.jsonl', bytes: this.journalBytes, sha256: this.journalHash.digest('hex') }, totalBytes: this.totalBytes,
    }
    // Discovery last: a crash during recording leaves no certified manifest.
    // Scenario success and capture completeness are deliberately independent.
    const pending = join(this.directory, 'manifest.pending')
    const fd = openSync(pending, 'wx', 0o600)
    try { writeAll(fd, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(pending, join(this.directory, 'manifest.json'))
    return manifest
  }
}

function writeAll(fd: number, bytes: Uint8Array, written?: (part: Uint8Array) => void) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (count <= 0) throw new Error('Capture write made no progress')
    written?.(bytes.subarray(offset, offset + count)); offset += count
  }
}
async function readArtifact(path: string, limit = LIMIT): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > limit) throw new Error('Invalid capture artifact')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('Capture artifact changed')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Capture artifact changed')
    return bytes
  } finally { await file.close() }
}
export async function verifyRuntimeCapture(directory: string): Promise<{ manifest: CaptureManifest; events: CaptureEvent[] }> {
  const manifest = JSON.parse((await readArtifact(join(directory, 'manifest.json'), 1024 * 1024)).toString()) as CaptureManifest
  // Schema 1 captures predate the explicit scope label and are retained private
  // evidence. Their field always had storage-integrity semantics, so accepting
  // them is a concrete persisted-data compatibility requirement, not a guess.
  if (![1, 2].includes(manifest.schemaVersion) || manifest.journal?.path !== 'events.jsonl' ||
    (manifest.schemaVersion === 2 && manifest.captureCompletenessScope !== 'storage-integrity-only')) throw new Error('Invalid capture manifest')
  const journal = await readArtifact(join(directory, 'events.jsonl'))
  if (journal.byteLength !== manifest.journal.bytes || digest(journal) !== manifest.journal.sha256) throw new Error('Capture journal integrity mismatch')
  const text = journal.toString('utf8')
  if (text && !text.endsWith('\n')) throw new Error('Incomplete capture journal')
  const events: CaptureEvent[] = text ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : []
  if (events.length !== manifest.observations) throw new Error('Capture event count mismatch')
  let atMs = -1
  let totalBytes = journal.length
  const counts: Record<string, number> = Object.create(null)
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || !Number.isFinite(event.atMs) || event.atMs < atMs || typeof event.channel !== 'string' || typeof event.kind !== 'string') throw new Error('Capture ordering mismatch')
    atMs = event.atMs
    counts[`${event.channel}:${event.kind}`] = (counts[`${event.channel}:${event.kind}`] ?? 0) + 1
    if (event.blob) {
      if (event.blob.path !== `blobs/${String(event.sequence).padStart(8, '0')}.bin`) throw new Error('Invalid capture blob reference')
      const bytes = await readArtifact(join(directory, event.blob.path))
      if (bytes.length !== event.blob.bytes || digest(bytes) !== event.blob.sha256) throw new Error('Capture blob integrity mismatch')
      totalBytes += bytes.length
    }
  }
  if (manifest.captureComplete && (manifest.droppedObservations !== 0 || manifest.failure !== null || totalBytes !== manifest.totalBytes)) throw new Error('Lossy capture claims completeness')
  if (JSON.stringify(counts) !== JSON.stringify(manifest.channelCounts)) throw new Error('Capture channel count mismatch')
  return { manifest, events }
}

export async function readVerifiedCaptureBlob(directory: string, event: CaptureEvent): Promise<Buffer> {
  if (!event.blob) throw new Error('Capture event has no blob')
  const bytes = await readArtifact(join(directory, event.blob.path))
  if (bytes.length !== event.blob.bytes || digest(bytes) !== event.blob.sha256) throw new Error('Capture blob integrity mismatch')
  return bytes
}
