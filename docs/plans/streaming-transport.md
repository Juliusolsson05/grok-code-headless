# Grok Streaming Transport

Status: standalone package boundary implemented locally and reviewed through
Agent Code orchestration. Continues agent-code#832; no merge/release authorization.

## Scope and Evidence

Build a local HTTP relay following codex-headless's transport pattern, without
copying its account detection or app-specific recording ownership. Grok's
configured upstream is an explicit constructor input; never obtain credentials
from disk, select an upstream based on request content, or follow redirects.

Retained Grok 1.0.13 captures include title generation, a PAPAYA text response,
and a subsequent dashboard recap. Response IDs distinguish these calls. A text
match or `x-grok-client-identifier` alone does not establish main-turn ownership.
This stage therefore reports per-request streams and never promotes an
unclassified call into the main conversation. Session/turn arbitration remains
a separate gate before Agent Code's renderer consumes the stream.

## Stages

1. **Framing and response observation.** Produce an incremental UTF-8 SSE
   decoder and a per-request response observer. Verify against a minimized
   real PAPAYA capture under arbitrary chunk boundaries, CR/LF delimiters,
   interleaved requests, oversized frames and incomplete termination.
   Separate framing from provider interpretation so unknown SSE does not
   change forwarding and fixture replay does not require sockets or auth.
2. **Relay.** Produce a loopback-only HTTP server with fixed-origin forwarding,
   streaming backpressure, catch-all `/v1/` routes, bounded observation,
   upstream timeouts, abort propagation and awaited shutdown. Verify with real
   local HTTP servers, not a model. Preserve payload bytes, status, path/query
   and end-to-end headers; remove hop-by-hop headers (including Connection
   tokens). Reject absolute request targets and untrusted browser Origins.
   Decompression is observation-only; unsupported/compressed observation
   explicitly degrades rather than changing forwarded bytes.
3. **Package-owned capture/replay.** Produce a bounded in-memory capture with
   explicit truncation state, versioned records and replay through the same
   public observer. Persisting a capture is explicit and private by default;
   it never implies the data is safe to commit. Header/request bodies are not
   capture inputs. Verification checks budgets, per-flow isolation and replay
   parity using actual source fixtures.
4. **Review and publication gate.** Run `npm run check` and the new HTTP
   integration suite. A read-only orchestration child reviews transport safety,
   lifecycle and observation semantics. Correct findings before any gitlink
   bump or app usage.

## Out of Scope for This Boundary

Do not inject the relay into production Grok processes yet: shared model-cache
contamination, OAuth/API-key upstream selection, and main-turn attribution are
unresolved. Do not rewrite or delete user caches, copy auth, add symlinks to
provider homes, migrate Claude/Codex internals, or delete Agent Code's post-IPC
recording corpus. The app still owns batching and rendered-row evidence.

Permission answering, compact/rewind replacement semantics, portable switching
and React rows remain later stages; passing transport tests does not verify them.

## Cache Investigation Follow-up

Upstream `xai-grok-shell/src/agent/models/cache.rs:50-81` validates cache origin
against the expected models-list URL before loading it. This suggests a safer
route than the earlier split-catalog experiment: let each relay serve its own
catalog URL so a plain native session sees a different origin and rejects that
cache. The split experiment deliberately kept the real catalog URL, defeating
this identity fence. Verify the installed CLI and concurrent reload behavior
before adopting this route; do not patch or sweep the user's cache as a shortcut.

## Verification and Review

`npm run check` passed: 82 deterministic tests, TypeScript checking, build and
package entry-point verification. The new HTTP tests use actual loopback client
and upstream sockets, asserting deltas before EOF, exact forwarded bytes,
status/query/header preservation, no redirect-following, auth exclusion from
observation, browser-origin rejection, cancellation, deadline handling, and
continued inference when capture overflows or a consumer callback throws.

`npm run test:live` without opt-in reports one skip, not a fake provider pass.
This stage did not run the relay against the user's production Grok home;
the earlier opted-in PTY-only test is not evidence of relay/TUI integration.

Orchestration reviewer `cd615cf5-43a7-4686-a891-8161bac2e568` reviewed transport
and capture/replay in separate passes. Verified findings were repaired with
regressions: identity encoding, SSE heartbeat noise, duplicate error reporting,
interrupted-capture completion, untrusted truncation metadata, unsafe flow
identifier keys and interrupted-replay callback exceptions. Final re-review
reported no further findings in the changed fixes.

Current exports: `GrokResponsesProxy`, `GrokResponseObserver`, `ResponseCapture`,
`replayResponseCapture` and their public types. The recorder remains Grok-owned;
no Claude/Codex recording code or Agent Code renderer corpus was moved/deleted.
