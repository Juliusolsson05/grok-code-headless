// ConversationItem — the on-disk codec for grok's chat_history.jsonl.
//
// Source of truth: xai-org/grok-build,
// crates/codegen/xai-grok-sampling-types/src/conversation.rs — serde
// `#[serde(tag = "type", rename_all = "snake_case")]`. Every shape decision
// below was verified against both that Rust source and real session files
// captured in testing/fixtures/ (stage-0 evidence, agent-code#832).
//
// WHY preserve raw bytes: projection (provider switching INTO grok) must be
// able to re-emit items it does not fully interpret (backend_tool_call inner
// shapes, future fields) without corrupting sessions — serde on the grok side
// ignores unknown fields, but DROPPING them would still bust the Responses
// API prefix cache and lose hosted-tool evidence. Decoded records retain
// their original line: JSON.parse/stringify alone loses float spelling and
// large integer precision. Pass the decoded record for exact archive replay;
// pass a newly constructed item when intentionally projecting new content.

export const GROK_CONVERSATION_ITEM_TYPES = [
  'system',
  'user',
  'assistant',
  'tool_result',
  'backend_tool_call',
  'reasoning',
] as const

export type GrokConversationItemType = (typeof GROK_CONVERSATION_ITEM_TYPES)[number]

// SyntheticReason marks runtime-injected user items. `unknown` is deliberate:
// the Rust side deserializes unrecognized tags to Unknown so old clients can
// read newer sessions — we mirror that tolerance instead of throwing on a
// tag added upstream (source comment: "Old clients can then still read
// sessions written by newer versions").
export type GrokSyntheticReason =
  | 'compaction_meta'
  | 'system_reminder'
  | 'length_continue'
  | 'project_instructions'
  | 'auto_continue'
  | 'auto_recovery'
  | 'interjection'
  | 'agent_message'
  | 'parent_agent_message'
  | 'task_completed'
  | 'subagent_completed'
  | 'notification_drain'
  | 'goal_summary'
  | 'goal_classifier_nudge'
  | 'scheduler_fired'
  | 'stop_hook_feedback'
  | 'working_directory_switch'
  | 'unknown'
  | (string & {})

export interface GrokTextPart {
  type: 'text'
  text: string
}

// ContentPart::Image { url } in the upstream serde contract. This is not
// the Responses API input_image shape used later on the network boundary.
export interface GrokImagePart {
  type: 'image'
  url: string
  [key: string]: unknown
}

export type GrokContentPart = GrokTextPart | GrokImagePart

export interface GrokToolCall {
  id: string
  name: string
  arguments: string
  [key: string]: unknown
}

export interface GrokSystemItem {
  type: 'system'
  content: string
  [key: string]: unknown
}

export interface GrokUserItem {
  type: 'user'
  content: GrokContentPart[]
  synthetic_reason?: GrokSyntheticReason | null
  cwd_generation?: number | null
  prior_turn_interrupt?: string | null
  prompt_index?: number | null
  [key: string]: unknown
}

export interface GrokAssistantItem {
  type: 'assistant'
  content: string
  tool_calls?: GrokToolCall[]
  model_id?: string
  model_fingerprint?: string
  reasoning_effort?: string
  [key: string]: unknown
}

export interface GrokToolResultItem {
  type: 'tool_result'
  tool_call_id: string
  content: string
  images?: GrokContentPart[]
  [key: string]: unknown
}

// Server-side (backend agentic sampler) tool call: web_search, x_search,
// code_interpreter. `kind` wraps typed Responses-API items whose inner shape
// varies per tool; we keep it opaque and lossless.
export interface GrokBackendToolCallItem {
  type: 'backend_tool_call'
  kind: { tool_type: string; [key: string]: unknown }
  [key: string]: unknown
}

// Responses-API reasoning item, stored as an ordered SIBLING preceding its
// assistant item (never a field inside it) — the interleaved order is what
// keeps the server-side KV-cache prefix stable (source comment in
// conversation.rs). id/summary are the fields grok itself emits today.
export interface GrokReasoningItem {
  type: 'reasoning'
  id?: string | null
  summary?: Array<{ type: string; text: string }>
  [key: string]: unknown
}

export type GrokConversationItem =
  | GrokSystemItem
  | GrokUserItem
  | GrokAssistantItem
  | GrokToolResultItem
  | GrokBackendToolCallItem
  | GrokReasoningItem

export type DecodedGrokItem = {
  /** Parsed view; edits do not change the captured evidence in raw. */
  readonly item: GrokConversationItem
  /** Immutable capture. To project edits, encode the item, not this wrapper. */
  readonly raw: string
}

export class GrokConversationItemDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokConversationItemDecodeError'
  }
}

export function decodeGrokConversationItem(line: string): DecodedGrokItem {
  let item: unknown
  try {
    item = JSON.parse(line)
  } catch {
    throw new GrokConversationItemDecodeError('Invalid ConversationItem JSON')
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const parts = (value: unknown): boolean => Array.isArray(value) && value.every(part =>
    record(part) && ((part.type === 'text' && typeof part.text === 'string') ||
      (part.type === 'image' && typeof part.url === 'string')))
  const calls = (value: unknown): boolean => Array.isArray(value) && value.every(call =>
    record(call) && typeof call.id === 'string' && typeof call.name === 'string' &&
    typeof call.arguments === 'string')
  const optionalCounter = (value: unknown): boolean =>
    value == null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  let valid = false
  if (record(item)) {
    switch (item.type) {
      case 'system': valid = typeof item.content === 'string'; break
      case 'user':
        valid = parts(item.content) &&
          (item.synthetic_reason == null || typeof item.synthetic_reason === 'string') &&
          (item.prior_turn_interrupt == null || typeof item.prior_turn_interrupt === 'string') &&
          optionalCounter(item.prompt_index) && optionalCounter(item.cwd_generation)
        break
      case 'assistant':
        valid = typeof item.content === 'string' &&
          (item.tool_calls === undefined || calls(item.tool_calls))
        break
      case 'tool_result':
        valid = typeof item.tool_call_id === 'string' && typeof item.content === 'string' &&
          (item.images === undefined || parts(item.images))
        break
      case 'backend_tool_call':
        valid = record(item.kind) && typeof item.kind.tool_type === 'string'
        break
      case 'reasoning':
        valid = (item.id == null || typeof item.id === 'string') &&
          (item.summary === undefined || (Array.isArray(item.summary) &&
          item.summary.every(part => record(part) && typeof part.type === 'string' && typeof part.text === 'string')))
        break
    }
  }
  if (!valid) {
    // Report only a bounded discriminator, never arbitrary prompt/tool data.
    const kind = record(item) && typeof item.type === 'string' ? item.type.slice(0, 80) : 'missing'
    throw new GrokConversationItemDecodeError(`Invalid ConversationItem structure (type=${kind})`)
  }
  return { item: item as GrokConversationItem, raw: line }
}

export function encodeGrokConversationItem(item: GrokConversationItem | DecodedGrokItem): string {
  if (!('type' in item)) return item.raw
  return JSON.stringify(item)
}

export function isGenuineUserItem(item: GrokConversationItem): item is GrokUserItem {
  // This predicate means untagged, NOT proven human intent: recorded
  // user_info preambles are also untagged. Turn classification belongs to
  // the parser's document layer, not to this low-level storage codec.
  return item.type === 'user' && item.synthetic_reason == null
}

export function isSyntheticUserItem(item: GrokConversationItem): item is GrokUserItem {
  return item.type === 'user' && item.synthetic_reason != null
}
