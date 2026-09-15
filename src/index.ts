// grok-code-headless — native Grok Build, read the way Agent Code reads every
// provider.
//
// The package mirrors claude-code-headless, codex-headless and
// opencode-terminal-headless one-to-one: the consumer spawns every process
// (the terminal PTY from `prepareGrokTerminalLaunch`, the owned leader
// `GrokNativeControl`, the terminal socket guard `GrokTuiSocketGuard`), and
// `GrokHeadless` only observes and uses them. The evidence and ownership rules
// behind the surface are testing/fixtures/controlled-runtime/catalog.json and
// contract.md.
export { GROK_HEADLESS_VERSION } from './grokVersion.js'

// --- Transcript codec ---
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

// --- Session discovery ---
export { encodeGrokSessionsDir, getGrokSessionsRoot } from './transcript/SessionDirEncoding.js'
export { parseGrokSummary } from './transcript/SummaryJson.js'
export type { GrokSessionSummary, GrokSummaryInfo } from './transcript/SummaryJson.js'
export {
  listGrokSessions,
  listAllGrokSessions,
  resolveGrokTranscriptPath,
} from './transcript/SessionList.js'
export type { GrokSessionListEntry } from './transcript/SessionList.js'
export { FileTailer, RolloutGenerationMismatchError } from './transcript/JsonlTailer.js'
export type { FileTailerOptions, FileTailerEntryMetadata, FileTailerSnapshotEvent } from './transcript/JsonlTailer.js'
export type { GrokDurableEntry, GrokHistoryBoundary } from './transcript/durable.js'

// --- Root class ---
export { GrokHeadless } from './GrokHeadless.js'
export type {
  ConditionActionResult,
  GrokControlHandle,
  GrokGuardHandle,
  GrokHeadlessEvents,
  GrokHeadlessOptions,
  GrokTerminalError,
  SubmitPromptResult,
} from './GrokHeadless.js'

// --- Launch: prepared values only, nothing started ---
export { prepareGrokTerminalLaunch } from './launch/prepareLaunch.js'
export type { GrokTerminalLaunch, PrepareGrokTerminalLaunchOptions } from './launch/prepareLaunch.js'
export type { PtyDisposable, PtyExitEvent, PtyLike } from './terminal/PtyBinding.js'

// --- App-started helpers: the consumer starts, holds and disposes them ---
export { GrokNativeControl } from './control/GrokNativeControl.js'
export type { GrokControlObserver, GrokMcpServer, GrokNativeControlOptions } from './control/GrokNativeControl.js'
export { GrokTuiSocketGuard } from './control/GrokTuiSocketGuard.js'
export type { GrokTerminalMessage, GrokTuiGuardFault, GrokTuiSocketGuardOptions } from './control/GrokTuiSocketGuard.js'
export { GrokAcpError } from './control/GrokAcpClient.js'
export type { GrokAcpClientOptions, GrokAcpRequestOptions, GrokAcpServerRequest } from './control/GrokAcpClient.js'

// --- Conditions: kinds, action names and state shapes Agent Code renders ---
export { GROK_MODULES, PERMISSION_REPLY_ACTION, PLAN_REPLY_ACTION, QUESTION_CANCEL_ACTION } from './conditions/modules.js'
export type {
  GrokConditionInputs,
  GrokPermissionConditionState,
  GrokPlanApprovalConditionState,
  GrokQuestionConditionState,
} from './conditions/modules.js'
export type { ConditionAction, ConditionCustomAction, ConditionRecord, ConditionSnapshot } from './conditions/core/contract.js'

// --- Channels, in the siblings' shape ---
export { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
export type {
  CommittedEvent,
  GrokActivity,
  ScreenEvent,
  SemanticEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnStartedEvent,
} from './channels/types.js'
export type { PendingPermission, PendingPlanApproval, PendingQuestion, PendingRequests, StreamPhase } from './live/types.js'
