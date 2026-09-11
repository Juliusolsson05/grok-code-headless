# Composer Research Checkpoint

This branch preserves the 2026-09-10 native composer investigation. It is NOT
the production input route and is not ready to merge. The approved replacement
is the native ACP control design in docs/plans/native-acp-control.md.

The recorded 1.0.25 generic/iTerm fixtures contain synthetic unsent drafts and
native UI only, with session headers redacted. Observed: Ctrl+U leaves earlier
multiline content; double Escape stashes rather than destroys a draft; modal
and unfocused states retain an underlying composer; terminal-dependent hints
and model labels vary. The framing/cursor/parser-state tests are useful evidence.

The prototype gated paste path passed deterministic checks and initially passed
native tests. A later native run observed clipboard-derived image attachment
and changed text despite the caller supplying text only. Consequently it must
not be treated as an opaque text transport or used to enable Agent Code's Grok
provider. HOME isolation is not OS clipboard isolation. Capture scripts now
require an explicit controlled-desktop assertion, which itself is not a sandbox.

Keep the native frame/ownership findings available for review, but do not carry
the prototype paste-submission API into the production bridge. Typed ACP was
subsequently verified against the installed binary for multiline/tab text,
native TUI replay/live rendering, session MCP and permission cancellation.

This checkpoint had 180 deterministic tests passing before the final metadata
test additions; native paste verification is explicitly blocked by the above
clipboard behavior. No general text-only delivery guarantee is claimed here.
