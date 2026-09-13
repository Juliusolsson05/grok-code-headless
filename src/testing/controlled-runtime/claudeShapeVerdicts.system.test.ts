import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { signalsOf } from './corpusSignals.js'

// Stage 1 closes with a verdict for every Claude render shape against the
// recorded Grok corpus. The verdicts are only useful if their citations are
// real: a verdict pointing at a sequence that does not carry the named signal
// would send the Stage 2 catalog to evidence that does not exist. This test
// therefore re-derives each cited signal from the committed timeline line,
// with the same signal derivation the Stage 2 catalog gate uses.

const fixtures = new URL('../../../testing/fixtures/controlled-runtime/', import.meta.url)
const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, fixtures), 'utf8'))
const checklist = await readJson('claude-shape-checklist.json') as { shapes: Array<{ claudeShapeId: string }> }
type Evidence = { signal: string; scenario: string; sequence: number }
const verdicts = await readJson('claude-shape-verdicts.json') as {
  verdicts: Array<{ claudeShapeId: string; verdict: string; grok: Evidence[]; note: string }>
  uncataloguedGrokSignals: Array<Evidence & { note: string }>
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
