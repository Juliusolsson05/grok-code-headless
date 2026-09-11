// Review only the isolated capture script's input-only evidence. Publication
// is explicit, exclusive, and refuses paths/UUIDs rather than preserving them
// inside seemingly harmless terminal cells. This is NOT a general redactor
// for personal terminals; manually review the synthetic-input capture first.
import { readFile, writeFile } from 'node:fs/promises'
import type { StableTerminalFrame } from '../src/terminal/HeadlessTerminal.js'

const [input, output] = process.argv.slice(2)
if (!input) throw new Error('Provide an isolated composer capture path')
const capture = JSON.parse(await readFile(input, 'utf8')) as {
  version: string; inferenceRequests: number; frames: Array<{ label: string; frame: StableTerminalFrame }>
}
if (capture.inferenceRequests !== 0) throw new Error('Capture must contain no inference requests')
const labels = new Set(['initial', 'multiline-draft', 'after-control-u', 'after-escape', 'cleared', 'after-transcript-click', 'refocused', 'after-control-p', 'overlay-closed', 'slash-picker', 'slash-cleared', 'stash-draft', 'stashed'])
if (capture.frames.length !== labels.size || new Set(capture.frames.map(entry => entry.label)).size !== labels.size) throw new Error('Capture must contain each expected transition exactly once')
const privateShape = /\/Users\/|\/(?:private\/)?var\/folders\/|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i
for (const entry of capture.frames) {
  if (!labels.has(entry.label)) throw new Error('Unknown capture label')
  // The isolated session header contains its temporary cwd/UUID. Redact that
  // header while retaining row/cell geometry; never scrub a modal/composer to
  // manufacture a positive readiness fixture. All lower rows require review.
  entry.frame = { ...entry.frame, rows: entry.frame.rows.map((row, index) => {
    if (!privateShape.test(row.text + row.cells.join(''))) return row
    if (index > 2) throw new Error('Unreviewed private path/identity outside the session header')
    const text = '[isolated fixture header omitted]'.padEnd(entry.frame.cols)
    return { ...row, text, cells: Array.from(text) }
  }) }
}
console.log(JSON.stringify(capture.frames.map(({ label, frame }) => ({ label, cursor: frame.cursor,
  rows: frame.rows.map((row, index) => ({ index, text: privateShape.test(row.text) ? '[private path/identity row omitted]' : row.text })).filter(row => row.text.trim()),
})), null, 2))
if (output) {
  if (process.env.UPDATE_FIXTURES !== '1') throw new Error('Set UPDATE_FIXTURES=1 to publish reviewed evidence')
  await writeFile(output, JSON.stringify(capture) + '\n', { flag: 'wx', mode: 0o600 })
}
