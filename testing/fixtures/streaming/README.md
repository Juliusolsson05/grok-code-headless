# Streaming Evidence

`papaya.sse` is a minimized projection of the Grok 1.0.13 stage-0 capture
`proxy-capture/resp-2.sse.txt`, response ID
`cf115ccc-bdaf-965d-ae95-5691b932b6de`. It retains the two actual output-text
deltas (`PAP`, `AYA`), their item ID, event order, sequence numbers and final
output. Only the first two reasoning deltas remain; this is NOT a full
reasoning transcript or an unmodified wire-byte capture. Tools, encrypted
reasoning, billing details and unrelated prompt context were removed.

The private source remains outside this repository at
`../grok-stage0/proxy-capture/resp-2.sse.txt` relative to the working package
checkout used for capture. Its SHA-256 is
`6f50287fa64e7cf127761bf4c55dfde73602a744dc428d15a47b7c12269bbbb2`.
It is intentionally not shipped or required by ordinary test runs. Only the
minimized projection is checked in; copying the full capture into a public
repository would restore encrypted reasoning and unrelated tool/context data.

The captured request asked for PAPAYA; the subsequent `resp-3` dashboard recap
also produced PAPAYA. Therefore matching text is NOT main-turn attribution.
Tests must keep requests isolated rather than joining them by content.

The older `../sse.responses.txt` capture contains a `session_title` tool call.
It is retained as side-request evidence, not as a user-facing assistant turn.
