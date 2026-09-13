import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertPrivateCaptureLocation, RuntimeCapture, verifyRuntimeCapture } from './Capture.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'g-capture-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('preserves a recorded native stream through real fragmented file reads and private capture storage', async () => {
  const path = new URL('../../../testing/fixtures/streaming/native-papaya.sse', import.meta.url)
  const original = await readFile(path)
  const capture = await RuntimeCapture.create(root, { scenario: 'recorder-fidelity', provenance: 'recorded minimized SSE; controlled fragmentation' })
  for await (const chunk of createReadStream(path, { highWaterMark: 97 })) capture.record('wire', 'received', {}, chunk)
  const manifest = capture.finish('passed')
  const verified = await verifyRuntimeCapture(capture.directory)
  const restored = Buffer.concat(await Promise.all(verified.events.map((event: any) => readFile(join(capture.directory, event.blob.path)))))
  expect(restored).toEqual(original)
  expect(manifest.captureComplete).toBe(true)
  expect(manifest.captureCompletenessScope).toBe('storage-integrity-only')
  expect(verified.events.map((event: any) => event.sequence)).toEqual(verified.events.map((_: unknown, index: number) => index + 1))
  expect((await stat(capture.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(capture.directory, 'events.jsonl'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(capture.directory, verified.events[0]!.blob!.path))).mode & 0o777).toBe(0o600)
})

it('reports a lossy capture as incomplete even when the provider scenario passed', async () => {
  const capture = await RuntimeCapture.create(root, { scenario: 'capacity' }, { maxBytes: 1024 })
  expect(capture.record('wire', 'received', {}, Buffer.alloc(2048))).toBe(false)
  const manifest = capture.finish('passed')
  expect(manifest).toMatchObject({ scenarioOutcome: 'passed', captureComplete: false, droppedObservations: 1 })
  expect((await verifyRuntimeCapture(capture.directory)).manifest.captureComplete).toBe(false)
})

it('detects changed byte artifacts rather than blessing their journal references', async () => {
  const capture = await RuntimeCapture.create(root, { scenario: 'integrity' })
  capture.record('wire', 'received', {}, Buffer.from('controlled bytes'))
  capture.finish('passed')
  const verified = await verifyRuntimeCapture(capture.directory)
  await writeFile(join(capture.directory, verified.events[0]!.blob!.path), 'changed bytes')
  await expect(verifyRuntimeCapture(capture.directory)).rejects.toThrow(/integrity/)
})

it('refuses exact private capture storage anywhere inside a git work tree', async () => {
  // `.git` is a directory in an ordinary clone but a FILE in a linked worktree
  // or submodule checkout (this package's own worktree is one). Both must be
  // refused, and the refusal must leave no partially created capture behind.
  for (const marker of ['directory', 'file'] as const) {
    const repository = join(root, `repository-${marker}`)
    const nested = join(repository, 'captures', 'nested')
    await mkdir(nested, { recursive: true })
    if (marker === 'directory') await mkdir(join(repository, '.git'))
    else await writeFile(join(repository, '.git'), 'gitdir: /elsewhere/.git/worktrees/controlled\n')

    await expect(RuntimeCapture.create(nested, { scenario: `inside-git-${marker}` })).rejects.toThrow(/inside a git work tree/)
    expect(await readdir(nested)).toEqual([])
    // The runner checks its --output before creating it, so a path that does not
    // exist yet must be judged by its nearest existing ancestor.
    await expect(assertPrivateCaptureLocation(join(repository, 'not-yet', 'deeper'))).rejects.toThrow(/inside a git work tree/)
    // A link that lives outside the repository but resolves into it is inside.
    const link = join(root, `outside-link-${marker}`)
    await symlink(nested, link)
    await expect(RuntimeCapture.create(link, { scenario: `linked-${marker}` })).rejects.toThrow(/inside a git work tree/)
    expect(await readdir(nested)).toEqual([])
  }
  // And the walk must not refuse an ordinary private location.
  await expect(assertPrivateCaptureLocation(join(root, 'outside', 'not-yet'))).resolves.toBeUndefined()
})

it('does not silently extend a sealed observation window', async () => {
  const capture = await RuntimeCapture.create(root, { scenario: 'sealed' })
  capture.finish('passed')
  expect(() => capture.record('wire', 'received')).toThrow(/sealed/)
})
