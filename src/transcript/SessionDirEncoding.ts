// Session-directory encoding: grok keys sessions under
//   ~/.grok/sessions/<percent-encoded RESOLVED cwd>/<session-uuid>/
//
// WHY realpath-resolution is load-bearing: macOS resolves /var through
// /private/var. A spawn cwd of /var/folders/... is stored under
// %2Fprivate%2Fvar%2F... — encoding the unresolved path finds zero sessions
// (probe-verified failure mode, stage-0). The separator '/' encodes as %2F
// and every segment percent-encodes like encodeURIComponent.
//
// Rust urlencoding::encode uses RFC3986's unreserved set; JS leaves five
// additional characters raw. Encode those too or project names containing
// parentheses silently look in a different directory than Grok writes.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function encodeGrokSessionsDir(cwd: string): string {
  const resolved = realpathSync(resolve(cwd))
  return encodeURIComponent(resolved).replace(/[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function getGrokSessionsRoot(grokHome?: string): string {
  return join(grokHome ?? (process.env.GROK_HOME || join(homedir(), '.grok')), 'sessions')
}

export function validateGrokSessionId(sessionId: string): void {
  // IDs become both CLI arguments and directory components. One invariant
  // must protect both boundaries, including callers outside Agent Code.
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Grok session identity must be a UUID')
  }
}
