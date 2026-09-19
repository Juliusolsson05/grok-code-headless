# Controlled Grok Runtime Timelines

One shape-only timeline per registered controlled-runtime scenario, derived on
2026-09-13 with `scripts/derive-controlled-runtime-fixtures.mts` from private
exact captures. The captures were recorded by
`scripts/record-controlled-runtime.mts` against installed Grok 1.0.30 in
disposable homes, driven by a scripted local inference/MCP backend with
controlled fixture prompts, and each timeline comes from the newest capture that
verifies under the evidence rules named in `manifest.json` (`evidenceRules`).
The private captures never enter this repository.

Each line is one observation in capture order: `sequence`, `channel`, `kind`,
normalized `data`, and where the capture held bytes, either decoded and
normalized leader `frames`, a normalized history `row`, or an explicit `omitted`
marker. The manifest records, per scenario, how many captures verified, were
refused by the evidence rules or failed, per native version; how many captures
had unverifiable storage; coverage gaps; and **`limits`, the authoritative list
of every lossy transformation**. Read it before relying on a field.

In short: protocol key names and discriminator values from the recorded
vocabulary (`src/testing/controlled-runtime/recordedVocabulary.ts`) are kept, as
are JSON structure, protocol counters, observer order, array lengths and
empty/null distinctions. Other strings become per-timeline `[text N]`
placeholders; sessions, prompts, connections, requests, tokens, tool calls,
events and process ids become ordinals shared across channels; history byte
offsets become ranks within one file generation; other numbers keep only sign
and integer-ness. chat_history rows use the reviewed transcript normalizer, whose
placeholders and ids are numbered independently of the timeline. Terminal events
keep only numeric geometry and paint generations (including inside checkpoint
frames) and harness checkpoint labels; screen text, row arrays, PTY bytes, native
file snapshot bytes, HTTP bodies, generated media and host paths are omitted with
markers, and wall-clock timing is dropped.

This is **shape and ordering evidence** for one observer. It is not byte, layout,
timing, inference-content or native-causality evidence; those questions go back
to the private captures.

Inspect without writing (prints the manifest only):

```sh
npx tsx scripts/derive-controlled-runtime-fixtures.mts /explicit/private/captures
```

Regenerate into a **new** directory, review it, then replace this one:

```sh
UPDATE_FIXTURES=1 npx tsx scripts/derive-controlled-runtime-fixtures.mts /explicit/private/captures testing/fixtures/controlled-runtime/new-corpus
```

`src/testing/controlled-runtime/derivedCorpus.system.test.ts` is the independent
publication gate. A native version that adds protocol fields shows up as a
nonzero `unknownKeys`; extend the vocabulary deliberately rather than loosening
the gate.
