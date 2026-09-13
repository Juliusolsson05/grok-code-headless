import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// Stage 1 closes with a verdict for every Claude render shape against the
// recorded Grok corpus. The verdicts are only useful if their citations are
// real: a verdict pointing at a sequence that does not carry the named signal
// would send the Stage 2 catalog to evidence that does not exist. This test
// therefore re-derives each cited signal from the committed timeline line.

const fixtures = new URL('../../../testing/fixtures/controlled-runtime/', import.meta.url)
const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, fixtures), 'utf8'))
const checklist = await readJson('claude-shape-checklist.json') as { shapes: Array<{ claudeShapeId: string }> }
type Evidence = { signal: string; scenario: string; sequence: number }
const verdicts = await readJson('claude-shape-verdicts.json') as {
  verdicts: Array<{ claudeShapeId: string; verdict: string; grok: Evidence[]; note: string }>
  uncataloguedGrokSignals: Array<Evidence & { note: string }>
}

/** Signals a normalized timeline line carries. Discriminator keys are read at
 * any depth of data, frames (including their JSON payloads) and native
 * updates/events rows; chat_history rows contribute row, synthetic-reason and
 * content-part types, because their other identities are independently
 * normalized. */
function signalsOf(line: any): Set<string> {
  const signals = new Set<string>()
  const walk = (value: unknown, parent = ''): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, parent); return }
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (['sessionUpdate', 'variant', 'tool_name', 'method', 'updateType'].includes(key) && typeof item === 'string') signals.add(`${key}:${item}`)
      if (key === 'kind' && (parent === 'update' || parent === 'toolCall') && typeof item === 'string') signals.add(`tool-kind:${item}`)
      if (key === 'payload' && typeof item === 'string' && item.startsWith('{')) walk(JSON.parse(item), key)
      else walk(item, key)
    }
  }
  walk(line.data)
  for (const frame of line.frames ?? []) walk(frame)
  const row = line.row
  if (row && typeof row === 'object') {
    if (line.data?.file === 'chat_history.jsonl') {
      if (typeof row.type === 'string') signals.add(`chat-row:${row.type}`)
      if (typeof row.synthetic_reason === 'string') signals.add(`chat-synthetic:${row.synthetic_reason}`)
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) signals.add('chat-row:tool_calls')
      for (const part of Array.isArray(row.content) ? row.content : []) if (typeof part?.type === 'string') signals.add(`chat-part:${part.type}`)
    } else {
      if (typeof row.type === 'string') signals.add(`${line.data?.file}:${row.type}`)
      walk(row)
    }
  }
  return signals
}

const timelines = new Map<string, Map<number, any>>()
async function lineAt(scenario: string, sequence: number) {
  if (!timelines.has(scenario)) {
    const jsonl = await readFile(new URL(`corpus/${scenario}.jsonl`, fixtures), 'utf8')
    timelines.set(scenario, new Map(jsonl.trimEnd().split('\n').map(text => JSON.parse(text)).map(line => [line.sequence, line])))
  }
  return timelines.get(scenario)!.get(sequence)
}

describe('Claude render shape verdicts against the recorded Grok corpus', () => {
  it('gives every checklist shape exactly one well-formed verdict and nothing else', () => {
    const ids = verdicts.verdicts.map(entry => entry.claudeShapeId)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(checklist.shapes.map(shape => shape.claudeShapeId).sort())
    for (const entry of verdicts.verdicts) {
      expect(['recorded-counterpart', 'not-recorded'], entry.claudeShapeId).toContain(entry.verdict)
      expect(entry.note.trim().length, entry.claudeShapeId).toBeGreaterThan(0)
      if (entry.verdict === 'recorded-counterpart') expect(entry.grok.length, entry.claudeShapeId).toBeGreaterThan(0)
    }
  })

  it.each([
    ...verdicts.verdicts.flatMap(entry => entry.grok.map(evidence => [entry.claudeShapeId, evidence] as const)),
    ...verdicts.uncataloguedGrokSignals.map(evidence => ['uncatalogued', evidence] as const),
  ])('%s cites %o where the corpus really carries it', async (_owner, evidence) => {
    const line = await lineAt(evidence.scenario, evidence.sequence)
    expect(line, `${evidence.scenario}:${evidence.sequence} exists`).toBeDefined()
    expect([...signalsOf(line)]).toContain(evidence.signal)
  })
})
