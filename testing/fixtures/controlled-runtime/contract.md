# Grok Runtime Contract

This is Stage 2 of agent-code `docs/decomposition/grok-controlled-runtime.md`:
which source owns each recorded Grok fact, and what the Stage 3 root class must
do with it.

**Evidence.** Every statement rests on `catalog.json` next to this file. Each fact
there cites committed corpus lines, sample counts, variants and contradictions.
The published timelines come from installed Grok 1.0.30 under evidence rules r3;
some scenarios also have verified 1.0.25 captures, counted in the samples.

**Gate.** `src/testing/controlled-runtime/catalog.system.test.ts` fails when:
- a citation does not carry its signal;
- a structured ordering (`follows`, `precedes`) or a named identity (`mentions`)
  does not hold;
- a recorded scenario, or a derived native signal, has no owner or no citation;
- a decision row here states a value or status other than the catalog's;
- a fact row states a different owner, or a row in either table does not parse.

It does not read the meaning of prose. It cannot see content the corpus deriver
replaced with placeholders, or keys `corpusSignals.ts` does not derive. Two
limits there are deliberate:
- values inside frames written toward the terminal, which the runtime never
  takes state from;
- guard-upstream copies other than forwarded terminal answers.

Values from native's durable `updates.jsonl` and `events.jsonl` rows are derived
under their own `durable-` names, so they never hide behind an identical control
value. Orderings and identities therefore live in the catalog's structured
fields (`follows`, `precedes` and field-keyed `mentions`), not in its prose.

When code and this contract disagree, the recordings decide. An observation no
fact covers reopens the catalog. It is not a reason to add a fallback in the
runtime, the app adapter or a renderer.

## Sources

| Source | What it is | What it owns |
| --- | --- | --- |
| control | The owned native leader (`GrokNativeControl`) and its ACP connection, started by the app session | Session identity, prompt write, acceptance, completion, cancel and uncertainty; the live update stream; reverse requests; the session MCP set |
| terminal-connection | The native terminal's own ACP connection through the owned socket guard (`GrokTuiSocketGuard`) | What the terminal itself sends (attach, its own prompts, its replies, conversation changes) and its draft |
| history | Native session files `chat_history.jsonl`, `updates.jsonl` and `events.jsonl`, read by the physical tailer | Durable rows and their generation boundaries |
| process | The leader, guard and terminal PTY lifetimes, owned by the app session | Start, orderly stop, leader loss and restart; never a prompt's outcome |

No source decides a fact another source owns. The screen is never an owner.
Native streams the whole session, and offers every reverse request, to the
terminal as well as to control. After a resume, and for a session the terminal
creates, some of that traffic reaches ONLY the terminal. Traffic written toward
the terminal says nothing about what it shows or which conversation it follows
(`session.terminal-connection`).

## Decisions

| Decision | Value | What it means | Status |
| --- | --- | --- | --- |
| `stop-scope` | `running-turn-only` | Stop cancels the running turn; queued prompts stay queued and run | Recommended default; the user asked for all remaining work to continue without choosing |
| `stop-foreign-turn` | `cancel-running-turn` | Stop also cancels a running turn that was typed in the terminal, because native cancels whatever runs | Recommended default, **not user-confirmed**; must be confirmed before Stage 4 wires Stop |
| `terminal-prompts` | `normal-user-messages` | Prompts typed in the terminal show as normal user messages; the root class still tells them apart internally | Recommended default, adopted like `stop-scope` |
| `terminal-conversation-change` | `fence` | When the terminal moves to another conversation, stop forwarding terminal input and require an explicit session action | Approved ownership rule. The package detects the move; the app session owns the fence, which is new behaviour no sibling has |
| `uncertain-prompts` | `expose-uncertain` | A prompt with an uncertain outcome is reported and never replayed | Approved end state |

The plan asked for the recommended defaults before this catalog was written. That
ordering was waived when the user asked for all remaining work to continue; the
defaults are recorded instead and stand until the user overrides them. Changing a
decision means editing `catalog.json` and this table together, then the Stage 3
tests that encode it.

## Facts and owners

