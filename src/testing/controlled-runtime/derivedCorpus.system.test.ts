import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import type { ControlledRuntimeCorpusManifest } from './deriveFixtures.js'
import { advancedScenarios } from './advancedScenarios.js'
import { contentScenarios } from './contentScenarios.js'
import { failureScenarios } from './failureScenarios.js'
import { scenarios } from './scenarios.js'

const directory = new URL('../../../testing/fixtures/controlled-runtime/corpus/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as ControlledRuntimeCorpusManifest

// Deliberately independent from deriveFixtures and recordedVocabulary: a future
// pass-through branch in the deriver must not bless itself by widening the same
// allowlist the publication gate uses. The gate knows only the handful of key
// names its narrow allowances need; everywhere else it proves that nothing
// shaped like private content survived.
//
// Known limit: a bare user or host name with no marker (no dot suffix, digits,
// path or separator) is indistinguishable from a protocol token by shape alone.
// For those the deriver's recorded-vocabulary allowlist is the protection; a
// gate-owned list of every unmasked string would remove that dependency.
const PLACEHOLDER = /^(?:\[text \d+\]|\[binary omitted\]|\[invalid JSON omitted\]|\[encrypted payload omitted\]|\[invalid JSON arguments omitted\]|(?:session|prompt|connection|request|token|tool-call|event|checkpoint|subagent|attempt|agent|agent-instance|trace|id|task)-\d+|https:\/\/fixture\.invalid\/image-\d+\.png)$/
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/:+]{0,63}$/
const NATIVE_PHRASES = new Set([
  'credentials excluded', 'User rejected the execution', 'agent response complete', 'pager eager auth method selected', 'pager quit', 'pager started',
])
// The scripted local backend's own endpoints, recorded under `path` on http
// events. Which endpoint native called is evidence; these exact values are the
// only absolute-looking strings allowed, and only under that key.
const FIXTURE_BACKEND_PATHS = new Set(['/', '/mcp', '/v1/api-key', '/v1/models', '/v1/responses'])
// A slash inside a value is allowed only in these exact protocol shapes: ACP
// method names (`session/prompt`, `_x.ai/queue/changed`) and MIME types.
const SLASHED_VALUE_SHAPES: Record<string, RegExp> = {
  method: /^(?:_x\.ai\/)?[a-z_]+(?:\/[a-z_]+)*$/,
  mimeType: /^[a-z]+\/[a-z0-9.+-]+$/,
  mime_type: /^[a-z]+\/[a-z0-9.+-]+$/,
}
// Magnitudes above 10,000 are allowed only for these recorded quantities:
// JSON-RPC error codes and the model context size. Real process ids and epoch
// times exceed this bound, so a regression that stopped mapping them fails here.
const LARGE_NUMBER_KEYS = new Set(['code', 'rpcCode', 'total'])
// Credential-like key names, including prefixed spellings. The bare `token` key
// is the reverse-request identity the deriver maps to an ordinal; plural usage
// counters such as `inputTokens` end in `s` and do not match.
const CREDENTIAL_KEY = /authorization|cookie|passw(?:or)?d|secret|api[-_]?key|bearer|_token$|[a-z]token$/i
const LOOKS_PRIVATE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // identities
  /\d{4}-\d{2}-\d{2}/, // dates and timestamps
  /\b\d{1,2}:\d{2}:\d{2}\b/, // clock times
  /[0-9a-f]{16,}/i, // hashes, tokens, trace ids
  /^\/./, // absolute paths
  /\d{5,}/, // ports, pids, epoch times
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4 addresses
  /^127\.|localhost/i, // loopback endpoints
  /:\/\//, // URLs and file URIs
  /\.local$/i, // mDNS host names
  /@/, // e-mail addresses and user@host
]

