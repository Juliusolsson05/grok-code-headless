# grok-code-headless

Native Grok Build, read the way Agent Code reads every provider: one-to-one with
claude-code-headless, codex-headless and opencode-terminal-headless. The consumer
owns every process; the package observes and drives them.

## Shape

- `prepareGrokTerminalLaunch` — the values needed before a terminal PTY exists:
  args (`--no-auto-update --fullscreen --leader --leader-socket <guard> --resume
  <session>`), environment, session and guard socket. Starts nothing.
- `GrokNativeControl` — the app-started owned leader: control connection, session
  creation, MCP seeding, prompt RPC. `observe()` exposes its notifications,
  reverse requests and close to GrokHeadless without lifecycle authority.
- `GrokTuiSocketGuard` — the app-started terminal socket guard: the terminal
  connects to it, it verifies the owned leader PID, and `observeTerminalMessages()`
  exposes the terminal's own ACP traffic.
- `GrokHeadless` — attach to the spawned PTY plus both handles. Never spawns,
  kills or disposes a process.

## What GrokHeadless reports

- `submitPrompt` resolves on native ACCEPTANCE (the first queue notification
  naming the client prompt id), not on the write. Outcomes: `not-sent`,
  `refused`, `uncertain` (may have reached native; never resent),
  `unconfirmed` (bounded wait; still never resent).
- `cancelTurn` sends `session/cancel`: it stops the running turn, whoever typed
  it; queued prompts keep their place.
- `semantic` events (`turn_started`, `turn_completed` with `stopReason`,
  `stream_phase`, `api_error`) on the `grok-acp` source.
- `conditions` — `grok.permission`, `grok.question`, `grok.plan-approval` from
  the shared conditions core, answerable through `resolveConditionAction` only
  while native's reverse request is outstanding.
- `terminal-loaded` (re-seed the session MCP set), `terminal-load-refused`,
  `session-switched` (the terminal moved to another conversation; the app fences
  input), `live-state`, `transcript-error`, `entry`/`history` (durable channel).

## Order guarantee

A normally ended turn reaches consumers only after its final committed answer:
`entry` (assistant, appended, no tool calls) precedes `turn_completed` precedes
idle. A completion whose answer has not landed waits a bounded 2 s, then completes
with the live text; the late answer still arrives on the committed channel. This
matches what the corpus recorded (the answer lands after completion in 13 of 52
timelines, 8–418 ms later).

## Evidence

Every rule above is a recorded fact with one owner:
`testing/fixtures/controlled-runtime/catalog.json`, explained by `contract.md`.
The corpus is 52 shape-only timelines recorded from installed Grok under
controlled scenarios; no private capture is committed. `catalog.system.test.ts`
re-derives every citation, ordering and identity, and fails on any observed
signal without exactly one owner.

## Verification

`npm run check` runs the deterministic suite, typecheck, build and package
entry-point verification. It does not launch Grok or read personal sessions.

Set `GROK_HEADLESS_NATIVE_LIVE=1` and run
`npx vitest run --config vitest.live.config.ts src/GrokHeadless.native.live.test.ts`
for the opt-in composition proof against the installed Grok binary (scripted
loopback backend, disposable home, deny-fork containment; no paid inference, no
personal sessions).

## History replacement

`history` events carry `reset` and `caught-up` boundaries per file generation.
Native rewrites `chat_history.jsonl`:
- around terminal attach;
- at the first prompt;
- after compaction and load;
- at rewind;
- at resume.

A rewrite re-delivers rows inside its snapshot with `inRewriteSnapshot: true`;
only appended rows are new content. A boundary is never provider idle or turn
completion. Reconciling durable rows with live output is the consumer's ledger's
job; the package never retires or deduplicates rows.

## License

See `LICENSE.md`.
