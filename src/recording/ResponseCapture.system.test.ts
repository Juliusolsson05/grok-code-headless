import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { ResponseCapture } from './ResponseCapture.js'

it('saves explicitly with private permissions and refuses to overwrite existing evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-capture-'))
  const path = join(directory, 'capture.json')
  try {
    const capture = new ResponseCapture()
    capture.write('one', Buffer.from(': keepalive\n\n'))
    capture.end('one')
    await capture.save(path)
    expect(await readFile(path, 'utf8')).toBe(capture.serialize())
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(capture.save(path)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
