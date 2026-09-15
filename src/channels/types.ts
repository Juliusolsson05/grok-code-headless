// Channel vocabulary, shaped like the sibling headless packages' so Agent Code
// adapters read every provider the same way (opencode-terminal-headless
// src/channels/types.ts is the template).
//
// WHY `source: 'grok-acp'`: every semantic event comes from native's own ACP
// control connection, never from screen text or an HTTP relay. Agent Code's
// Grok semantic fold policy keys on this source the way OpenCode's keys on
// 'opencode-sse'.
//
// WHY turn_completed carries `stopReason` when OpenCode's does not: Stop cancels
// only the running turn, whoever typed it (decision stop-scope, stop-foreign-turn)
// and a cancelled, refused or uncertain turn must not read as a finished answer
// (prompt.cancel, prompt.uncertain). OpenCode exposes the same distinction through
// its error events; native Grok states it on the completion itself.

import type { PendingRequests, StreamPhase } from '../live/types.js'
import type { GrokDurableEntry, GrokHistoryBoundary } from '../transcript/durable.js'

export type SemanticSource = 'grok-acp'

export type SemanticTurnStartedEvent = {
  type: 'turn_started'
  turnId: string
  role: 'assistant'
  source: SemanticSource
  confidence: 'high'
  ts: number
}

export type SemanticTurnCompletedEvent = {
  type: 'turn_completed'
  turnId: string
  fullText: string
  stopReason: string
  source: SemanticSource
  confidence: 'high'
  ts: number
}

export type SemanticStreamPhaseEvent = {
  type: 'stream_phase'
  turnId: string | null
  phase: StreamPhase
  toolName?: string
  source: SemanticSource
  ts: number
}

export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  message: string
  source: SemanticSource
  ts: number
}

export type SemanticEvent =
  | SemanticTurnStartedEvent
  | SemanticTurnCompletedEvent
  | SemanticStreamPhaseEvent
  | SemanticApiErrorEvent

export type GrokActivity = { active: boolean; status: string | null }

export type ScreenActivityEvent = { type: 'activity' } & GrokActivity & { ts: number }
export type ScreenRequestsEvent = { type: 'requests'; state: PendingRequests; ts: number }
export type ScreenModeEvent = { type: 'mode'; modeId: string; ts: number }
export type ScreenEvent = ScreenActivityEvent | ScreenRequestsEvent | ScreenModeEvent

export type CommittedEntryEvent = { type: 'entry'; entry: GrokDurableEntry; file: string; ts: number }
export type CommittedHistoryEvent = { type: 'history'; boundary: GrokHistoryBoundary; file: string; ts: number }
export type CommittedTailErrorEvent = { type: 'tail_error'; code: string; message: string; ts: number }
export type CommittedEvent = CommittedEntryEvent | CommittedHistoryEvent | CommittedTailErrorEvent
