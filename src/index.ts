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

// --- Headless session core (Task 4) ---
export { GrokHeadless } from './GrokHeadless.js'
export type {
  GrokHeadlessOptions,
  GrokHeadlessCreateOptions,
  GrokHeadlessEvents,
  GrokScreenEvent,
  GrokEntryEvent,
  GrokHistoryEvent,
  GrokUpdateEvent,
  GrokSessionEvent,
  GrokExitEvent,
  GrokActivityEvent,
  GrokIdleEvent,
} from './GrokHeadless.js'
export { HeadlessTerminal } from './terminal/HeadlessTerminal.js'
export type {
  HeadlessTerminalOptions,
  HeadlessTerminalEvents,
  ScreenSnapshot,
  StableTerminalFrame,
  StableTerminalRow,
} from './terminal/HeadlessTerminal.js'
export { FileTailer, RolloutGenerationMismatchError } from './transcript/JsonlTailer.js'
export type { FileTailerOptions, FileTailerEntryMetadata, FileTailerSnapshotEvent } from './transcript/JsonlTailer.js'

// Standalone provider observation/capture; no Agent Code or renderer imports.
export { GrokResponsesProxy } from './proxy/GrokResponsesProxy.js'
export type { GrokResponsesProxyOptions } from './proxy/GrokResponsesProxy.js'
export { GrokResponseObserver } from './proxy/GrokResponseObserver.js'
export type { GrokStreamEvent } from './proxy/GrokResponseObserver.js'
export { ResponseCapture, replayResponseCapture } from './recording/ResponseCapture.js'
export type { GrokCommandPermission, GrokCommandPermissionState, GrokPermissionChoice } from './conditions/commandPermission.js'

// Owned ACP control is a separate lifetime from the legacy paste-driven PTY.
// A host must prove the TUI shares this identity before exposing pane actions.
export { GrokNativeControl } from './control/GrokNativeControl.js'
export type { GrokNativeControlOptions, GrokMcpServer } from './control/GrokNativeControl.js'
export { GrokAcpError } from './control/GrokAcpClient.js'
export type { GrokAcpClientOptions, GrokAcpRequestOptions, GrokAcpServerRequest } from './control/GrokAcpClient.js'
