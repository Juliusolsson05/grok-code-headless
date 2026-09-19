// The three channel taps, in the siblings' shape (opencode-terminal-headless
// src/channels/channels.ts is the template): semantic for turn-level events the
// app folds into its agent ledger, screen for coarse pane state (activity,
// pending requests, mode), committed for durable transcript rows and history
// boundaries.
//
// WHY bare synchronous fan-out and no buffering: GrokHeadless already orders
// everything before publishing (reconcile/SessionSequencer holds a completion
// until its durable answer), so a channel that buffered or reordered would only
// hide that order. A listener that throws cannot break the publisher or other
// listeners; the error is reported to the host the same way the sequencer
// isolates its sinks.

import type { CommittedEvent, ScreenEvent, SemanticEvent } from './types.js'

export class Channel<T> {
  private readonly listeners = new Set<(event: T) => void>()

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(event: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* one listener's bug must not stop the others */ }
    }
  }
}

export class SemanticChannel extends Channel<SemanticEvent> {}
export class ScreenChannel extends Channel<ScreenEvent> {}
export class CommittedChannel extends Channel<CommittedEvent> {}
