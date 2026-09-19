import type { GrokAcpClient, GrokAcpServerRequest } from './GrokAcpClient.js'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function params(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined
  return typeof value.method === 'string' && record(value.params) ? value.params : value
}
const shared = new Set(['session/request_permission', '_x.ai/ask_user_question', '_x.ai/exit_plan_mode', '_x.ai/mcp/elicit'])

/** Native leader/server.rs correlates shared modals by tool call. Resolution
 * is live-only and first-answer-wins; a cached app button must lose authority
 * when the TUI answers, even if the peer later reuses the numeric request id. */
export function retireResolvedInteraction(rpc: GrokAcpClient, notification: { method: string; params?: unknown }): void {
  if (notification.method !== '_x.ai/session_notification') return
  const inner = params(notification.params)
  if (!inner || typeof inner.sessionId !== 'string' || !record(inner.update)) return
  const update = inner.update
  const callId = update.tool_call_id ?? update.toolCallId
  if (update.sessionUpdate !== 'interaction_resolved' || typeof callId !== 'string') return
  rpc.retireRequests((request: GrokAcpServerRequest) => {
    if (!shared.has(request.method)) return false
    const value = params(request.params)
    if (!value || value.sessionId !== inner.sessionId) return false
    const tool = value.toolCall ?? value.tool_call
    const requestCall = value.toolCallId ?? value.tool_call_id ?? (record(tool) ? tool.toolCallId ?? tool.tool_call_id ?? tool.id : undefined)
    return requestCall === callId
  })
}
