# grok-code-headless

Programmatically drive the real Grok Build CLI (`grok`): native PTY sessions,
screen observations and durable transcript/update events. In development.

Sister package to
[claude-code-headless](https://github.com/Juliusolsson05/claude-code-headless)
and [codex-headless](https://github.com/Juliusolsson05/codex-headless); the
public surface mirrors theirs where the providers allow.

## How it works

- The full `grok` TUI runs in a PTY (node-pty + xterm-headless screen state):
  same auth, same permission flows, same slash-command surface as a terminal.
- `GrokResponsesProxy` is a standalone local streaming relay with fixed-origin
  forwarding, bounded SSE observation, cancellation and awaited shutdown.
  It emits per-request text, reasoning and tool-argument events. It does not
  classify a request as the main agent turn. `GrokHeadless.create` owns relay
  startup and shutdown, with a unique relay-local catalog URL so cached
  inference metadata cannot share a plain native catalog's identity.
- Committed history tails Grok's own session storage:
  `~/.grok/sessions/<percent-encoded resolved cwd>/<session-uuid>/`
  containing `summary.json`, `chat_history.jsonl` (ConversationItem lines:
  `system|user|assistant|tool_result|backend_tool_call|reasoning`),
  `updates.jsonl` (ACP session/update events incl. tool lifecycle), and
  `events.jsonl` (diagnostics).

The upstream source of truth for every shape this package wraps is
[xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0).

## Status

The runtime repair branch contains UUID-pinned native sessions, screen mirroring,
committed JSONL observation, replay metadata, explicit errors and asynchronous
shutdown. Deterministic tests cover these boundaries; a separate opted-in live
test checks an exact assistant answer and native completion against Grok 1.0.13.

One-shot command permission handling and owned relay/session integration are
implemented. Additional condition variants, cross-provider host switching and
Agent Code renderer integration remain pending. Progress:
[agent-code#832](https://github.com/Juliusolsson05/agent-code/issues/832).

Automated text delivery now has a separate `GrokNativeControl` API, verified
against Grok 1.0.25 with literal multiline/tab-bearing ACP text, session MCP,
and the real TUI. The legacy `GrokHeadless.sendPrompt()` still uses terminal
paste, which can attach OS clipboard images ([#2](https://github.com/Juliusolsson05/grok-code-headless/issues/2)).
Use the typed control route for automated text. Full app integration remains
gated on native TUI reconnect/session identity containment
([#3](https://github.com/Juliusolsson05/grok-code-headless/issues/3)).

## Owned Native Control

`await GrokNativeControl.start({ cwd, model })` starts a private leader and
verifies protocol/PID ownership through direct native IPC before ACP initialize.
`createSession(uuid, mcpServers)`, `loadSession(uuid, mcpServers)`,
`prompt(uuid, text, { signal })`, and `updateMcpServers(uuid, mcpServers)` provide
typed delivery. MCP updates await observable readiness; successful update RPCs
alone are insufficient. No global leader, auth files or caches are adopted.

Prompts resolve at native turn completion. Abort requests native cancellation
but reports uncertainty until native completion; a new prompt for that session
is refused while the prior turn remains unacknowledged. Disconnected requests
are never replayed. Raw notifications retain native session/replay metadata;
consumers still own session filtering and cannot infer activity from replay.

`dispose()` is awaited and single-flight. If a TUI is attached by the host,
`beforeClose` must acknowledge its process exit; the control RPC is already
closed when this cleanup hook runs. A failed hook retains the owned leader and
directory for an explicit cleanup retry. This ordering handles normal teardown,
not the native TUI's automatic respawn on unexpected leader loss.

The isolated proof is `GROK_ACP_PROBE=1 npx tsx scripts/probe-native-acp.mts`.
Run with `GROK_ACP_PERMISSION_VIA_TUI=1` to also verify a native reject-once key
invalidates the control client's stale permission action. Both use loopback
inference/MCP and an allowlisted environment; no personal data is captured.

## Verification

`npm run check` runs the deterministic suite, typecheck, build and package
entry-point verification. It does not launch Grok or read personal sessions.

`GROK_HEADLESS_LIVE=1 npm run test:live` explicitly opts into a real provider
call using native auth/config. Without that variable the test reports a skip.
The live test creates a random project/session namespace and removes only
that namespace after acknowledged shutdown. It never changes model-cache or
auth settings. `GROK_BINARY` can select the installed executable for this test.

## Streaming and Recording

`await GrokResponsesProxy.create({ upstreamBaseUrl, onEvent, capture })` starts
the loopback listener and returns `info.proxyBaseUrl`; `stop()` cancels and
closes active connections. The upstream is explicit, credentials are forwarded
from the client without being inspected or recorded, and redirects are not
followed. SSE requests ask for identity encoding; if an upstream nevertheless
compresses its response, bytes are preserved and observation reports a
diagnostic instead of silently decoding the wrong stream.

`ResponseCapture` optionally retains bounded raw SSE chunks per flow in memory.
`serialize()` reports completion/truncation, `save(path)` explicitly writes a
new private file, and `replayResponseCapture(serialized, onEvent)` feeds the
recorded bytes through the same response observer. Captures can contain private
provider output and are **not publication-safe fixtures** without minimization
and review. Request headers, credentials and request bodies are not capture
inputs. Agent Code's renderer/IPC corpus remains a separate responsibility.

## Native Session API

`await GrokHeadless.create({ cwd, streaming: { upstreamBaseUrl } })` starts
the relay before the native PTY, exposes per-request `stream-event` observations,
and tears down both through `dispose()`. The upstream must match the caller's
native authentication mode. Native endpoint policy can override environment
defaults; a completed API prompt with zero observed streams is diagnosed rather
than treated as proof that main-turn streaming worked. No auth files or caches
are copied, swept or rewritten by the package.

`commandPermissionState` distinguishes `card`, `none`, `unstable`, `resizing`
and `closed`. `answerCommandPermission(id, 'allow-once' | 'reject-once')` checks
the current native card and its live pending command before sending its observed
digit. It never exposes persistent allow/deny or global always-approve options.
A rejected/stale action requires a fresh user decision, not an automatic retry.
The recorded command-card layout is supported; other layouts fail closed.

The fixture-backed native gates use `GROK_HEADLESS_RELAY_LIVE=1` and
`GROK_HEADLESS_PERMISSION_LIVE=1` with `test:live`. They use isolated homes,
fixture-only keys and loopback replay servers, not paid model inference.
Actual streaming auth can be tested separately with `GROK_HEADLESS_STREAM_LIVE=1`
and an explicit `GROK_HEADLESS_UPSTREAM`.

## History Replacement

`grok-history` carries a session identity and `chat-history` or `updates`
channel. A `reset` precedes the rows of each observed file generation; discard
that channel's previous generation before ingesting its replacement. A
`caught-up` event reports the captured byte boundary, including an empty file.
Its `complete` flag is false for partial/error reads, malformed native rows or
rows rejected by a consumer. It is not a provider-idle or turn-completed signal.

Initial resumed rows and replacement snapshots have `replay: true`; later
appends are live. Replayed update events cannot trigger activity or authorize
command permissions. Permission action IDs are opaque and generation-scoped,
so stale UI actions cannot answer a reissued card after a history reset.

The native full-rewrite contract is atomic replacement. Observed truncation and
equal-size in-place changes are handled defensively; arbitrary in-place rewrites
that grow between polls are not detected as distinct from appends. The tests
use recorded record shapes with controlled filesystem operations, not a claim
to have recorded every native compaction/rewind sequence.

The offline, shape-only corpus in `testing/fixtures/recorded` contains 22
normalized native sessions. The explicit generation script never edits native
sources and never runs as part of ordinary tests. See its README for privacy
transformations and the distinction between structural and inference evidence.

## License

MIT
