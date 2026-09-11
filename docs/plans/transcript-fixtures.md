# Recorded Transcript Fixtures

Continuation of the approved Grok provider evidence stage (agent-code#832).
The user explicitly requested fixtures from existing local Grok transcripts,
normalized to retain shape without personal prompts or other content.

1. Produce a content-free inventory of native chat-history files. Verify it
   without displaying raw text, filenames, project names, or source IDs.
2. Produce a package-owned, offline normalizer and privacy regression tests.
   Preserve record order, arrays, null/empty distinctions, known protocol
   discriminators, query/bootstrap wrappers, and linked identities. Replace
   all other strings, custom keys, numbers and encrypted payloads. Retain JSON
   argument structure rather than copying command strings. Test both recorded
   evidence and separately labeled adversarial privacy cases.
3. Explicitly generate a new fixture directory, never modifying native files.
   Inventory only normalized values; record hashes of normalized output, not
   hashes or paths of private originals. Refuse malformed/changing sources
   rather than silently dropping lines. Ordinary tests never inspect home.
4. Verify native codec compatibility and archive replay of the recorded corpus;
   obtain a read-only privacy review before treating it as publication-ready.

The normalizer lives in src/testing and is not shipped or imported by runtime
code. The generation script is its consumer. Agent Code and the parser consume
reviewed fixtures, not the private inputs or this export policy. This boundary
must precede app ingestion: otherwise tests could bless imagined native shapes.

Unknowns: which record/synthetic variants the real sessions contain; whether
any files are actively changing or malformed; which unrecognized extension
keys need future semantic interpretation. Unknown values remain anonymized,
not guessed into known protocol variants. Full text, ciphertext validity,
original timings and provider-side cache identity are deliberately not tested.

## Verified Outcome

Generated testing/fixtures/recorded with 22 native sessions. An independent
closed-vocabulary audit and native decode/archive checks pass for every file.
The fixture boundary has 38 deterministic tests. Read-only review found no
private content; numeric-gate, malformed-counter, numeric-identity, own-key and
symlink-census findings were reproduced, fixed and re-reviewed without blockers.
Partial output intentionally remains unusable without its final manifest;
the exporter never deletes arbitrary paths to retry a failed publication.

This is local evidence, not a merged release. The app runtime and renderer
registries are still pending. This corpus does not move or replace the app's
post-IPC/coalescing recordings or any Claude/Codex corpus.
