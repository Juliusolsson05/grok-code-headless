// grok-code-headless — programmatic control of Grok Build via headless terminal.
//
// Mirrors claude-code-headless / codex-headless API surface where possible.
// Provider-specific halves (screen parser, session storage under
// ~/.grok/sessions/<encoded resolved cwd>, updates.jsonl/tool lifecycle,
// cli-chat-proxy relay) land with Tasks 2-6 of the grok provider plan.
export { GROK_HEADLESS_VERSION } from './grokVersion.js'

// --- Transcript codec (Task 2) ---
export {
  GROK_CONVERSATION_ITEM_TYPES,
  GrokConversationItemDecodeError,
  decodeGrokConversationItem,
  encodeGrokConversationItem,
  isGenuineUserItem,
  isSyntheticUserItem,
} from './transcript/ConversationItem.js'
export type {
  GrokConversationItem,
  GrokConversationItemType,
  GrokSyntheticReason,
  GrokContentPart,
  GrokTextPart,
  GrokImagePart,
  GrokToolCall,
  GrokSystemItem,
  GrokUserItem,
  GrokAssistantItem,
  GrokToolResultItem,
  GrokBackendToolCallItem,
  GrokReasoningItem,
  DecodedGrokItem,
} from './transcript/ConversationItem.js'
export {
  readGrokChatHistory,
  appendGrokChatHistory,
  writeGrokChatHistory,
} from './transcript/GrokJsonl.js'

// --- Session discovery (Task 3) ---
export { encodeGrokSessionsDir, getGrokSessionsRoot } from './transcript/SessionDirEncoding.js'
export { parseGrokSummary } from './transcript/SummaryJson.js'
export type { GrokSessionSummary, GrokSummaryInfo } from './transcript/SummaryJson.js'
export {
  listGrokSessions,
  listAllGrokSessions,
  resolveGrokTranscriptPath,
} from './transcript/SessionList.js'
export type { GrokSessionListEntry } from './transcript/SessionList.js'
