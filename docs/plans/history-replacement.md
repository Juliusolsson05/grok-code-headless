# History Replacement Boundary

Continuation of the approved provider-integration gates in agent-code#832.

A: FileTailer emits generation-tagged records, but an empty replacement emits
nothing. GrokHeadless labels replacement replay as live and has no snapshot
completion boundary. D: consumers receive reset -> ordered records -> caught-up
for each observed history generation, including a replacement with zero rows.
Update replay must not manufacture activity or actionable command permissions.

1. Add tailer reset/caught-up event metadata. Verify independently with the
   normalized recorded transcript and actual filesystem atomic rename, empty
   replacement, interrupted line, corruption and shutdown-drain tests.
2. Expose channel-qualified boundaries through GrokHeadless; label the initial
   resumed snapshot and replacement snapshots as replay, but subsequent appends
   as live. Verify real filesystem + controlled process integration separately.
3. Review this boundary, re-run package checks and native fixture-backed gates.
   App renderer adoption remains a separate stage; do not enable Grok in menus
   before its runtime and renderer registries are implemented together.

Evidence: the 22 normalized recorded sessions supply actual record structure;
upstream jsonl/mod.rs write_jsonl uses atomic rename for full replacement.
Filesystem operation sequences are explicitly controlled fault/contract tests,
not represented as a recording of a native compaction run. Same-inode observed
truncation/equal-size changes are additional defensive coverage. Arbitrary
in-place rewrites that grow between polls are not an evidenced native writer
contract and cannot be inferred from an append stat alone.

Isolation: FileTailer owns physical generation and byte boundaries. GrokHeadless
owns channel/session identity and replay side effects. Neither layer owns app
row merging, turn attribution or renderer state. A caught-up boundary means a
captured byte prefix was consumed, not provider idle or whole-turn completion;
partial/malformed records must make completion explicitly false.

Implementation now exposes FileTailerSnapshotEvent and channel-qualified
GrokHistoryEvent. Review also reproduced short reads certifying unobserved bytes
and a consumed approval identity surviving a generation reset. Regression tests
cover actual-byte advancement, incomplete short-read checkpoints, new action
identity after reset, and rejection of delayed old-generation action tokens.
Consumer row rejection intentionally marks history incomplete: the callback
owns schema acceptance and a lost row cannot authorize a complete snapshot.

Verified on Node 24.14.1: npm run check passes 148 deterministic tests, source
typecheck, build and packed-entry verification. The explicit native fixture
gate passes all three tests: relay origin isolation and one-shot permission
allow/reject. Read-only re-review reports no remaining blockers in this scope.
No paid inference, Agent Code app launch, commit, merge or release was performed
for this stage. Agent Code's integration worktree still has package wiring only;
the next stage must implement session/runtime and renderer consumers rather
than treating this headless event contract as an already integrated feature.
