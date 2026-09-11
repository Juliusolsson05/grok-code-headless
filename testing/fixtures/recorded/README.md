# Recorded Grok Transcript Shapes

These 22 native session transcripts were explicitly exported on 2026-09-08
from local Grok storage with `scripts/normalize-transcript-fixtures.mts`.
They include project sessions and earlier native CLI probes. The manifest
identifies normalized output only; it contains no original paths, IDs, hashes,
timestamps, account details or project names. Installed CLI evidence elsewhere
in this repository is Grok 1.0.13; that does not prove every source session was
written by that exact build.

All free text (including prompts, responses, system/skill inventories, tool
arguments/results and reasoning) is replaced. Unknown object keys and tool
names are mapped to placeholders. Numbers are normalized; prompt/generation
counters retain equality and relative ordering. IDs retain within-session
relationships. Known record/synthetic discriminators, array order/length,
empty/null distinctions and native user_info/user_query wrappers remain.
JSON-encoded arguments retain their structure without runnable command text.
Ciphertext is replaced with an explicit omission marker, not retained.

This is **shape evidence**, not valid encrypted-state resume, inference,
timing, image-decode, or original JSON numeric-lexeme evidence. Hosted-tool
extension field names are anonymized unless explicitly reviewed as protocol
vocabulary. No terminal/update stream or compaction file-write sequence is
claimed by these static chat-history snapshots. Several probe sessions have
identical normalized shapes; they remain separate observations in the census.

Inspect without writing:

```sh
npx tsx scripts/normalize-transcript-fixtures.mts /explicit/native/sessions
```

Generate into a **new** directory (never an existing fixture or native directory):

```sh
UPDATE_FIXTURES=1 npx tsx scripts/normalize-transcript-fixtures.mts /explicit/native/sessions testing/fixtures/new-corpus
```

Review normalized output before publication. Ordinary tests use only repository
fixtures, never a personal home, credentials, network or the native CLI.