| Fact | Owner | Contract |
| --- | --- | --- |
| `session.identity` | control | The app assigns the session UUID. Traffic for other sessions on the same connection (a second app session, a subagent child: queue, updates, MCP, completions) never drives this one. |
| `session.activity` | control | Working and idle come from the queue plus per-prompt completion. `_x.ai/sessions/changed` idle was recorded four times while a prompt still ran, and queue state can stay stale after a cancel; completion ends activity. |
| `session.load-replay` | control | Replay reaches the client that loads, before its load answer, marked `_meta.isReplay`. Replay never creates acceptance, running or completion. After a resume only the terminal loads and receives the replay, so the transcript comes from durable history. |
| `session.load-failure` | control | A JSON-RPC error answer to `session/load` is a definite refusal. |
| `session.terminal-connection` | terminal-connection | Attach requests for the assigned id are expected. A terminal `session/new` (once answered), or a terminal load or prompt naming another session, is reported as `session-switched`; the package only detects it, and the fence belongs to the app session. Native's answer to the terminal's load of this session is reported as `terminal-loaded`. |
| `prompt.write` | control | A written request is "sent", never "accepted". |
| `prompt.acceptance` | control | Every app prompt carries a fresh client `_meta.promptId`. It is accepted on the first `_x.ai/queue/changed` that names that id, waiting or running. Recorded for one prompt and for a running-plus-queued pair; identical-text concurrent client-id prompts are unrecorded. |
| `prompt.completion` | control | Completion is reported once per promptId, from the first of the result, `prompt_complete` or the extension `turn_completed`. A normally ended turn reaches consumers once it holds its final appended assistant row, which usually arrived before the completion and sometimes after, or at a bounded deadline. Cancelled turns write no final row and complete at once. |
| `prompt.cancel` | control | Stop sends `session/cancel`. The running prompt completes `cancelled`, whoever typed it (`stop-foreign-turn`); queued prompts run (`stop-scope`). Cancel over control is the recorded path; a key interrupt in the terminal is unrecorded. |
| `prompt.terminal-typed` | control | Prompts whose ids the app did not issue are foreign. They are shown (`terminal-prompts`) and never accept or complete an app prompt. |
| `prompt.uncertain` | control | A prompt whose request closed without an answer is uncertain and never replayed (`uncertain-prompts`). Leader loss (`process.leader-loss`) is one cause; the uncertainty is decided where the request is. |
| `control.rpc-failure` | control | Recorded failures are `remote` (native's answer) and `closed` (no answer). The client's other codes are local and unrecorded against native. |
| `stream.live` | control | Live updates for the assigned session are provisional display state. The package never retires or deduplicates rows. Which durable row supersedes which live update is unrecorded, so reconciliation belongs to the app ledger (Stage 5). |
| `history.durable` | history | Committed `chat_history.jsonl` rows are the durable transcript. They are emitted with their generation, byte boundaries and whether they were appended or re-delivered. `updates.jsonl` and `events.jsonl` rows restate tool status, stop reasons, mode, turn outcomes and cancellation categories durably; those are history observations and never decide a control fact. A caught-up boundary is never completion or idle. |
| `history.replacement` | history | A reset starts a superseding generation. Resets were recorded after the terminal spawns and before it connects, at the first prompt, after compaction and load, after rewind, and at resume. Triggers are inferred from arrival order only. |
| `tool.lifecycle` | control | A toolCallId goes from `tool_call` to `in_progress` to `completed` or `failed`. A failing command completes with its error as content; a refused call and an MCP error result fail. |
| `tool.mcp` | control | The app owns the session MCP set. In both recorded launches the terminal's attach clears it (`mcpServers: []`). The app re-seeds once on `terminal-loaded` (native's answer to the terminal's load, bound to it by JSON-RPC id) and again after resume. A removal arriving after the re-seed belongs to the attach. Readiness is observed for the assigned session only, after the re-seed. |
| `interaction.permission` | control | A permission is answerable only while its control reverse request is outstanding. Native offers it to the terminal too, and the first answer wins. The control client refuses a late app answer before writing it; late terminal answers change nothing. A pending interaction without a reverse request is native self-resolution and is not surfaced. |
| `interaction.question` | control | A question exists while its reverse request is outstanding. The terminal may receive it after control has already answered. |
| `interaction.plan` | control | Mode comes from `current_mode_update`. Plan approval exists while `_x.ai/exit_plan_mode` is outstanding. A late terminal answer to a resolved approval changes nothing. |
| `content.todos` | control | Each `plan` update replaces the todo list. |
| `content.subagent` | control | Child sessions are attributed only through `subagent_spawned`'s `child_session_id`, and never count as the main session's prompts. |
| `content.input` | control | Native does not reject unusable images or unavailable resources up front; `image_dropped` and `image_compressed` are notices. |
| `terminal.draft` | terminal-connection | An app prompt never overwrites or submits the terminal draft. |
| `process.lifecycle` | process | The only start order native forces is leader and guard before the terminal. The recorded start order (leader, session over control, terminal launched with `--resume`) is the harness's. The recorded stop order is: close requested, control connection closing, guard hold, terminal signalled, guard upstream closed, control closed, terminal exit, leader exit. |
| `process.leader-loss` | process | On leader loss the guard holds the terminal (`upstream-closed`) and the session is reported lost. What a held terminal would do next is unrecorded, because the harness signals it right after the hold. Only a controlled SIGKILL of the owned leader was recorded. |
| `process.startup-failure` | process | A refused configuration exits the leader and no session exists. Rolling back other started resources is an app design obligation. |
| `process.cleanup-retry` | process | The recorded failure was injected by the harness. The helpers' `dispose` is retryable; there is no new retry API. |
| `process.restart-resume` | process | Resume replaces the epoch. The resumed terminal loads the session; control re-seeds MCP and prompts without loading. |

## Root class shape for Stage 3

Stage 3 builds the package in the shape of `opencode-terminal-headless`,
`claude-code-headless` and `codex-headless`:

- **Consumer-owned PTY.** `GrokHeadless` takes the terminal PTY the app spawned
  and never spawns or kills a process. `OpencodeTerminalHeadless` is the template:
  - explicit `start()`;
  - `stop()` detaches without killing.

  Its options are `pty`, `cwd`, `launch`, the app-owned `control` and `guard`
  handles, and injectable dependencies, the way Claude receives its proxy wiring.
  It only observes and uses the handles; it never disposes them. Today's
  constructor spawn and killing `dispose()` are removed, not wrapped.
- **Prepared launch.** `launch/prepareLaunch.ts` returns the exact terminal binary,
  arguments and environment, pointing at the guard's socket, and starts nothing,
  as `prepareOpencodeTerminalLaunch` does.
- **App-started side processes.** The leader and the guard are helpers the app
  session starts, holds and disposes, as `claudeSession.ts` does with
  `createProxyServer`. Native forces one ordering: the terminal connects to or
  spawns a leader with no connect-only option, so both helpers must exist before
  the terminal is spawned.

  The rest is the recorded harness order:
  1. create a fresh session over control, like Agent Code's in-app pre-creation
     of OpenCode Terminal sessions;
  2. launch the terminal with `--resume <sessionId>`; both fresh and resumed
     recordings used it;
  3. attach `GrokHeadless` right after the PTY spawn, as
     `opencodeTerminalSession.ts` does;
  4. re-seed the MCP set when `GrokHeadless` reports `terminal-loaded`.

  Other orders are unrecorded and not used.
- **Reconcile layer.** `reconcile/` sequences control transitions, terminal
  requests and durable history. Its only consumer is `GrokHeadless`, like
  OpenCode's `SessionSequencer`. It detects and orders; it owns no process, makes
  no app policy, and never pairs or retires rows. Its invariants:
  - acceptance and completion per client promptId;
  - activity from queue plus completion;
  - replay bounded by its load answer;
  - a normally ended turn ordered behind its final appended assistant row (already
    arrived or arriving), with a bounded deadline;
  - terminal conversation changes and terminal loads detected from the terminal's
    own requests and native's answers to them.
- **Channels, conditions, terminal, transcript.** These mirror the siblings.
  - Channels are logic-free.
  - Permission, question and plan approval are condition modules on the shared
    conditions core, answered through one `resolveConditionAction`, driven only by
    outstanding reverse requests (`interaction.permission`).
- **Public surface.** It follows `OpencodeTerminalHeadless`:
  - methods `start`, `stop`, `isExited`, `write`, `resize`, a prompt submission that
    resolves on acceptance, `getProviderSessionId`, `getTranscriptFile`,
    `getActivity`, `getConditionSnapshot` and `resolveConditionAction`;
  - events `activity`, `entry`, `semantic`, `conditions`, `transcript-error`,
    `live-state`, `session-switched` and `exit`.

  Beyond that surface, each Grok addition cites a fact:
  - `history` boundaries (`history.replacement`);
  - `mode` (`interaction.plan`);
  - `terminal-loaded` (`tool.mcp`);
  - `stopReason` on `turn_completed` (`prompt.cancel`, `prompt.uncertain`);
  - a turn cancel over control (`prompt.cancel`).
- **Legacy that is not reused.**
  - Activity inference from `updates.jsonl` alone contradicts `session.activity`.
  - `GrokNativeControl.prompt`'s one-turn-per-session gate contradicts
    `prompt.acceptance`.
  - The relay streaming proxy and the screen permission detector are not needed by
    any fact.

## What Stage 3 must prove

These tests are written first from the recordings, and each must fail against
today's code:

- replaying each cited timeline through the projector and reconcile layer produces
  the stream each fact states, including every variant and contradiction
  resolution;
- events from a previous epoch or connection cannot change the current stream
  (`process.restart-resume`, `session.load-replay`);
- native scenarios re-run through `GrokHeadless` in the app's order produce the
  same observations. The app's order is:
  1. prepare the launch;
  2. start the leader and guard;
  3. create the session (fresh);
  4. spawn the terminal PTY;
  5. attach;
  6. re-seed MCP on `terminal-loaded`.

## Stage 4 adapter preview

The app session mirrors `opencodeTerminalSession.ts`'s `forwardHeadless`:

| Headless event | App event |
| --- | --- |
| `activity` | `process-state` |
| `semantic` | `semantic-event` |
| `entry` | `jsonl-entry` (with the transcript file) |
| `conditions` | `conditions` |
| `session-switched` | `jsonl-error` `provider_session_switched`, plus the fence: input stops being forwarded and input readiness reports not ready |
| `terminal-loaded` | the session's own MCP re-seed (no renderer event) |
| `transcript-error` | `jsonl-error` |
| `live-state` | `transcript-diagnostic` |
| `exit` | `exit` |

`pty.onData` is forwarded as `pty-data`. A failed start rolls back the resources
already started, in the Claude and Codex guarded-spawn shape. Unlike today's
OpenCode Terminal start, that is a design obligation (`process.startup-failure`).

## Open gaps carried forward

These are unrecorded, and the runtime must not guess them:

- a cancel racing the first prompt write;
- identical-text concurrent prompts with client ids;
- a result arriving before `prompt_complete`;
- a turn that writes more than one final assistant row;
- which answer belongs to which turn when two turns overlap, beyond arrival order;
- terminal `/resume`, `/fork` and `/rewind`, and whether the terminal returns to
  the assigned conversation by itself;
- a terminal launched other than with `--resume`, and whether its attach still
  clears the MCP set;
- a control `session/load` in a resumed epoch;
- which durable row supersedes which live update;
- what triggers each history reset;
- what native does with a late answer written by control;
- host process death, host stalls, and startup or binary-version races
  (plan unknown 5);
- real-model MCP discovery and reseeding through resume (plan unknown 7);
- nested or failing subagents;
- drafts across a terminal restart;
- a load of an unreadable stored conversation answered successfully.

Plan unknowns stand as follows:
- **Settled for the recorded cases:** 1 (`prompt.acceptance`) and 2
  (`terminal.draft`).
- **Settled for `/new` only:** 3 (`session.terminal-connection`).
- **Carried forward:**
  - 4: cross-channel ordering beyond the structured orderings in the catalog;
  - 6: attribution of semantic streams to the main turn beyond `content.subagent`;
  - 8: missing condition variants and any provider-neutral ledger extension, to be
    decided in Stage 5 from app recordings.

A capability that depends on an open gap stays explicitly unsupported until a
recording exists.

## Reopening

- A new value of a derived signal fails `catalog.system.test.ts`. Record the case,
  add or amend a fact with citations, then update this document.
- A recording that contradicts a fact's owner goes back to the user as an ownership
  decision (the plan's stop rule) before any code changes.