function assertPublishable(value: unknown, key = '', depth = 0): void {
  expect(depth, 'fixture nesting').toBeLessThan(80)
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    const allowed = Number.isSafeInteger(value)
      ? Math.abs(value) <= 10_000 || (LARGE_NUMBER_KEYS.has(key) && Math.abs(value) <= 1_000_000)
      : Math.abs(value) === 1.5
    expect(allowed, `unreviewed fixture number at ${key}`).toBe(true)
    return
  }
  if (Array.isArray(value)) { for (const item of value) assertPublishable(item, key, depth + 1); return }
  if (typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) {
      const shaped = /^[A-Za-z_][A-Za-z0-9_.\-/]{0,63}$/.test(field) && (field === 'token' || !CREDENTIAL_KEY.test(field)) &&
        !LOOKS_PRIVATE.some(pattern => pattern.test(field))
      expect(shaped, `unreviewed fixture key ${field}`).toBe(true)
      assertPublishable(item, field, depth + 1)
    }
    return
  }
  expect(typeof value).toBe('string')
  const text = value as string
  if (text === '' || PLACEHOLDER.test(text) || NATIVE_PHRASES.has(text) || /^grok \d+\.\d+\.\d+ \([0-9a-f]{12}\)$/.test(text)) return
  if (key === 'path' && FIXTURE_BACKEND_PATHS.has(text)) return
  if ((key === 'payload' || key === 'arguments') && text.startsWith('{')) { assertPublishable(JSON.parse(text), '', depth + 1); return }
  if (key === 'url' && text.startsWith('data:')) {
    // The transcript normalizer's intentional non-image carrier.
    expect(Buffer.from(text.split(',')[1] ?? '', 'base64').toString()).toMatch(/^fixture image \d+$/)
    return
  }
  // Transcript text keeps only its native wrappers around placeholders.
  const stripped = text.replace(/\[fixture text \d+\]|fixture-(?:id|tool)-\d+|<\/?(?:user_query|user_info)>/g, '').trim()
  if (stripped === '') return
  const slashShape = Object.hasOwn(SLASHED_VALUE_SHAPES, key) ? SLASHED_VALUE_SHAPES[key] : undefined
  const slashAllowed = !text.includes('/') || Boolean(slashShape?.test(text))
  expect(TOKEN.test(text) && slashAllowed && !LOOKS_PRIVATE.some(pattern => pattern.test(text)), `unreviewed fixture string at ${key}`).toBe(true)
}

