# Controlled Runtime Recording — Stage 1

Approved parent decomposition: Agent Code
`docs/decomposition/grok-controlled-runtime.md` (approval 4ea8e330).
The user expanded the capture agenda to Claude's recorded shapes and their Grok
equivalents, explicitly including tools, MCP and images. Refs agent-code#832.
This stage records evidence; it does not implement the combined runtime.

## Produces

- Capture-only helpers in `src/testing/controlled-runtime/` and explicit runner
  `scripts/record-controlled-runtime.mts`.
- Private exact event journals and byte blobs, with a manifest published last.
- A checked-in source-linked Claude/Grok coverage checklist. Every row is
  recorded, source-backed-but-unrecorded, unsupported-with-evidence, or unknown.
- Privacy-reviewed derived fixtures only after the private originals are checked.

## Capture boundary

Capture raw control IPC receive/send-attempt bytes before JSON conversion, native
TUI/guard bytes, caller actions and their actual results, terminal bytes/frames,
process lifecycle observations, FileTailer rows/snapshot boundaries, and final
native file bytes. Distinguish send attempts from write callbacks and acceptance.
Use one local monotonic sequence plus relative observer timing; these report
observation order, not an invented global provider execution order.

Opt-in byte observers live at the existing transport seams. They copy bytes,
cannot mutate forwarded buffers, and callback failures cannot change provider
execution. Production imports no capture helper. The recorder alone owns private
disk writes, bounded storage, loss marking and manifest integrity.

## Verified by

1. Test the observer against real peer sockets: exact captured bytes, preserved
   ordering, and unchanged transport when observers mutate their copy or throw.
   These are instrumentation tests, not Grok-behavior fixtures.
2. Test private exclusive capture creation, write/size failures, checksums and
   detection of incomplete/corrupt journals using actual filesystem operations.
3. Run the real installed Grok in disposable home/cwd with local inference/MCP.
   Label generated backend replies as controlled stimuli. Retain actual native
   outputs without cleaning their ordering or pretending stimuli are recordings.
4. Independently reconstruct IPC frames and compare recorded final history with
   the native files from that run. Report event/variant frequencies in this
   sample, not population frequency or full semantic support.

## Why separate

Metadata verdicts cannot reproduce the races the future coordinator must handle.
Building more runtime modes first would make the recorder collect only the
implementation's expectations. Claude's catalog is a collection checklist, not
proof that Grok has the same shape or supports the same behavior.

## Reality check and first scenarios

Use the installed-native ACP/guard proof, existing native response frames and
native tool schemas observed in the inference request. Initial sessions capture
text/replay, repeated prompts, command results and errors, direct/model-loop MCP,
permission resolution/cancellation, generated image content, and guarded failures.
Broaden from the audited Claude/app catalogs and actual Grok discoveries. Each
scenario has separate stimulus, actual native output and verification records.

Image content over ACP and native clipboard paste are distinct cases. Generated
images are allowed test data. Native paste remains unverified until the test has
real clipboard isolation; an isolated HOME or a no-fork sandbox is not enough.
No personal clipboard, configuration or transcript is an implicit fixture source.

The original corpus stays private until privacy/fidelity review. Size limits,
missing channels, schema drift and unavailable scenarios remain visible gaps.
No successful model reply or green test count certifies a lossy capture complete.
