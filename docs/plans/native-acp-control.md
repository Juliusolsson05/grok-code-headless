# Native ACP Control

The user approved this architecture on 2026-09-10. App design:
agent-code/docs/decomposition/grok-native-control.md, committed on #844.
Refs Juliusolsson05/agent-code#832. No merge is authorized.

## Why This Replaces Automated Terminal Paste

Grok 1.0.25 can probe and attach desktop clipboard images after bracketed paste.
Isolated HOME/GROK_HOME do not isolate the OS clipboard. A controlled loopback
test sent text but observed altered text and an image. No unexpected payload
was published, and its temporary session was deleted. There is no verified
complete clipboard-read opt-out; backend-selection flags are not privacy gates.
Ordinary multiline key bursts can also be coalesced into paste, and modified
Enter semantics depend on native input mode. Do not patch around these rules
with padding, terminal-brand spoofing or inferred permission to read clipboard.

## Native Proof Performed

Installed binary: Grok 1.0.25 (f7e67d6988e2). Source reference:
xai-org/grok-build 37949780c144e37df692e3d669051a21fec24f20, whose SOURCE_REV
c4ea71cfdbcdb21e32e41bc25a0043d7d4836714 differs from the installed build.
The protocol claims below were verified against the installed binary, not only
inferred from that public source.

`GROK_ACP_PROBE=1 npx tsx scripts/probe-native-acp.mts` owns an isolated native
leader through `GrokNativeControl` and direct length-framed IPC, with the real
TUI attached to the same session. The original stdio-client proof is preserved
in commit eac5b65; production avoids that client's automatic reconnect/replay.
Inference and MCP are loopback fixtures; the default probe sends no TUI input.
`GROK_ACP_PERMISSION_VIA_TUI=1` additionally verifies one observed reject-once
digit and stale control-token rejection. Neither variant pastes, uses real auth
or personal config, or mutates the OS clipboard.

Verified:
- initialize protocol version 1 and client-specified UUID via session/new _meta;
- exact multiline/tab-bearing text at the inference boundary with zero images;
- TUI replay followed by a distinct live reply from a control-client prompt;
- session-scoped MCP registration and direct invocation before/after TUI load;
- native permission card visibility and ACP cancellation preserving the fixture;
- an MCP-free second session cannot invoke the first session's injected server.
- explicit session/load through the production typed API;
- TUI rejection retires the other client's permission token before a stale reply;
- normal shutdown awaits TUI/leader exit and checks no process references the
  private socket path. The absence check never signals a discovered PID.

Important protocol details from the probe:
- Enable live user echo using clientCapabilities._meta["x.ai/userMessageEcho"].
- Extension methods use the wire prefix `_x.ai/`; their successful response
  payload is wrapped in an additional `result` object.
- MCP updates may report success before the server's observable ready status;
  query `_x.ai/mcp/list` and require the expected ready server/tool state.
- Session-only HTTP MCP servers appear in that catalog as local stdio placeholders
  with an empty command and no URL. This was observed on installed 1.0.25 and
  confirmed in native extensions/mcp.rs. Readiness can use their unique names;
  catalog output is not an independent proof of the injected endpoint identity.
- The model advertises `search_tool`, not each individual MCP tool inline.
  Direct MCP invocation is proven; model-driven discovery is a separate test.
- A standard fixture MCP server must reject unsupported `server/discover` with
  JSON-RPC -32601, not return a misleading successful empty gateway response.

## Implementation Stages

1. Preserve this native evidence and source-backed contract.
2. Implement a bounded production RPC client and owned leader lifecycle. A
   disconnected request is uncertain, never automatically replayed. Do not adopt
   replacement leader PIDs from lock files or touch the user's global leader.
3. Keep native TUI and permission interaction, but use typed control for app
   prompts/MCP. Validate reconnect, permission first-answer-wins and cleanup.
4. Integrate AgentSession, provider registration and desktop/phone transcript
   reset/reconciliation; run the full application/native integration matrix.

Stage 2 now has a production owner, bounded RPC/framing, owned-PID admission,
startup cancellation, typed new/load/prompt/MCP update, native turn cancellation,
and shared-interaction retirement. Thirty control tests plus the existing suite
pass (180 total), with typecheck/build/packed-export checks. A cancelled caller
does not release the prompt gate until the native RPC completes. A correlated
native error does release it without claiming prior effects were undone.

## Remaining TUI Lifetime Gate

Tracked in grok-code-headless#3. Independent source audits found no supported
connect-only TUI option: the pager reconnects with connect_or_spawn, can spawn a
replacement immediately after leader death, and can fall back to an embedded
agent after initial connection timeout. This is source-backed; a deliberate
installed-binary crash/respawn experiment has not been run. Normal cleanup is
verified, but is not crash containment.

The owner now requires dependent TUI exit before terminating its leader. Failed
dependent cleanup retains that owned leader and permits explicit cleanup retry;
it never adopts a replacement PID. App integration remains blocked on an agreed,
verified lifetime boundary for unexpected loss and native session changes. A
stable app-owned TUI socket boundary is a possible next design to evaluate, not
an implemented or verified guarantee. Do not enable the app provider from the
normal-path proof alone.

The current terminal-gated submission prototype is not a general text-only
transport and must not enable the app provider. Its recorded frame/ownership
evidence remains useful for native interaction and diagnostics.
