// HistoryReader — the durable channel: native's chat_history.jsonl for one
// assigned session, read-only, as decoded entries plus generation boundaries.
//
// It owns byte and generation boundaries only (history.durable): what a row IS
// and how it arrived. It never pairs rows with live updates, retires them or
// deduplicates them; that reconciliation belongs to Agent Code's ledger
// (contract.md, stream.live).
//
// WHY each entry says whether it arrived inside a rewrite snapshot: native
// rewrites the file in place after the terminal spawns, at the first prompt,
// after compaction and load, at rewind and at resume (history.replacement). A
// rewrite delivers its rows as one snapshot; rows appended after it arrive one at
// a time. A snapshot usually re-delivers rows seen before, but not only: the
// generation-1 snapshot of text-load-repeat carries a reminder row generation 0
// never had. So the flag describes arrival, never "already seen" (durable.ts).

import { existsSync } from 'node:fs'

import { decodeGrokConversationItem } from './ConversationItem.js'
import type { GrokDurableEntry, GrokHistoryBoundary } from './durable.js'
import { FileTailer } from './JsonlTailer.js'

export type HistoryReaderOptions = {
  sessionId: string
  /** Absolute path of the session's chat_history.jsonl. */
  file: string
  /** The session existed before this reader: its first generation is a rewrite snapshot of an existing conversation. */
  resume: boolean
  onEntries(entries: GrokDurableEntry[]): void
  onBoundary(boundary: GrokHistoryBoundary): void
  onError(error: Error): void
  /** How often to look for a file native has not created yet. */
  waitPollMs?: number
}

// WHY 100 ms: the same cadence as FileTailer's own poll, so a file created at
// session start is followed with the latency every appended row already has.
const DEFAULT_WAIT_POLL_MS = 100

/**
 * The byte offset up to which a generation's rows arrive inside its rewrite
 * snapshot. Generation 0 of a session this pane created holds only what native
 * wrote while creating it, so none of it is a rewrite; a resumed session's
 * generation 0 is an existing conversation. Exported so the corpus replay applies
 * this exact rule instead of a copy of it.
 */
export function rewriteSnapshotEnd(options: { resume: boolean; generation: number; snapshotByteLength: number }): number {
  return options.resume || options.generation > 0 ? options.snapshotByteLength : 0
}

export class HistoryReader {
  private tailer: FileTailer<unknown> | null = null
  private waitTimer: ReturnType<typeof setInterval> | null = null
  private snapshotEnd = 0
  private stopped = false

  constructor(private readonly options: HistoryReaderOptions) {}

  start(): void {
    if (this.stopped || this.tailer || this.waitTimer) return
    if (existsSync(this.options.file)) { this.open(); return }
    // A fresh session's file appears when native first writes it; until then
    // there is simply nothing durable yet, not an error.
    this.waitTimer = setInterval(() => {
      if (this.stopped || !existsSync(this.options.file)) return
      this.clearWait()
      this.open()
    }, this.options.waitPollMs ?? DEFAULT_WAIT_POLL_MS)
    this.waitTimer.unref?.()
  }

  /** Read whatever is already on disk before the caller stops (the terminal exited). */
  async drain(): Promise<void> {
    // The file may have appeared since the last wait poll, and the terminal's
    // exit is the last chance to read it.
    if (!this.stopped && !this.tailer && this.waitTimer && existsSync(this.options.file)) {
      this.clearWait()
      this.open()
    }
    await this.tailer?.drain()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearWait()
    const tailer = this.tailer
    this.tailer = null
    await tailer?.close()
  }

  private open(): void {
    const { sessionId } = this.options
    this.tailer = new FileTailer<unknown>(this.options.file, (_entry, metadata) => {
      if (this.stopped) return
      const decoded = decodeGrokConversationItem(metadata.rawLine)
      this.options.onEntries([{
        sessionId,
        item: decoded.item,
        raw: decoded.raw,
        generation: metadata.generation,
        lineStartOffset: metadata.lineStartOffset,
        inRewriteSnapshot: metadata.lineStartOffset < this.snapshotEnd,
      }])
    }, error => this.options.onError(error), {
      onSnapshot: event => {
        if (this.stopped) return
        // The tailer's opened descriptor defines this snapshot, not a separate
        // stat racing native's atomic replacement.
        if (event.type === 'reset') this.snapshotEnd = rewriteSnapshotEnd({ resume: this.options.resume, generation: event.generation, snapshotByteLength: event.snapshotByteLength })
        this.options.onBoundary({ ...event, sessionId })
      },
    })
  }

  private clearWait(): void {
    if (this.waitTimer) clearInterval(this.waitTimer)
    this.waitTimer = null
  }
}
