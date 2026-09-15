// Vocabulary of the control channel, pinned by the Stage 1 controlled-runtime
// corpus (installed Grok 1.0.30, evidence rules r3) and settled by the Stage 2
// catalog (testing/fixtures/controlled-runtime/catalog.json). Fact ids in
// comments name the catalog entry that justifies each shape.

/** Everything the projector consumes, already separated by source. */
export type ControlInput =
  /** A notification on the owned control connection. */
  | { kind: 'notification'; method: string; params?: unknown }
  /** A reverse request on the owned control connection (permission, question, plan approval). */
  | { kind: 'request'; token: string; method: string; params?: unknown }
  /** The owned control connection answered an app prompt. */
  | { kind: 'prompt-result'; promptId: string; result: unknown }
  /**
   * An app prompt request failed.
   * - `native`: native answered with a JSON-RPC error (control.rpc-failure).
   * - `written`: the control client may have written the request. False only when
   *   the client refused before any write (its `uncertain: false`: capacity, a
   *   connection already closed or aborted).
   */
  | { kind: 'prompt-error'; promptId: string; native: boolean; written: boolean; detail?: string }
  /** A request the native terminal itself sent on its own connection (session.terminal-connection). */
  | { kind: 'terminal-request'; id?: string | number; method: string; params?: unknown }
  /** Native's answer to a terminal request, as written toward the terminal. */
  | { kind: 'terminal-answer'; id: string | number; result?: unknown; error?: unknown }
  /** The owned control connection is gone. Nothing more will be answered on it. */
  | { kind: 'control-closed' }

export type StreamPhase = 'requesting' | 'thinking' | 'responding' | 'tool-use' | 'idle'

/** A permission request while its reverse request is outstanding (interaction.permission). */
export type PendingPermission = {
  token: string
  sessionId: string
  toolCallId: string | null
  title: string
  options: Array<{ optionId: string; name: string; kind: string | null }>
  metadata: Record<string, unknown>
}

/** A native question while its reverse request is outstanding (interaction.question). */
export type PendingQuestion = {
  token: string
  sessionId: string
  toolCallId: string | null
  text: string
  metadata: Record<string, unknown>
}

/** A plan approval while `_x.ai/exit_plan_mode` is outstanding (interaction.plan). */
export type PendingPlanApproval = {
  token: string
  sessionId: string
  toolCallId: string | null
  planContent: string
  metadata: Record<string, unknown>
}

/** The oldest outstanding request of each kind: the one the condition surface shows. */
export type PendingRequests = {
  permission: PendingPermission | null
  question: PendingQuestion | null
  planApproval: PendingPlanApproval | null
}

export type LiveOutput =
  /** An app prompt was accepted by native: first queue notification naming its client id (prompt.acceptance). */
  | { kind: 'prompt-accepted'; promptId: string }
  /** An app prompt was written and will not be answered on this connection (prompt.uncertain). */
  | { kind: 'prompt-uncertain'; promptId: string }
  /** An app prompt was never written: the control client refused it first (prompt.write). */
  | { kind: 'prompt-not-sent'; promptId: string; detail?: string }
  /** Native answered an app prompt with a JSON-RPC error before accepting it: a definite refusal (control.rpc-failure). */
  | { kind: 'prompt-refused'; promptId: string }
  /** A prompt started running. `foreign` when the app did not issue its id (prompt.terminal-typed). */
  | { kind: 'turn-start'; turnId: string; foreign: boolean }
  /**
   * A prompt's turn completed, once per id (prompt.completion). Besides native's
   * stop reasons the package uses two of its own: `uncertain` when the connection
   * closed under the turn, `error` when native answered the running prompt with a
   * JSON-RPC error.
   */
  | { kind: 'turn-end'; turnId: string; stopReason: string; foreign: boolean }
  | { kind: 'activity'; active: boolean; status: string | null }
  | { kind: 'phase'; phase: StreamPhase; turnId: string | null; toolName?: string }
  /** Live reply text for the running turn: provisional (stream.live), used only when no durable answer exists. */
  | { kind: 'text'; turnId: string | null; text: string }
  | { kind: 'mode'; modeId: string }
  | ({ kind: 'requests' } & PendingRequests)
  /**
   * Native answered an app prompt with an error where no submission can carry it:
   * the prompt was already accepted, or already running. No recording has a
   * session/prompt error answer, so this is package vocabulary for what native
   * said, surfaced rather than dropped.
   */
  | { kind: 'api-error'; message: string; turnId: string | null }
  /** The native terminal moved to another conversation (session.terminal-connection). Detection only. */
  | { kind: 'session-switched'; from: string; to: string }
  /**
   * Native answered the terminal's load of the assigned session. The attach
   * loads with an empty MCP set and clears the session's servers, so this is the
   * moment the app session must re-seed them (tool.mcp).
   */
  | { kind: 'terminal-loaded'; sessionId: string }
  /**
   * Native answered the terminal's load of the assigned session with an error. An
   * error answer is a definite refusal (session.load-failure). It is unrecorded for
   * the terminal's own load, and after a resume that load is the only one, so it is
   * reported instead of leaving the app waiting to re-seed.
   */
  | { kind: 'terminal-load-refused'; sessionId: string }
