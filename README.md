# grok-code-headless

Programmatically drive the real Grok Build CLI (`grok`) — structured events,
live token streaming, full transcript access. No SDK shortcuts.

Sister package to
[claude-code-headless](https://github.com/Juliusolsson05/claude-code-headless)
and [codex-headless](https://github.com/Juliusolsson05/codex-headless); the
public surface mirrors theirs where the providers allow.

## How it works

- The full `grok` TUI runs in a PTY (node-pty + xterm-headless screen state):
  same auth, same permission flows, same slash-command surface as a terminal.
- Live semantic streaming comes from a per-session local HTTP relay the CLI is
  pointed at via the `GROK_MODELS_BASE_URL` env var (custom endpoint mode):
  native OAuth passes through untouched, no TLS interception.
- Committed history tails Grok's own session storage:
  `~/.grok/sessions/<percent-encoded resolved cwd>/<session-uuid>/`
  containing `summary.json`, `chat_history.jsonl` (ConversationItem lines:
  `system|user|assistant|tool_result|backend_tool_call|reasoning`),
  `updates.jsonl` (ACP session/update events incl. tool lifecycle), and
  `events.jsonl` (diagnostics).

The upstream source of truth for every shape this package wraps is
[xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0).

## Status

Bootstrap. The real surface lands with the grok provider plan tracked in
[agent-code#832](https://github.com/Juliusolsson05/agent-code/issues/832).

## License

MIT
