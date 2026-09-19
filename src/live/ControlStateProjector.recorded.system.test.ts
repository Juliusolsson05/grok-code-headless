import { describe, expect, it } from 'vitest'

import { REPLAY_SESSION_ID, replayableScenarios, replaySteps } from '../testing/replay/corpusReplay.js'
import { ControlStateProjector } from './ControlStateProjector.js'
import type { LiveOutput } from './types.js'

// Every expectation here is read off a committed Stage 1 recording and named by
// its Stage 2 catalog fact (testing/fixtures/controlled-runtime/catalog.json). The
// projector is replayed with exactly the inputs GrokHeadless feeds it: control
// notifications, reverse requests, prompt answers, and the terminal's own
// requests and native's answers to them.

type Output = LiveOutput & { sequence: number }

function project(scenario: string, epoch: 1 | 2 = 1): Output[] {
  const projector = new ControlStateProjector(REPLAY_SESSION_ID)
  const outputs: Output[] = []
  for (const step of replaySteps(scenario, { epoch })) {
    if (step.kind === 'register-prompt') projector.registerPrompt(step.promptId)
    if (step.kind === 'control') for (const output of projector.apply(step.input)) outputs.push({ ...output, sequence: step.sequence })
  }
  return outputs
}

const only = <K extends LiveOutput['kind']>(outputs: Output[], kind: K) => outputs.filter((output): output is Extract<Output, { kind: K }> => output.kind === kind)

describe('ControlStateProjector replaying the recorded Grok corpus', () => {
  it('accepts an app prompt at its first waiting queue entry, before it runs (prompt.acceptance)', () => {
    const outputs = project('client-supplied-prompt-identity')
    expect(only(outputs, 'prompt-accepted')).toEqual([{ kind: 'prompt-accepted', promptId: 'prompt-1', sequence: 276 }])
    expect(only(outputs, 'turn-start')).toEqual([{ kind: 'turn-start', turnId: 'prompt-1', foreign: false, sequence: 277 }])
  })

  it('accepts a queued app prompt under its client id while another runs (prompt.acceptance)', () => {
    const outputs = project('cancel-queued-prompt')
    expect(only(outputs, 'prompt-accepted').map(output => [output.promptId, output.sequence])).toEqual([['prompt-1', 285], ['prompt-2', 330]])
    expect(only(outputs, 'turn-start').map(output => [output.turnId, output.sequence])).toEqual([['prompt-1', 286], ['prompt-2', 342]])
  })

  it('marks turns the app did not issue as foreign and never accepts them (prompt.terminal-typed)', () => {
    // What this proves is limited by the corpus: the terminal-prompt recordings send
    // no client ids, so no recording puts a client-id app prompt and a terminal
    // prompt in one session. It shows foreign marking, not that separation.
    const outputs = project('tui-submit-after-acp')
    expect(only(outputs, 'prompt-accepted')).toEqual([])
    expect(only(outputs, 'turn-start').every(output => output.foreign)).toBe(true)
  })

  it('ends every started turn exactly once in every recording (prompt.completion)', () => {
    for (const scenario of replayableScenarios()) {
      const outputs = project(scenario)
      const started = only(outputs, 'turn-start').map(output => output.turnId)
      const ended = only(outputs, 'turn-end').map(output => output.turnId)
      expect(new Set(started).size, scenario).toBe(started.length)
      expect([...ended].sort(), scenario).toEqual([...started].sort())
    }
  })

  it('keeps activity on while a queued prompt runs, despite sessions/changed idle (session.activity)', () => {
    // concurrent-prompts announces idle at 511 while prompt-2 already runs (509).
    expect(only(project('concurrent-prompts'), 'activity').map(output => [output.active, output.sequence])).toEqual([[true, 289], [false, 701]])
  })

  it('ends activity on a cancelled completion that no queue update precedes (session.activity)', () => {
    const activity = only(project('cancel-inference'), 'activity')
    expect(activity[activity.length - 1]).toMatchObject({ active: false, sequence: 339 })
  })

  it('cancels only the running turn; the queued prompt still ends normally (prompt.cancel)', () => {
    expect(only(project('cancel-queued-prompt'), 'turn-end').map(output => [output.turnId, output.stopReason])).toEqual([['prompt-1', 'cancelled'], ['prompt-2', 'end_turn']])
  })

  it("detects the terminal's /new only from native's answer to its own session/new (session.terminal-connection)", () => {
    for (const scenario of replayableScenarios()) {
      const switched = only(project(scenario), 'session-switched')
      if (scenario === 'tui-new-session') expect(switched, scenario).toEqual([{ kind: 'session-switched', from: 'session-1', to: 'session-2', sequence: 525 }])
      else expect(switched, scenario).toEqual([])
    }
  })

  it("reports native's answer to the terminal's load before the MCP set is re-seeded, and no recorded load is refused (tool.mcp)", () => {
    // The harness re-seeds at 183, after the terminal's empty-set load was answered.
    const loaded = only(project('text-load-repeat'), 'terminal-loaded')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.sequence).toBeLessThan(183)
    for (const scenario of replayableScenarios()) expect(only(project(scenario), 'terminal-load-refused'), scenario).toEqual([])
  })

  it('exposes a permission only while its reverse request is outstanding (interaction.permission)', () => {
    const requests = only(project('permission-dual-client-race'), 'requests')
    expect(requests.map(output => [output.permission?.token ?? null, output.sequence])).toEqual([['token-1', 368], [null, 402]])
    // Native resolved this permission itself: there is nothing to answer.
    expect(only(project('command-success'), 'requests')).toEqual([])
  })

  it('tracks plan approval and mode from control only (interaction.plan)', () => {
    const outputs = project('plan-exit-approved')
    expect(only(outputs, 'mode').map(output => output.modeId)).toEqual(['plan', 'default'])
    expect(only(outputs, 'requests').map(output => output.planApproval?.token ?? null)).toEqual(['token-1', null])
  })

  it('never lets another session on the connection drive this session (session.identity, content.subagent)', () => {
    expect(only(project('native-subagent'), 'turn-start').map(output => output.turnId)).toEqual(['prompt-1'])
    expect(only(project('second-session-control'), 'turn-start')).toEqual([])
  })

  it('produces nothing at all while a load replays (session.load-replay)', () => {
    // Load request 535 through its answer 548: replayed messages, thoughts and turn
    // markers must open no turn and emit no phase, text or activity.
    expect(project('text-load-repeat').filter(output => output.sequence >= 535 && output.sequence <= 548)).toEqual([])
  })

  it('ends an open turn uncertain when the control connection closes under it (prompt.uncertain)', () => {
    expect(only(project('leader-loss-mid-turn'), 'turn-end')).toEqual([{ kind: 'turn-end', turnId: 'prompt-1', stopReason: 'uncertain', foreign: true, sequence: 360 }])
  })

  it("replays the resumed epoch on its own: the terminal's load is answered before the re-seed and the resumed prompt is a fresh turn (process.restart-resume)", () => {
    const firstEpochTurns = new Set(only(project('native-restart-resume'), 'turn-start').map(output => output.turnId))
    const resumed = project('native-restart-resume', 2)
    // Control re-seeds MCP at 674 without loading; only the resumed terminal loads.
    expect(only(resumed, 'terminal-loaded').map(output => output.sequence < 674)).toEqual([true])
    const ends = only(resumed, 'turn-end')
    expect(ends.map(output => output.stopReason)).toEqual(['end_turn'])
    expect(firstEpochTurns.has(ends[0]!.turnId)).toBe(false)
  })
})
