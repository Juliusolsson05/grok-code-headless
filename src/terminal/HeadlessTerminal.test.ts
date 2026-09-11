import type { IPty } from 'node-pty'

import { describe, expect, it } from 'vitest'

import { HeadlessTerminal } from './HeadlessTerminal.js'

function controlledPty() {
  const dataListeners = new Set<(data: string) => void>()
  const resizeCalls: Array<[number, number]> = []
  const pty = {
    write: () => undefined,
    resize: (cols: number, rows: number) => resizeCalls.push([cols, rows]),
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  return {
    pty,
    resizeCalls,
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
  }
}

async function waitForFrame(
  terminal: HeadlessTerminal,
  predicate: (frame: NonNullable<ReturnType<HeadlessTerminal['snapshotStableFrame']>>) => boolean,
) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const frame = terminal.snapshotStableFrame()
    if (frame && predicate(frame)) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('stable terminal frame did not reach the recorded boundary')
}

describe('HeadlessTerminal provider layout epochs', () => {
  it('reports parsed cursor visibility even when hide/show sequences span PTY chunks', async () => {
    const controlled = controlledPty()
    const terminal = new HeadlessTerminal({ pty: controlled.pty, cols: 80, rows: 24 })
    terminal.attach()
    try {
      controlled.emitData('\x1b[?25h')
      expect((await waitForFrame(terminal, frame => frame.generation === 1)).cursor.visible).toBe(true)
      const partialParsed = new Promise<void>(resolve => terminal.on('screen', screen => {
        if (screen.plain.includes('fixture')) resolve()
      }))
      controlled.emitData('fixture\x1b[?25')
      await partialParsed
      expect(terminal.snapshotStableFrame()).toBeNull()
      controlled.emitData('l')
      expect((await waitForFrame(terminal, frame => frame.generation === 3)).cursor.visible).toBe(false)
      controlled.emitData('\x1b[?25h')
      expect((await waitForFrame(terminal, frame => frame.generation === 4)).cursor.visible).toBe(true)
    } finally { terminal.dispose() }
  })

  it('tracks explicit cursor reveals separately from unrelated writes and withholds synchronized batches', async () => {
    const controlled = controlledPty()
    const terminal = new HeadlessTerminal({ pty: controlled.pty, cols: 80, rows: 24, snapshotIntervalMs: 1 })
    terminal.attach()
    try {
      controlled.emitData('\x1b[?25hfirst')
      expect((await waitForFrame(terminal, frame => frame.generation === 1)).cursor.reassertGeneration).toBe(1)
      controlled.emitData(' status')
      expect((await waitForFrame(terminal, frame => frame.generation === 2)).cursor.reassertGeneration).toBe(1)
      const batchParsed = new Promise<void>(resolve => terminal.on('screen', screen => {
        if (screen.plain.includes('batch')) resolve()
      }))
      controlled.emitData('\x1b[?2026h batch')
      await batchParsed
      expect(terminal.snapshotStableFrame()).toBeNull()
      controlled.emitData('\x1b[?25h\x1b[?2026l')
      expect((await waitForFrame(terminal, frame => frame.generation === 4)).cursor.reassertGeneration).toBe(4)
    } finally { terminal.dispose() }
  })

  it('keeps resized xterm geometry unacknowledged until later provider bytes parse', async () => {
    const controlled = controlledPty()
    const terminal = new HeadlessTerminal({
      pty: controlled.pty,
      cols: 52,
      rows: 24,
      snapshotIntervalMs: 1,
    })
    terminal.attach()

    try {
      controlled.emitData('\x1b[2J\x1b[H› recorded narrow draft')
      const narrow = await waitForFrame(
        terminal,
        frame => frame.generation === 1,
      )
      expect(narrow).toMatchObject({
        cols: 52,
        layoutEpoch: 0,
        providerLayoutEpoch: 0,
        layoutStartGeneration: 0,
      })

      terminal.resize(92, 24)
      const beforeRedraw = terminal.snapshotStableFrame()
      // WHY this is the exact Stage 29 interval: xterm changes synchronously,
      // but no PTY bytes have demonstrated that Codex saw SIGWINCH. Returning a
      // complete frame is useful to rendering; the unequal epochs make it
      // unusable as prompt ownership evidence.
      expect(beforeRedraw).toMatchObject({
        generation: 1,
        cols: 92,
        layoutEpoch: 1,
        providerLayoutEpoch: 0,
        layoutStartGeneration: 1,
        cursorPaintGeneration: 1,
      })
      expect(controlled.resizeCalls).toEqual([[92, 24]])

      controlled.emitData('\x1b[2J\x1b[H› recorded wide draft')
      const afterRedraw = await waitForFrame(
        terminal,
        frame => frame.generation === 2,
      )
      expect(afterRedraw).toMatchObject({
        cols: 92,
        layoutEpoch: 1,
        providerLayoutEpoch: 1,
        layoutStartGeneration: 1,
      })
      expect(afterRedraw.rows[0]?.paintGeneration).toBe(2)
      expect(afterRedraw.cursorPaintGeneration).toBeGreaterThan(1)
    } finally {
      terminal.dispose()
    }
  })

  it('attributes a post-resize status chunk only to the row it changes', async () => {
    const controlled = controlledPty()
    const terminal = new HeadlessTerminal({
      pty: controlled.pty,
      cols: 52,
      rows: 5,
      snapshotIntervalMs: 1,
    })
    terminal.attach()

    try {
      controlled.emitData(
        '\x1b[2J\x1b[H› recorded narrow draft' +
        '\x1b[3;1Hstatus old\x1b[1;24H',
      )
      await waitForFrame(terminal, frame => frame.generation === 1)

      terminal.resize(92, 5)
      const resized = terminal.snapshotStableFrame()
      expect(resized).not.toBeNull()
      expect(resized?.rows[0]?.paintGeneration).toBe(1)
      expect(resized?.rows[2]?.paintGeneration).toBe(1)
      expect(resized?.cursorPaintGeneration).toBe(1)

      // WHY a scheduler/status generation is genuine provider output, but it
      // says nothing about whether the composer adopted the new geometry. The
      // generic mirror must preserve that distinction without knowing which
      // row is Codex's composer; consumers perform that semantic mapping.
      controlled.emitData(
        '\x1b[3;1Hstatus new\x1b[K\x1b[1;24H',
      )
      const statusOnly = await waitForFrame(
        terminal,
        frame => frame.generation === 2,
      )
      expect(statusOnly).toMatchObject({
        layoutEpoch: 1,
        providerLayoutEpoch: 1,
        layoutStartGeneration: 1,
        cursorPaintGeneration: 1,
      })
      expect(statusOnly.rows[0]?.paintGeneration).toBe(1)
      expect(statusOnly.rows[2]?.paintGeneration).toBe(2)

      controlled.emitData(
        '\x1b[1;1H› recorded wide draft\x1b[K\x1b[1;22H',
      )
      const composerRedraw = await waitForFrame(
        terminal,
        frame => frame.generation === 3,
      )
      expect(composerRedraw.rows[0]?.paintGeneration).toBe(3)
      expect(composerRedraw.cursorPaintGeneration).toBe(3)
    } finally {
      terminal.dispose()
    }
  })
})
