# Grok Runtime Contract Repair

Status: implementation in progress on `fix/grok-runtime-contracts`.
Refs: Juliusolsson05/agent-code#832. Reviewers are read-only; the parent
implements inline. No merge or release is authorized by this record.

## Scope

Repair the unfinished runtime before any Agent Code consumer imports it.
Previously published codec/discovery code also has reviewed correctness bugs:
flat tool-call fields, RFC3986 directory encoding, JSON numeric preservation,
and tests silently passing without exercising their live-provider dependency.

## Verification Order

1. Add regression assertions against the retained Grok transcript/update
   captures and explicitly labeled fault injection. Observe failures first.
2. Correct flat serde tool calls and raw-line re-emission; reject invalid
   required shapes through the public typed decode error.
3. Fix process ownership using native `--session-id`, not directory sorting.
   Attach the real terminal mirror and test update delivery at the actual
   `event.params.update` boundary. Do not increase timeouts to mask failures.
4. Close file observers and missing-file timers on both natural and requested
   exit. Await asynchronous PTY exit before disposal resolves; reject writes
   after closure. Do not infer provider idle from quiet terminal paint.
5. Keep deterministic tests credential-free: controlled process boundary with
   real xterm/filesystem tailers. Put native provider tests in `*.live.test.ts`
   with explicit opt-in, monotonic deadline and cleanup of only owned paths.
6. Run `npm run check`; separately run the opted-in live gate when authorized.
7. Obtain orchestrated review, address verified findings and reverify. Do not
   publish or bump Agent Code's gitlink until the repaired boundary is reviewed.

## Current Evidence

`npm run check` passed with 42 deterministic tests, TypeScript checking,
build and packed-entry verification. `GROK_HEADLESS_LIVE=1 npm run test:live`
passed once against installed Grok 1.0.13: exact requested assistant output,
native completion envelope, UUID-pinned creation, and shutdown acknowledgement.
This does not verify permission answering, semantic streaming, compaction
replacement, provider switching, React rows or the complete Agent Code feature.

## Review Follow-up

The first orchestrated review of this repair confirmed the initial fixes and
found three additional boundary failures. Regression tests reproduced each:
exit dropped final writes; malformed update envelopes escaped validation;
and resumed history manufactured live activity. The runtime now drains its
tailers before exit notification, validates envelopes before emission, and
tags replay observations without changing activity. Generation/byte offsets
are exposed, but empty rewrite/caught-up semantics still need their own gate.

The image field is source-backed, not a guessed Responses API alias:
`xai-org/grok-build` commit `72a61251fcffb464bcc687aeb5a998e5a98ec0c9`,
`crates/codegen/xai-grok-sampling-types/src/conversation.rs:373-377` declares
`ContentPart::Image { url }`. This source snapshot is not claimed to be the
exact installed binary revision; image-bearing live capture remains pending.
Raw decoded records are archive evidence; callers projecting changes pass
the parsed item explicitly rather than expecting mutations to rewrite raw.

The second review confirmed those repairs and raised three low-severity
shutdown hardening points. Consumer diagnostic/exit listener exceptions no
longer prevent lifecycle completion. A new failing-then-green regression
proves that dispose retains missing-file callbacks until a delayed shutdown
flush creates the transcript. The final deterministic and opted-in live
gates were rerun after those changes and passed. This evidence is local;
no claim is made that a new remote CI run or app integration has passed.

## Corpus Boundary

The proposed cross-provider migration lives in Agent Code's
`docs/decomposition/grok-corpus-ownership.md`. Package-owned provider capture
must not replace the app's post-IPC/coalescing and renderer-ownership corpus.
Do not move Claude/Codex files or delete existing app fixtures before the
owner catalog and cutover tests are reviewed and the decomposition approved.