const PROSE_PRIVATE = [/[0-9a-f]{8}-[0-9a-f]{4}-/i, /\d{4}-\d{2}-\d{2}/, /:\/\//, /(?:^|\s)\/(?:Users|private|var|tmp|home)\//, /[0-9a-f]{16,}/i, /\b\d{1,3}(?:\.\d{1,3}){3}\b/]
const sortedKeys = (value: object) => Object.keys(value).sort()

function assertManifestPublishable(value: ControlledRuntimeCorpusManifest) {
  // Exact key sets: a new manifest field (for example a capture directory) must
  // be reviewed here before it can be published.
  expect(sortedKeys(value)).toEqual(['coverageGaps', 'evidenceRules', 'limits', 'normalization', 'scenarios', 'schemaVersion', 'unverifiableCaptures'])
  expect(value.normalization).toBe('controlled-runtime-shape-v1')
  for (const count of [value.schemaVersion, value.evidenceRules, value.unverifiableCaptures]) expect(Number.isSafeInteger(count)).toBe(true)
  const token = (text: string) => expect(TOKEN.test(text) && !text.includes('/') && !LOOKS_PRIVATE.some(pattern => pattern.test(text)), `unreviewed manifest token ${text}`).toBe(true)
  for (const scenario of value.scenarios) {
    expect(sortedKeys(scenario)).toEqual(['bytes', 'captures', 'channels', 'events', 'file', 'id', 'nativeVersion', 'sha256', 'targets', 'unknownKeys'])
    for (const text of [scenario.id, scenario.file, scenario.nativeVersion, ...scenario.targets]) token(text)
    expect(scenario.sha256).toMatch(/^[0-9a-f]{64}$/)
    for (const count of [scenario.bytes, scenario.events, scenario.unknownKeys]) expect(Number.isSafeInteger(count)).toBe(true)
    for (const [channel, count] of Object.entries(scenario.channels)) { expect(channel).toMatch(/^[a-z]+:[a-z-]+$/); expect(Number.isSafeInteger(count)).toBe(true) }
    for (const [version, row] of Object.entries(scenario.captures)) {
      expect(version).toMatch(/^(?:\d+\.\d+\.\d+|unknown)$/)
      expect(sortedKeys(row)).toEqual(['failed', 'refused', 'verified'])
      for (const count of Object.values(row)) expect(Number.isSafeInteger(count)).toBe(true)
    }
  }
  for (const gap of value.coverageGaps) {
    expect(sortedKeys(gap).every(key => ['agenda', 'reason', 'scenario'].includes(key)) && typeof gap.reason === 'string').toBe(true)
    if (gap.scenario !== undefined) token(gap.scenario)
  }
  // Prose is written by the deriver, never copied from a capture; it still must
  // not carry anything identifying.
  for (const text of [...value.limits, ...value.coverageGaps.flatMap(gap => [gap.reason, gap.agenda ?? ''])]) {
    expect(PROSE_PRIVATE.some(pattern => pattern.test(text)), text).toBe(false)
  }
}

describe('derived controlled-runtime corpus', () => {
  it('accounts for every registered scenario as a timeline or an explicit coverage gap, with a publishable manifest', () => {
    const registered = [...scenarios, ...contentScenarios, ...advancedScenarios, ...failureScenarios].map(scenario => scenario.id)
    const derived = manifest.scenarios.map(scenario => scenario.id)
    const gaps = manifest.coverageGaps.flatMap(gap => gap.scenario ? [gap.scenario] : [])
    expect([...derived, ...gaps].sort()).toEqual([...registered].sort())
    expect(manifest.coverageGaps.every(gap => gap.reason.length > 0)).toBe(true)
    assertManifestPublishable(manifest)
  })

  it('rejects private-looking values in the independent publication gate', () => {
    const refused: Array<[unknown, RegExp]> = [
      [{ label: '00000000-0000-4000-8000-000000000001' }, /unreviewed fixture string/],
      [{ created_at: '2026-09-12T22:55:16.403259+00:00' }, /unreviewed fixture string/],
      [{ at: '22:55:16.403' }, /unreviewed fixture string/],
      [{ elapsed: 1789264064414 }, /unreviewed fixture number/],
      [{ pid: 71234 }, /unreviewed fixture number/],
      [{ text: 'Controlled prompt before restart.' }, /unreviewed fixture string/],
      [{ path: '/Users/fixture/project' }, /unreviewed fixture string/],
      [{ cwd: '/v1/responses' }, /unreviewed fixture string/],
      [{ method: 'Users/fixture/project' }, /unreviewed fixture string/],
      [{ uri: 'file:///private/tmp/grok-home/fixture.txt' }, /unreviewed fixture string/],
      [{ serverUrl: 'http://127.0.0.1:8080/mcp' }, /unreviewed fixture string/],
      [{ address: '192.168.1.23:8080' }, /unreviewed fixture string/],
      [{ hostname: 'fixture-macbook.local' }, /unreviewed fixture string/],
      [{ label: 'Users/fixture/project' }, /unreviewed fixture string/],
      [{ authorization: '[text 1]' }, /unreviewed fixture key/],
      [{ 'x-xai-api-key': '[text 1]' }, /unreviewed fixture key/],
      [{ session_token: '[text 1]' }, /unreviewed fixture key/],
    ]
    for (const [value, reason] of refused) expect(() => assertPublishable(value), JSON.stringify(value)).toThrow(reason)
    // Legitimate protocol shapes stay publishable.
    expect(() => assertPublishable({ method: '_x.ai/queue/changed', mimeType: 'image/png', token: 'token-1', inputTokens: 0 })).not.toThrow()
  })

  it.each(manifest.scenarios)('$id: exact published bytes, contiguous order, request and offset identity, and nothing private', async scenario => {
    const jsonl = await readFile(new URL(scenario.file, directory), 'utf8')
    expect(Buffer.byteLength(jsonl)).toBe(scenario.bytes)
    expect(createHash('sha256').update(jsonl).digest('hex')).toBe(scenario.sha256)
    expect(scenario.unknownKeys).toBe(0)
    const lines = jsonl.trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(scenario.events)
    expect(lines.map(line => line.sequence)).toEqual(lines.map((_: unknown, index: number) => index + 1))
    // Fidelity, not privacy: each scripted HTTP request keeps a distinct identity,
    // and history row offsets keep their order within one file generation.
    const opened = lines.filter(line => line.channel === 'http' && line.kind === 'request-opened').map(line => line.data.requestId)
    expect(new Set(opened).size).toBe(opened.length)
    const lastOffset = new Map<string, number>()
    for (const line of lines.filter(line => line.channel === 'history' && line.kind === 'row')) {
      const group = JSON.stringify([line.data.sessionId, line.data.file, line.data.generation])
      expect(line.data.lineStartOffset).toBeGreaterThan(lastOffset.get(group) ?? -1)
      lastOffset.set(group, line.data.lineStartOffset)
    }
    for (const line of lines) assertPublishable(line)
  })
})
