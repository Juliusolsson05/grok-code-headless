// Condition modules for Grok, built on the shared conditions core (vendored by
// Agent Code's scripts/sync-conditions-core.mjs into ./core, exactly as for
// claude-code-headless, codex-headless and opencode-terminal-headless).
//
// WHY these three kinds and nothing screen-based: a permission, a question or a
// plan approval is answerable only while native's reverse request for it is
// outstanding (interaction.permission, interaction.question, interaction.plan).
// The legacy screen-card detector guessed a permission from painted text; the
// catalog makes the reverse request the owner, so detection is a pure function
// of the pending-request state the projector keeps.
//
// WHY every action writes only an answer shape native was recorded accepting:
// - permission option: `{ outcome: { outcome: 'selected', optionId } }`. The
//   recorder's own control answers were cancels, but the guard forwards the
//   terminal's answer bytes to native unchanged, and the terminal's selected
//   answer was recorded reaching native and running the command (command-error
//   389 then 390; permission-allow-once);
// - permission cancel: `{ outcome: { outcome: 'cancelled' } }` (permission-cancel);
// - question cancel: `{ outcome: 'cancelled' }` (question-cancel);
// - plan approve and abandon: `{ outcome }` (plan-exit-approved, -abandoned).
// Keeping plan mode was recorded only WITH feedback text (plan-exit-cancelled), and
// a condition action carries no user text, so it is not offered here.
// GrokHeadless.resolveConditionAction accepts it when a surface supplies feedback.
//
// WHY the question surface is cancel-only: native renders the option list in
// its terminal, where the user answers. Cancelling from outside is the one
// action that is always safe to offer without re-rendering that list, and it
// matches the reject-only surface Agent Code already gives OpenCode questions.
// Offering answers is an Agent Code condition-surface change, not a protocol gap
// (question-single/-multi/-freeform record accepted answers over control).
//
// WHY module order is permission, question, plan approval: the evaluator's
// snapshot key is JSON over the conditions map in registry order, so the order
// is part of the dedupe contract.

import { defineModule, type ConditionAction } from './core/contract.js'
import type { PendingRequests } from '../live/types.js'

export const PERMISSION_REPLY_ACTION = 'grok.permission.reply'
export const PERMISSION_CANCEL_ACTION = 'grok.permission.cancel'
export const QUESTION_CANCEL_ACTION = 'grok.question.cancel'
export const PLAN_REPLY_ACTION = 'grok.plan.reply'

export type GrokConditionInputs = PendingRequests

export type GrokPermissionConditionState = {
  visible: true
  token: string
  toolCallId: string | null
  title: string
  options: Array<{ optionId: string; name: string; kind: string | null }>
  metadata: Record<string, unknown>
}

export type GrokQuestionConditionState = {
  visible: true
  token: string
  toolCallId: string | null
  text: string
  metadata: Record<string, unknown>
}

export type GrokPlanApprovalConditionState = {
  visible: true
  token: string
  toolCallId: string | null
  planContent: string
  metadata: Record<string, unknown>
}

export const permissionModule = defineModule<'grok.permission', GrokConditionInputs, GrokPermissionConditionState>({
  kind: 'grok.permission',
  detect: inputs => inputs.permission
    ? { visible: true, token: inputs.permission.token, toolCallId: inputs.permission.toolCallId, title: inputs.permission.title, options: inputs.permission.options, metadata: inputs.permission.metadata }
    : null,
  // One action per option native offered, in native's order: the options are
  // the protocol (allow-once, always-allow, reject-once, ... vary by tool; the
  // subagent request offered allow-edits-session instead of always-allow). Then
  // the recorded cancel. Fresh objects per call so a consumer mutating one
  // snapshot cannot leak into the next.
  actions: (state): ConditionAction[] => [
    ...state.options.map((option): ConditionAction => ({
      kind: 'custom', id: `${state.token}:${option.optionId}`, label: option.name, name: PERMISSION_REPLY_ACTION, payload: { token: state.token, optionId: option.optionId },
    })),
    { kind: 'custom', id: `${state.token}:cancel`, label: 'Cancel', name: PERMISSION_CANCEL_ACTION, payload: { token: state.token } },
  ],
})

export const questionModule = defineModule<'grok.question', GrokConditionInputs, GrokQuestionConditionState>({
  kind: 'grok.question',
  detect: inputs => inputs.question
    ? { visible: true, token: inputs.question.token, toolCallId: inputs.question.toolCallId, text: inputs.question.text, metadata: inputs.question.metadata }
    : null,
  actions: (state): ConditionAction[] => [
    { kind: 'custom', id: `${state.token}:cancel`, label: 'Cancel', name: QUESTION_CANCEL_ACTION, payload: { token: state.token } },
  ],
})

export const planApprovalModule = defineModule<'grok.plan-approval', GrokConditionInputs, GrokPlanApprovalConditionState>({
  kind: 'grok.plan-approval',
  detect: inputs => inputs.planApproval
    ? { visible: true, token: inputs.planApproval.token, toolCallId: inputs.planApproval.toolCallId, planContent: inputs.planApproval.planContent, metadata: inputs.planApproval.metadata }
    : null,
  // Approve and abandon, the two outcomes recorded without user text; both leave
  // plan mode (plan-exit-approved, plan-exit-abandoned).
  actions: (state): ConditionAction[] => [
    { kind: 'custom', id: `${state.token}:approved`, label: 'Approve plan', name: PLAN_REPLY_ACTION, payload: { token: state.token, outcome: 'approved' } },
    { kind: 'custom', id: `${state.token}:abandoned`, label: 'Abandon plan', name: PLAN_REPLY_ACTION, payload: { token: state.token, outcome: 'abandoned' } },
  ],
})

export const GROK_MODULES = [permissionModule, questionModule, planApprovalModule] as const
