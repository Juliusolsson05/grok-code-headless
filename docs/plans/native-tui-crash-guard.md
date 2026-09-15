# Native TUI Crash Guard

User approved the app-owned socket guard and continuing implementation. Refs #3
and Juliusolsson05/agent-code#832 / #844. Implementation continues in the existing
runtime/app branches; the older package-wiring branch is already an ancestor of
the app integration and is not a second implementation track.

## A → D

A: GrokNativeControl owns a PID-verified leader connection, with installed 1.0.25
normal-path evidence. Direct TUI attachment still exposes native reconnect and
embedded fallback. D: while the host/guard survives, loss of the owned upstream
fences commands and lets the host stop its TUI before the TUI can start another
backend. A crashed host is a separate lifetime problem, not covered by this guard.

## Stage 1 — Framed downstream holding boundary

Produces: `src/control/GrokTuiSocketGuard.ts` and a colocated real-Unix-socket test.
The guard owns a separate private socket directory. One TUI connects through it
to the already-owned native leader; no upstream reconnect is performed. Complete
frames are inspected before forwarding. Shutdown/error/malformed frames or EOF
atomically latch failure, suppress downstream shutdown/EOF, discard subsequent
writes, and notify the lifecycle owner. Downstream sockets are released only by
an explicit disposal callback that acknowledges dependent TUI exit.

Verified by: real peer sockets using the previously native-verified protocol-v1
envelopes, with explicit fragmentation, shutdown, wrong-PID, EOF, capacity and
cleanup-failure injection. Healthy payload bytes are preserved exactly. Startup
registration is withheld until the upstream PID and protocol match; its short
deadline triggers host cleanup before the native registration timeout.

Why separate: a transparent pipe forwards the very EOF/shutdown that triggers
native respawn. That failure cannot be fixed by a later AgentSession condition.
Reality check: native leader/client.rs register and shutdown loops, protocol.rs
four-byte big-endian framing, and the installed ACP proof at 9108a42.

## Stage 2 — Owned TUI lifecycle and native proof

Produces: integration of the guard with the existing native probe and owned
TUI teardown. Guard hold begins synchronously when control/leader failure begins,
before any awaited cleanup. Keep its listener alive if TUI exit is unconfirmed.

Verified by: ordinary ACP/TUI/MCP/permission proof first; then isolated native
failure before registration, after load, idle and during a turn. Fault injection
targets only a retained owned-child identity. Tests must have descendant-level
containment before deliberately exercising a path that might autospawn. Never
adopt or kill replacement PIDs from lock files/process searches.

Why separate: passing protocol tests does not prove native startup or fallback
semantics on an installed binary that differs from the public source revision.
Reality check: installed 1.0.25 versus SOURCE_REV c4ea71cf, source-backed native
registration timeout, initial embedded fallback, and no pong timeout.

## Stage 3 — Pane identity and app adoption

Produces: a single owned runtime binding TUI/control/tailers to the same session,
then Grok AgentSession plus the existing app history and rendering boundaries.
Native new/load changes cannot silently move authority to another conversation.

Verified by: actual native session-changing commands, multiple session isolation,
prompt acceptance versus completion, and desktop/phone reset/replay tests before
enabling the provider. Why separate: transport health is not pane/session identity.
Reality check: current AgentSession, Conversations catalog, MCP choice/reload
policy, and normalized native history corpus.

## Remaining unknowns

- Guard socket/lock behavior in the installed binary; no fake lock-file PID or
  assumed flock. The native source first connects to an existing socket with no
  PID file, but failed initial registration can still enter spawn/fallback.
- Native startup deadline behavior under scheduler stalls and failure during load.
- Native descendant containment for deliberately induced failure tests.
- Native session-changing commands and their exact ACP method/identity effects.

Stage 1 is internal infrastructure. It does not authorize enabling app input or
closing issue #3 before stages 2 and 3 prove the required native lifetime boundary.

## Verified checkpoint

The framed guard now passes real-socket tests for PID admission, byte fidelity,
fragmented shutdown suppression, EOF holding, explicit dependent-exit cleanup,
cleanup retry after socket release, invalid native/JSON envelopes, shared byte
budgets, frame-count limits and unexpected reconnect reporting. Independent
review findings were reproduced and corrected; validation lives separately in
GrokLeaderEnvelope.ts rather than expanding downstream condition handling.

Installed 1.0.25 passes the normal guarded ACP/TUI/MCP/permission proof. Native
fault variants also pass for failed TUI upstream attachment, leader SIGKILL while
idle, and leader SIGKILL during an outstanding inference request. TUI cleanup is
deliberately delayed one second after the guard holds: the TUI stays alive and
the downstream connection count remains exactly one, then its owned exit is
acknowledged before guard release. The lost prompt reports uncertainty.

Fault runs put only the disposable native TUI under macOS Seatbelt's
`deny process-fork`, independently verified first with a child spawn returning
EPERM. This contains replacement descendants even if the implementation fails;
it is not a new restriction on production user sessions. The normal proof passed
both with and without this test-only containment. Process searches assert absence
after cleanup and are never authority to signal a discovered PID.

Commands (Node 24): `GROK_ACP_PROBE=1 GROK_ACP_TUI_GUARD=1 npx tsx
scripts/probe-native-acp.mts`; add `GROK_ACP_TUI_NO_FORK=1` and
`GROK_ACP_GUARD_FAULT=attach`, `idle`, or `mid-turn` for each fault variant.
`GROK_ACP_PERMISSION_VIA_TUI=1` exercises the native reject-once route.

The remaining gate is runtime/pane adoption and native session-changing commands,
including a proven startup deadline policy under host scheduling pressure. No
claim is made that a guard in a dead or indefinitely stalled host can contain the
native process. Issue #3 stays open through that integration work.
