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
// API prefix cache and lose hosted-tool evidence. decode() therefore keeps
// the parsed object verbatim; encode() stringifies it back with key order
// intact, which is byte-stable for serde's compact output.

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
  | 'agent_message'
  | 'unknown'

export interface GrokTextPart {
  type: 'text'
  text: string
}

// Image parts were not present in any captured fixture; the exact inner
// field names are therefore NOT asserted. Passthrough keeps round-trips
// lossless until a real image-bearing session is captured (Task 2 follow-up
// note in the plan). Content is OpenAI-shaped per the sampler source.
export interface GrokImagePart {
  type: 'image'
  [key: string]: unknown
}

export type GrokContentPart = GrokTextPart | GrokImagePart

export interface GrokToolCallFunction {
  name: string
  arguments: string
}

export interface GrokToolCall {
  id: string
  type: 'function'
  function: GrokToolCallFunction
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
  synthetic_reason?: GrokSyntheticReason
  cwd_generation?: number
  prior_turn_interrupt?: string
  prompt_index?: number
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
  id?: string
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
  item: GrokConversationItem
  /** The original line, for byte-stable re-encode and forensic diffs. */
  raw: string
}

export class GrokConversationItemDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokConversationItemDecodeError'
  }
}

export function decodeGrokConversationItem(line: string): DecodedGrokItem {
  const item = JSON.parse(line) as GrokConversationItem
  if (
    typeof item !== 'object' ||
    item === null ||
    !GROK_CONVERSATION_ITEM_TYPES.includes(item.type)
  ) {
    // Fail loud, not lenient: an unknown type tag means upstream changed the
    // schema and every consumer (codec, fold policy, switching) must be
    // re-verified against a fresh capture — silently skipping lines is how
    // transcripts lose turns forever.
    throw new GrokConversationItemDecodeError(
      `unknown ConversationItem type tag: ${String((item as { type?: unknown })?.type)}`,
    )
  }
  return { item, raw: line }
}

export function encodeGrokConversationItem(item: GrokConversationItem): string {
  // JSON.stringify preserves insertion order of parsed keys, and serde's
  // compact output matches stringify's default spacing — so parsed→stringify
  // is byte-stable. Constructed items (projection) simply stringify as-is.
  return JSON.stringify(item)
}

export function isGenuineUserItem(item: GrokConversationItem): item is GrokUserItem {
  // synthetic_reason is THE discriminator between a real user turn and a
  // runtime injection (compaction carrier, system reminder, project
  // instructions). Treating injected items as user turns is the grok
  // equivalent of Claude's isCompactSummary carrier trap.
  return item.type === 'user' && item.synthetic_reason === undefined
}

export function isSyntheticUserItem(item: GrokConversationItem): item is GrokUserItem {
  return item.type === 'user' && item.synthetic_reason !== undefined
}
