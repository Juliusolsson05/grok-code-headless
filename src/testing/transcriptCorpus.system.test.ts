import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateTranscriptFixtures } from './transcriptCorpus.js'
import { decodeGrokConversationItem } from '../transcript/ConversationItem.js'

describe('offline native transcript fixture generation', () => {
  let root: string
  let source: string
  let session: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'grok-fixture-export-'))
    source = join(root, 'sessions')
    session = join(source, '%2FPRIVATE%2Fproject', '11111111-1111-4111-8111-111111111111')
    await mkdir(session, { recursive: true })
    vi.stubEnv('UPDATE_FIXTURES', '1')
  })
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

  it('normalizes a recorded native session without changing its original or publishing its origin', async () => {
    const original = await readFile(new URL('../../testing/fixtures/chat-history.toolcall.jsonl', import.meta.url), 'utf8')
    await writeFile(join(session, 'chat_history.jsonl'), original)
    const output = join(root, 'published')
    const report = await generateTranscriptFixtures(source, output)
    expect(await readFile(join(session, 'chat_history.jsonl'), 'utf8')).toBe(original)
    expect(report.sessions).toHaveLength(1)
    const normalized = await readFile(join(output, 'session-001.jsonl'), 'utf8')
    expect(normalized.trimEnd().split('\n').map(decodeGrokConversationItem)).toHaveLength(original.trimEnd().split('\n').length)
    expect(normalized).not.toBe(original)
    const manifest = await readFile(join(output, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain('PRIVATE')
    expect(manifest).not.toContain('11111111-1111')
    expect(JSON.parse(manifest)).toEqual(report)
  })

  it('requires explicit generation opt-in and refuses an existing output directory', async () => {
    await writeFile(join(session, 'chat_history.jsonl'), '')
    vi.stubEnv('UPDATE_FIXTURES', '')
    await expect(generateTranscriptFixtures(source, join(root, 'new'))).rejects.toThrow('UPDATE_FIXTURES=1')
    vi.stubEnv('UPDATE_FIXTURES', '1')
    await expect(generateTranscriptFixtures(source, root)).rejects.toThrow('overlap')
    const existing = join(root, 'existing')
    await mkdir(existing)
    await writeFile(join(existing, 'keep'), 'original')
    await expect(generateTranscriptFixtures(source, existing)).rejects.toThrow('output')
    expect(await readFile(join(existing, 'keep'), 'utf8')).toBe('original')
  })

  it('does not silently omit a malformed record or expose its content in the error', async () => {
    await writeFile(join(session, 'chat_history.jsonl'), '{"type":"assistant","content":"PRIVATE unterminated')
    const output = join(root, 'published')
    await expect(generateTranscriptFixtures(source, output)).rejects.toThrow(/^Source session 1 has malformed JSON at line 1$/)
    expect(await readdir(root)).toEqual(['sessions'])
  })

  it('refuses symlinked transcript files and output nested under native storage', async () => {
    const outside = join(root, 'private.jsonl')
    await writeFile(outside, '{"type":"system","content":"PRIVATE outside"}\n')
    await symlink(outside, join(session, 'chat_history.jsonl'))
    await expect(generateTranscriptFixtures(source)).rejects.toThrow(/^Cannot read source session 1$/)
    await expect(generateTranscriptFixtures(source, join(source, 'export'))).rejects.toThrow('overlap')
    expect(await readFile(outside, 'utf8')).toContain('PRIVATE outside')
  })

  it('refuses symlinked project directories instead of silently claiming a complete census', async () => {
    await writeFile(join(session, 'chat_history.jsonl'), '')
    await symlink(root, join(source, 'symlinked-project'))
    await expect(generateTranscriptFixtures(source)).rejects.toThrow('Symlinked source directories are not supported')
  })
})
