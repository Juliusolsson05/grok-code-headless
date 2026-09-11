import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { StableTerminalFrame } from '../terminal/HeadlessTerminal.js'
import { evaluateGrokPromptGate } from './promptGate.js'

const capture = JSON.parse(readFileSync(new URL('../../testing/fixtures/conditions/composer-1.0.25.json', import.meta.url), 'utf8')) as {
  frames: Array<{ label: string; frame: StableTerminalFrame }>
}
function recorded(label: string): StableTerminalFrame {
  const entry = capture.frames.find(entry => entry.label === label)
  if (!entry) throw new Error(`Missing recorded composer state: ${label}`)
  return structuredClone(entry.frame)
}

describe('recorded Grok composer ownership', () => {
  it('retains every independently recorded transition without duplicate or missing labels', () => {
    const expected = ['initial', 'multiline-draft', 'after-control-u', 'cleared', 'after-transcript-click', 'refocused', 'after-control-p', 'overlay-closed', 'slash-picker', 'slash-cleared', 'stash-draft', 'after-escape', 'stashed'].sort()
    for (const name of ['composer-1.0.25.json', 'composer-1.0.25-iterm.json']) {
      const value = JSON.parse(readFileSync(new URL(`../../testing/fixtures/conditions/${name}`, import.meta.url), 'utf8')) as typeof capture
      expect(value.frames.map(entry => entry.label).sort()).toEqual(expected)
      expect(JSON.stringify(value)).not.toMatch(/\/Users\/|\/var\/folders\//)
    }
  })
  it('recognizes the independently captured iTerm keybinding and spaced model-name variant', () => {
    const variant = JSON.parse(readFileSync(new URL('../../testing/fixtures/conditions/composer-1.0.25-iterm.json', import.meta.url), 'utf8')) as typeof capture
    for (const { label, frame } of variant.frames) {
      const ready = ['initial', 'cleared', 'refocused', 'overlay-closed', 'slash-cleared'].includes(label)
      const blocked = ['after-transcript-click', 'after-control-p'].includes(label)
      expect(evaluateGrokPromptGate(frame).kind, label).toBe(ready ? 'ready' : blocked ? 'blocked' : 'occupied')
    }
  })
  it.each(['initial', 'cleared', 'refocused', 'overlay-closed', 'slash-cleared'])('accepts the observed empty focused composer: %s', label => {
    expect(evaluateGrokPromptGate(recorded(label))).toEqual({ kind: 'ready' })
  })

  it.each(['multiline-draft', 'after-control-u', 'stash-draft', 'after-escape', 'slash-picker'])('preserves user-owned input: %s', label => {
    expect(evaluateGrokPromptGate(recorded(label))).toMatchObject({ kind: 'occupied', reason: 'draft' })
  })

  it('does not treat a visibly empty stashed composer as safe for automated input', () => {
    expect(evaluateGrokPromptGate(recorded('stashed'))).toEqual({ kind: 'occupied', reason: 'stashed-draft' })
  })

  it.each(['after-transcript-click', 'after-control-p'])('refuses non-composer keyboard ownership: %s', label => {
    expect(evaluateGrokPromptGate(recorded(label)).kind).toBe('blocked')
  })

  // Faults below mutate real frames and are not labeled native observations.
  it('requires known cursor visibility and coordinates inside the composer', () => {
    const frame = recorded('initial')
    expect(evaluateGrokPromptGate({ ...frame, cursor: { x: frame.cursor.x, y: frame.cursor.y } }).kind).toBe('blocked')
    expect(evaluateGrokPromptGate({ ...frame, cursor: { ...frame.cursor, visible: false } }).kind).toBe('blocked')
    expect(evaluateGrokPromptGate({ ...frame, cursor: { ...frame.cursor, y: 0 } }).kind).toBe('blocked')
  })

  it('does not infer readiness from an unstable or prepaint frame', () => {
    expect(evaluateGrokPromptGate(null)).toMatchObject({ kind: 'warming' })
    expect(evaluateGrokPromptGate({ ...recorded('initial'), generation: 0 })).toMatchObject({ kind: 'warming' })
  })

  it('requires composer repaint after resize, not just any post-resize status bytes', () => {
    const frame = recorded('initial')
    expect(evaluateGrokPromptGate({ ...frame, layoutEpoch: 1 })).toMatchObject({ kind: 'warming', reason: 'resizing' })
    expect(evaluateGrokPromptGate({ ...frame, layoutEpoch: 1, providerLayoutEpoch: 1, layoutStartGeneration: frame.generation })).toMatchObject({ kind: 'warming', reason: 'resizing' })
  })

  it('rejects unknown framing rather than locating a historical prompt arrow', () => {
    const frame = recorded('initial')
    const rows = frame.rows.map(row => ({ ...row, cells: [...row.cells] }))
    rows[frame.rows.length - 4].cells[2] = ' '
    expect(evaluateGrokPromptGate({ ...frame, rows }).kind).toBe('blocked')
  })
})
