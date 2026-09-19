// Durable-channel vocabulary: what the history reader hands the sequencer.
//
// WHY `inRewriteSnapshot` travels with every entry: native rewrites
// chat_history.jsonl in place after the terminal spawns, at the first prompt,
// after compaction and load, at rewind and at resume (history.replacement). A
// rewrite delivers its rows as one snapshot; rows appended after it arrive one at
// a time. The sequencer must not take a snapshot row as a turn's new answer.
//
// WHY the flag says how a row ARRIVED, not that it is old: a snapshot usually
// re-delivers rows seen before, but not only — the generation-1 snapshot of
// text-load-repeat carries a reminder row generation 0 never delivered. So the
// name cannot mean "already seen"; the reader sets it from the snapshot byte
// boundary of the entry's generation (transcript/HistoryReader.ts).

import type { GrokConversationItem } from './ConversationItem.js'
import type { FileTailerSnapshotEvent } from './JsonlTailer.js'

export type GrokDurableEntry = {
  sessionId: string
  item: GrokConversationItem
  /** The original line, for exact archive replay. */
  raw: string
  generation: number
  lineStartOffset: number
  /** Arrived inside its generation's rewrite snapshot; never new content. */
  inRewriteSnapshot: boolean
}

/** Generation reset and caught-up byte boundaries. A boundary is never turn completion or idle (history.durable). */
export type GrokHistoryBoundary = FileTailerSnapshotEvent & { sessionId: string }
