import { describe, expect, it, vi } from 'vitest'

import { NativeHarness } from './NativeHarness.js'

describe('NativeHarness cleanup', () => {
  it('allows cleanup to be retried after a transient failure', async () => {
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error('transient fixture cleanup failure'))
      .mockResolvedValueOnce(undefined)
    const context = Object.assign(Object.create(NativeHarness.prototype), {
      capture: { record: vi.fn() },
      control: { dispose },
      observers: [],
      watched: new Map(),
      openConnections: new Set(),
      backend: { close: vi.fn() },
    }) as NativeHarness

    await expect(context.close()).rejects.toThrow('transient fixture cleanup failure')
    await expect(context.close()).resolves.toBeUndefined()

    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('injects one capture-only dependent cleanup failure without making retries fail', async () => {
    const capture = { record: vi.fn() }
    const context = Object.assign(Object.create(NativeHarness.prototype), {
      capture,
      observers: [],
      watched: new Map(),
      openConnections: new Set(),
      backend: { close: vi.fn() },
    }) as NativeHarness
    const dispose = vi.fn(async () => {
      await (context as any).stopTui()
    })
    Object.assign(context, { control: { dispose } })

    context.failNextDependentCleanupForCapture()
    await expect(context.close()).rejects.toThrow('Controlled capture cleanup failure')
    await expect(context.close()).resolves.toBeUndefined()

    expect(dispose).toHaveBeenCalledTimes(2)
    expect(capture.record).toHaveBeenCalledWith('stimulus', 'dependent-cleanup-failure', { injected: true })
  })
})

describe('NativeHarness restart', () => {
  // The PIDs below are deliberately unallocatable so processAlive() reports the
  // previous epoch absent without signalling anything real. What these tests pin
  // is the harness's refusal rule, not native behavior: the native evidence is
  // re-derived from raw wire frames by EvidenceVerification after recording.
  function restartContext(resumedTui: { loaded: boolean; replayed: boolean }) {
    const capture = { record: vi.fn() }
    const oldControl = { pid: 2_147_483_647, dispose: vi.fn().mockResolvedValue(undefined) }
    const newControl = { pid: 2_147_483_646, updateMcpServers: vi.fn().mockResolvedValue(undefined) }
    const context = Object.assign(Object.create(NativeHarness.prototype), {
      capture,
      control: oldControl,
      guard: {},
      tui: { pid: 2_147_483_645 },
      backend: { baseUrl: 'http://127.0.0.1:1' },
      sessionId: '00000000-0000-4000-8000-000000000001',
      tuiLoaded: false,
      tuiReplayObserved: false,
    }) as NativeHarness
    const startControl = vi.fn().mockResolvedValue(newControl)
    const startTui = vi.fn(async () => {
      Object.assign(context, { tuiLoaded: resumedTui.loaded, tuiReplayObserved: resumedTui.replayed })
      return { pid: 2_147_483_644 }
    })
    Object.assign(context, { startControl, startTui })
    return { context, capture, oldControl, newControl, startControl }
  }

  it('replaces the complete owned native epoch before resuming the same session', async () => {
    const { context, oldControl, newControl, startControl } = restartContext({ loaded: true, replayed: true })

    await expect(context.restartNativeAndResume()).resolves.toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000001',
      loadObserved: true,
      replayObserved: true,
    })

    expect(oldControl.dispose).toHaveBeenCalledOnce()
    expect(startControl).toHaveBeenCalledWith('http://127.0.0.1:1')
    // A guard admits one viewer per lifetime, so the old epoch must be gone
    // before the replacement leader starts, not merely at some point.
    expect(oldControl.dispose.mock.invocationCallOrder[0]).toBeLessThan(startControl.mock.invocationCallOrder[0]!)
    expect(newControl.updateMcpServers).toHaveBeenCalledOnce()
  })

  it('refuses a resume whose native load answered without replaying the conversation', async () => {
    const { context, capture } = restartContext({ loaded: true, replayed: false })

    await expect(context.restartNativeAndResume()).rejects.toThrow(/restart\/resume evidence is incomplete/)
    // The incomplete evidence is still recorded so the failed capture explains
    // itself instead of looking like a harness crash.
    expect(capture.record).toHaveBeenCalledWith('verification', 'native-restart-resume', expect.objectContaining({ replayObserved: false }))
  })
})

describe('NativeHarness TUI wire observation', () => {
  // These feed real length-framed ACP packets through the harness's transport
  // observer instead of stubbing its conclusions. The harness applies a
  // deliberately smaller subset of EvidenceVerification's pairing rules; these
  // pin that subset, so it can only let through captures the verifier may still
  // refuse, never accept a load or replay the verifier would pair differently.
  const SESSION = '00000000-0000-4000-8000-000000000001'
  const acp = (message: unknown) => {
    const body = Buffer.from(JSON.stringify({ type: 'acp', payload: JSON.stringify(message) }))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    return Buffer.concat([header, body])
  }
  const load = { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: SESSION } }
  const replay = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'user_message_chunk' } } }
  const success = { jsonrpc: '2.0', id: 3, result: {} }

  function observer() {
    const context = Object.assign(Object.create(NativeHarness.prototype), {
      capture: { record: vi.fn() },
      openConnections: new Set(),
      decoders: new Map(),
      pendingLoads: new Map(),
      sessionId: SESSION,
      tuiLoaded: false,
      tuiReplayObserved: false,
    })
    let writeId = 0
    const see = (kind: 'received' | 'write-attempt', message: unknown, connectionId = 'tui-2') => (context as any).transport({
      kind, role: 'tui', connectionId, bytes: acp(message), ...(kind === 'write-attempt' ? { writeId: ++writeId } : {}),
    })
    const state = () => ({ loaded: (context as any).tuiLoaded, replayed: (context as any).tuiReplayObserved })
    return { see, state }
  }

  it('observes a load and its replay from decoded frames while the load is pending', () => {
    const { see, state } = observer()
    see('received', load); see('write-attempt', replay); see('write-attempt', success)
    expect(state()).toEqual({ loaded: true, replayed: true })
  })

  it('does not count replay written after the load answer', () => {
    const { see, state } = observer()
    see('received', load); see('write-attempt', success); see('write-attempt', replay)
    expect(state()).toEqual({ loaded: true, replayed: false })
  })

  it('treats a refused load as not loaded even when a later answer reuses its id', () => {
    const { see, state } = observer()
    see('received', load); see('write-attempt', replay)
    see('write-attempt', { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'controlled refusal' } })
    see('write-attempt', success)
    expect(state()).toEqual({ loaded: false, replayed: false })
  })

  it('pairs an answer only on the same connection and with the same id type', () => {
    const { see, state } = observer()
    see('received', load)
    see('write-attempt', success, 'tui-other')
    see('write-attempt', { jsonrpc: '2.0', id: '3', result: {} })
    expect(state()).toEqual({ loaded: false, replayed: false })
  })
})
