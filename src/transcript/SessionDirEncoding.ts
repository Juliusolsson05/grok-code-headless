// Session-directory encoding: grok keys sessions under
//   ~/.grok/sessions/<percent-encoded RESOLVED cwd>/<session-uuid>/
//
// WHY realpath-resolution is load-bearing: macOS resolves /var through
// /private/var. A spawn cwd of /var/folders/... is stored under
// %2Fprivate%2Fvar%2F... — encoding the unresolved path finds zero sessions
// (probe-verified failure mode, stage-0). The separator '/' encodes as %2F
// and every segment percent-encodes like encodeURIComponent.
//
// CAVEAT (kept deliberately simple): encodeURIComponent leaves ~!'()* raw.
// Captured dirnames contain only [A-Za-z0-9._-] segments, and the system
// test asserts our encoding reproduces every real dirname on disk — if a
// future cwd contains an exotic character, that test fails loud instead of
// silently missing sessions.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function encodeGrokSessionsDir(cwd: string): string {
  const resolved = realpathSync(resolve(cwd))
  return resolved.split('/').map(encodeURIComponent).join('%2F')
}

export function getGrokSessionsRoot(grokHome?: string): string {
  return join(grokHome ?? join(homedir(), '.grok'), 'sessions')
}
