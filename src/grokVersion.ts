// WHY a version module before any real code lands: the standard test
// contract's `test:package` step needs a public entry point to verify, and
// the agent-code wiring PR needs something importable in all four of its
// module resolvers (two tsconfigs, electron-vite, vitest). Task 2 onward
// replaces this with the real surface (GrokHeadless, transcript codec,
// session discovery, proxy).
export const GROK_HEADLESS_VERSION = '0.0.1'
