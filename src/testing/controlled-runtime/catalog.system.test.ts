import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { catalogSignals, inCatalogUniverse } from './corpusSignals.js'

// Stage 2 settles which source owns each recorded fact. The catalog is only
// worth building Stage 3 against if these hold, and each is checked here from
// the committed corpus rather than trusted:
//   1. every citation points at a line that really carries the named signal;
//      every structured ordering (`follows`, `precedes`) holds in that timeline;
//      every identity a citation or reference names (`mentions`, by field) is on
//      that line;
//   2. every recorded scenario is accounted for by at least one fact;
//   3. every derived native signal observed in the corpus has exactly one owner
//      and is cited at least once.
// The third is the reopen mechanism, within its limits: a new value of a
// derived key fails here before runtime code consumes it unowned. Content the
// deriver replaces with placeholders, and keys corpusSignals.ts does not
// derive, cannot fail it; corpusSignals.ts names the deliberate limits.
//
// What is NOT checked: the meaning of `shows`, `resolution`, `expectedOutcome`
// and gap prose. Orderings and identities therefore belong in the structured
// fields, and the catalog keeps sequence numbers out of its prose. contract.md is
// held to the catalog as far as tables allow: every fact and decision is named,
// each decision row states exactly the catalog's value and status, each fact
// row states exactly the catalog's owner, and no row in those tables escapes
// parsing.

const fixtures = new URL('../../../testing/fixtures/controlled-runtime/', import.meta.url)
const readText = (path: string) => readFile(new URL(path, fixtures), 'utf8')

type TimelineLine = { sequence: number; channel: string; kind: string; data?: unknown; row?: unknown; frames?: Array<{ payload?: unknown }> }
type Mention = { field: string; value: string | number }
type Reference = { sequence: number; signal: string; mentions?: Mention[] }
type Citation = { scenario: string; sequence: number; signal: string; shows: string; resolution?: string; follows?: Reference[]; precedes?: Reference[]; mentions?: Mention[] }
type Captures = Record<string, { verified: number; refused: number; failed: number }>
type Fact = {
  id: string; owner: string; expectedOutcome: string
  evidence: Citation[]; variants: Citation[]; contradictions: Citation[]
  gaps: string[]; signals: string[]; samples: Record<string, Captures>
}
type Decision = { id: string; decision: string; status: 'approved' | 'recommended-default' | 'recommended-default-unconfirmed'; options: Record<string, string> }
const catalog = JSON.parse(await readText('catalog.json')) as { decisions: Decision[]; facts: Fact[]; harnessSignals: Record<string, string> }
const manifest = JSON.parse(await readText('corpus/manifest.json')) as { scenarios: Array<{ id: string; file: string; captures: Captures }> }
const contract = await readText('contract.md')

const timelines = new Map<string, TimelineLine[]>()
for (const scenario of manifest.scenarios) {
  const jsonl = await readText(`corpus/${scenario.file}`)
  timelines.set(scenario.id, jsonl.trimEnd().split('\n').map(text => JSON.parse(text)))
}
const lineAt = (scenario: string, sequence: number) => timelines.get(scenario)?.find(candidate => candidate.sequence === sequence)
const citations = (fact: Fact) => [...fact.evidence, ...fact.variants, ...fact.contradictions]

/** Whether some object on the line (its data, its row or a decoded frame payload)
 * sets `field` to exactly `value`.
 * WHY by field and not by substring: one queue notification names both the
 * running prompt and a waiting entry, so a substring match accepted a citation
 * with the two roles swapped. Numeric values let a request and its answer be
 * bound by JSON-RPC id, which the corpus keeps. */
function carries(line: TimelineLine, mention: Mention): boolean {
  const found = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(found)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, item]) => (key === mention.field && item === mention.value) || found(item))
  }
  const payloads = (line.frames ?? []).flatMap(frame => {
    if (typeof frame.payload !== 'string') return []
    try { return [JSON.parse(frame.payload) as unknown] } catch { return [] }
  })
  return found(line.data) || found(line.row) || payloads.some(found)
}

/** Body rows of the table in one `## ` section of contract.md, split into trimmed cells. */
function sectionRows(heading: string): string[][] {
  const lines = contract.split('\n')
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`))
  expect(start, `contract section ${heading}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two table lines are the header and its separator. Every other row
  // must lead with a backticked id: a row that does not parse would otherwise be
  // skipped silently, so a revised decision added in another form could pass.
  const body = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('|')).slice(2)
  expect(body.filter(line => !line.startsWith('| `')), `unparsed rows in ${heading}`).toEqual([])
  return body.map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
}

