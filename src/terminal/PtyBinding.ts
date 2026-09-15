// The thin PTY binding. The caller owns the process (spawn and kill), exactly
// like claude-code-headless, codex-headless and opencode-terminal-headless; the
// package only observes exit and writes input.
//
// WHY there is no headless xterm here: the siblings that mirror the screen do
// so because Claude's and Codex's state lives on it. Grok's does not: turns,
// activity and requests come from the owned control connection, and the durable
// transcript from native's history files (testing/fixtures/controlled-runtime/
// contract.md, "Sources": the screen is never an owner). Agent Code already keeps
// its own raw-byte replay buffer for attaching the visible terminal, so nothing
// here needs the bytes, and the 60 Hz snapshot churn is avoided.
//
// WHY there is no paste helper, unlike OpenCode's PtyBinding.pasteAndSubmit:
// pasting into Grok's terminal can attach clipboard images (package README), and
// programmatic prompts go over control with a client prompt id so acceptance can
// be correlated (prompt.acceptance). Typing in the terminal remains the user's.

export type PtyDisposable = { dispose(): void }

export type PtyExitEvent = { exitCode: number; signal?: number }

/** Structural subset of node-pty's IPty that the package uses. */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable
}

export class PtyBinding {
  private subscription: PtyDisposable | null = null
  private exitEvent: PtyExitEvent | null = null
  private listener: ((event: PtyExitEvent) => void) | null = null
  private delivered = false
  private detached = false

  /**
   * Subscribes to the PTY's exit AT ONCE, not when the owner starts.
   *
   * WHY at construction: the PTY contract offers an exit subscription, not an
   * "already exited" query or a replay. A terminal that dies between the owner's
   * construction and its `start()` (a bad argument, an unreadable session) would
   * otherwise exit unobserved. The exit is latched here and handed to the owner's
   * listener when it subscribes.
   */
  constructor(private readonly pty: PtyLike) {
    const subscription = pty.onExit(event => this.handlePtyExit(event))
    // A PTY may deliver an already-latched exit synchronously from inside
    // `onExit()`, before `subscription` is assigned. The handler has then
    // latched it, and the subscription is released here instead.
    if (this.exitEvent) subscription.dispose()
    else this.subscription = subscription
  }

  /** Route the exit to `listener`: exactly once, synchronously if it already happened, never after `detach()`. */
  onExit(listener: (event: PtyExitEvent) => void): void {
    if (this.detached || this.listener) return
    this.listener = listener
    this.deliver()
  }

  /** Stop observing without killing the process (the caller owns it). Idempotent. */
  detach(): void {
    this.detached = true
    this.listener = null
    this.subscription?.dispose()
    this.subscription = null
  }

  isExited(): boolean {
    return this.exitEvent !== null
  }

  get pid(): number {
    return this.pty.pid
  }

  write(data: string): void {
    if (this.exitEvent) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows)
    } catch {
      // Layout transitions can report 0x0 for a frame; the next measurement
      // corrects it. Losing one resize is better than killing the agent.
    }
  }

  private handlePtyExit(event: PtyExitEvent): void {
    // A PTY reports exit once; a second report (a buggy wrapper, or a test
    // double) must not end the owner twice.
    if (this.exitEvent) return
    this.exitEvent = event
    // Released as soon as the exit is latched: a host that retains exited PTYs
    // would otherwise keep this closure, and through it the owner, alive.
    this.subscription?.dispose()
    this.subscription = null
    this.deliver()
  }

  private deliver(): void {
    if (!this.exitEvent || !this.listener || this.delivered) return
    this.delivered = true
    this.listener(this.exitEvent)
  }
}
