// grok-code-headless — programmatic control of Grok Build via headless terminal.
//
// Mirrors claude-code-headless / codex-headless API surface where possible.
// Provider-specific halves (screen parser, session storage under
// ~/.grok/sessions/<encoded resolved cwd>, updates.jsonl/tool lifecycle,
// cli-chat-proxy relay) land with Tasks 2-6 of the grok provider plan.
export { GROK_HEADLESS_VERSION } from './grokVersion.js'