describe('Grok runtime catalog against the recorded corpus', () => {
  it('cites only lines that carry the named signal, in the claimed order and with the named identities', () => {
    const wrong: string[] = []
    for (const fact of catalog.facts) {
      for (const citation of citations(fact)) {
        const where = `${fact.id}: ${citation.scenario}:${citation.sequence}`
        const line = lineAt(citation.scenario, citation.sequence)
        if (!line) { wrong.push(`${where} does not exist`); continue }
        if (!catalogSignals(line).has(citation.signal)) wrong.push(`${where} lacks ${citation.signal}`)
        for (const mention of citation.mentions ?? []) if (!carries(line, mention)) wrong.push(`${where} does not carry ${mention.field}=${mention.value}`)
        // An ordering claim is only evidence if the other line exists, carries its
        // own signal and identities, and really sits on the claimed side in the
        // same capture.
        const check = (references: Reference[] | undefined, relation: 'follows' | 'precedes') => {
          for (const reference of references ?? []) {
            const other = lineAt(citation.scenario, reference.sequence)
            if (!other || !catalogSignals(other).has(reference.signal)) wrong.push(`${fact.id}: ${citation.scenario}:${reference.sequence} lacks ${reference.signal}`)
            for (const mention of reference.mentions ?? []) if (!other || !carries(other, mention)) wrong.push(`${fact.id}: ${citation.scenario}:${reference.sequence} does not carry ${mention.field}=${mention.value}`)
            const holds = relation === 'follows' ? reference.sequence < citation.sequence : reference.sequence > citation.sequence
            if (!holds) wrong.push(`${where} does not ${relation === 'follows' ? 'follow' : 'precede'} ${reference.sequence}`)
          }
        }
        check(citation.follows, 'follows')
        check(citation.precedes, 'precedes')
      }
    }
    expect(wrong).toEqual([])
  })

  it('accounts for every recorded scenario', () => {
    const cited = new Set(catalog.facts.flatMap(fact => citations(fact).map(citation => citation.scenario)))
    expect(manifest.scenarios.map(scenario => scenario.id).filter(id => !cited.has(id))).toEqual([])
  })

  it('gives every observed native signal exactly one owner that cites it, and owns nothing unobserved', () => {
    const observed = new Set<string>()
    for (const lines of timelines.values()) {
      for (const line of lines) for (const signal of catalogSignals(line)) if (inCatalogUniverse(line, signal)) observed.add(signal)
    }
    const owners = new Map<string, string[]>()
    const own = (signal: string, owner: string) => owners.set(signal, [...(owners.get(signal) ?? []), owner])
    for (const fact of catalog.facts) for (const signal of fact.signals) own(signal, fact.id)
    for (const signal of Object.keys(catalog.harnessSignals)) own(signal, 'harness')
    const cited = new Set(catalog.facts.flatMap(fact => citations(fact).map(citation => citation.signal)))

    expect([...observed].filter(signal => !owners.has(signal)).sort(), 'unowned signals').toEqual([])
    expect([...owners.keys()].filter(signal => !observed.has(signal)).sort(), 'owned but never observed').toEqual([])
    expect([...owners].filter(([, names]) => names.length > 1).map(([signal, names]) => `${signal}: ${names.join(', ')}`), 'owned twice').toEqual([])
    // Ownership without a citation is bookkeeping, not evidence.
    expect(catalog.facts.flatMap(fact => fact.signals.filter(signal => !cited.has(signal)).map(signal => `${fact.id}: ${signal}`)), 'owned but never cited').toEqual([])
  })

  it('records sample counts exactly as the manifest does for every cited scenario', () => {
    const captures = new Map(manifest.scenarios.map(scenario => [scenario.id, scenario.captures]))
    for (const fact of catalog.facts) {
      const cited = [...new Set(citations(fact).map(citation => citation.scenario))]
      expect(Object.keys(fact.samples).sort(), fact.id).toEqual([...cited].sort())
      for (const scenario of cited) expect(fact.samples[scenario], `${fact.id} ${scenario}`).toEqual(captures.get(scenario))
    }
  })

  it('keeps every fact complete and every decision resolvable', () => {
    const ids = catalog.facts.map(fact => fact.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const fact of catalog.facts) {
      expect(fact.evidence.length, fact.id).toBeGreaterThan(0)
      expect(fact.expectedOutcome.trim().length, fact.id).toBeGreaterThan(0)
      // A contradiction without a resolution would leave the root class to pick
      // an owner silently, which is exactly what Stage 2 exists to prevent.
      for (const contradiction of fact.contradictions) expect(contradiction.resolution?.trim().length, `${fact.id} contradiction`).toBeGreaterThan(0)
    }
    for (const decision of catalog.decisions) {
      expect(Object.keys(decision.options), decision.id).toContain(decision.decision)
      expect(['approved', 'recommended-default', 'recommended-default-unconfirmed'], decision.id).toContain(decision.status)
    }
  })

  it('states each decision value and status, and each fact owner, exactly as the catalog does in contract.md', () => {
    for (const fact of catalog.facts) expect(contract, fact.id).toContain(`\`${fact.id}\``)

    const decisionRows = sectionRows('Decisions')
    expect(decisionRows.map(cells => cells[0]).sort()).toEqual(catalog.decisions.map(decision => `\`${decision.id}\``).sort())
    // The Status cell leads with a fixed label, so a default can never read as approved.
    const label = { 'approved': 'Approved', 'recommended-default': 'Recommended default', 'recommended-default-unconfirmed': 'Recommended default, **not user-confirmed**' } as const
    for (const decision of catalog.decisions) {
      const cells = decisionRows.find(row => row[0] === `\`${decision.id}\``)!
      expect(cells[1], `${decision.id} value`).toBe(`\`${decision.decision}\``)
      expect(cells[3]?.startsWith(label[decision.status]), `${decision.id} status`).toBe(true)
      if (decision.status !== 'approved') expect(cells[3], `${decision.id} status`).not.toMatch(/^Approved/)
      if (decision.status === 'recommended-default') expect(cells[3], `${decision.id} status`).not.toContain('not user-confirmed')
    }

    const factRows = sectionRows('Facts and owners')
    expect(factRows.map(cells => cells[0]).sort()).toEqual(catalog.facts.map(fact => `\`${fact.id}\``).sort())
    for (const fact of catalog.facts) expect(factRows.find(row => row[0] === `\`${fact.id}\``)?.[1], `${fact.id} owner`).toBe(fact.owner)

    // Fact ids are area.name with a fixed set of areas, so file names such as
    // `events.jsonl` in the prose are not mistaken for fact references.
    const known = new Set(catalog.facts.map(fact => fact.id))
    const referenced = [...contract.matchAll(/`((?:session|prompt|control|stream|history|tool|interaction|content|terminal|process)\.[a-z-]+)`/g)].map(match => match[1]!)
    expect(referenced.filter(id => !known.has(id))).toEqual([])
  })
})
