// Session discovery: enumerate grok sessions by cwd (resume picker) or
// globally (debug walkers), newest first, plus transcript resolution.
//
// Mirrors the two-tier list API of claude-code-headless
// (listSessionsForCwd / listAllClaudeSessions) so the app-side registry
// slots in without a compatibility shim (registry.main.ts pattern).

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { encodeGrokSessionsDir, getGrokSessionsRoot, validateGrokSessionId } from './SessionDirEncoding.js'
import { parseGrokSummary, type GrokSessionSummary } from './SummaryJson.js'

export interface GrokSessionListEntry {
  sessionId: string
  cwd: string
  title: string
  createdAt?: string
  updatedAt?: string
  modelId?: string
}

// WHY every optional field is type-checked here (agent-code#1249):
// summary.json is written and maintained by grok, and parseGrokSummary only
// proves the identity pair. A field typed differently by some grok build (a
// numeric timestamp, an object summary) used to flow straight into the sort's
// localeCompare and the app's `title.trim()`, throw outside the per-row try,
// and empty the whole catalog, which also failed switching or duplicating
// into Grok. A mistyped field is dropped for its own row; an absent one (real:
// 2 of 52 summaries have no `last_active_at`) already falls through the same way.
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toEntry(summary: GrokSessionSummary): GrokSessionListEntry {
  return {
    sessionId: summary.info.id,
    cwd: summary.info.cwd,
    title: text(summary.session_summary) ?? text(summary.generated_title) ?? summary.info.id,
    createdAt: text(summary.created_at),
    updatedAt: text(summary.updated_at) ?? text(summary.last_active_at),
    modelId: text(summary.current_model_id),
  }
}

// WHY the summary is opened non-blocking and checked by DESCRIPTOR
// (agent-code#1249 review B, round 2): the read is synchronous and runs in the
// Electron main process. A FIFO named summary.json blocked readFileSync
// forever and froze the whole app, and checking the path first (stat, then
// read) still lost a race to a file swapped for a FIFO in between. Opening
// with O_NONBLOCK never blocks, fstat on that same descriptor says what was
// actually opened, and the read uses it, so nothing can change underneath.
// The app's own grokTranscript reader does the same.
function readRegularFile(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function listDirEntries(root: string): Dirent[] {
  try {
    return readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Sessions for one cwd, newest-updated first. cwd is resolved+encoded the
 *  same way grok does (see SessionDirEncoding for the /private/var lesson). */
export function listGrokSessions(options: {
  cwd: string
  limit?: number
  grokHome?: string
}): GrokSessionListEntry[] {
  if (options.limit === 0) return []
  const dir = join(getGrokSessionsRoot(options.grokHome), encodeGrokSessionsDir(options.cwd))
  const out: GrokSessionListEntry[] = []
  for (const entry of listDirEntries(dir)) {
    if (!entry.isDirectory()) continue
    const summaryPath = join(dir, entry.name, 'summary.json')
    // Unreadable/corrupt summaries are skipped, not thrown: a crashed
    // mid-write must not hide the user's other resumable sessions.
    try {
      const text = readRegularFile(summaryPath)
      if (text === null) continue
      const summary = parseGrokSummary(text)
      validateGrokSessionId(summary.info.id)
      if (summary.info.id !== entry.name) continue
      out.push(toEntry(summary))
    } catch {
      continue
    }
  }
  out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return options.limit ? out.slice(0, options.limit) : out
}

/** Every session across every cwd (debug walker / global history UI). */
export function listAllGrokSessions(options?: {
  limit?: number
  grokHome?: string
}): GrokSessionListEntry[] {
  if (options?.limit === 0) return []
  const root = getGrokSessionsRoot(options?.grokHome)
  const out: GrokSessionListEntry[] = []
  for (const cwdDir of listDirEntries(root)) {
    if (!cwdDir.isDirectory()) continue
    const cwdPath = join(root, cwdDir.name)
    for (const sessionDir of listDirEntries(cwdPath)) {
      if (!sessionDir.isDirectory()) continue
      const summaryPath = join(cwdPath, sessionDir.name, 'summary.json')
      try {
        const text = readRegularFile(summaryPath)
        if (text === null) continue
        const summary = parseGrokSummary(text)
        validateGrokSessionId(summary.info.id)
        if (summary.info.id !== sessionDir.name) continue
        out.push(toEntry(summary))
      } catch {
        continue
      }
    }
  }
  out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return options?.limit ? out.slice(0, options.limit) : out
}

export function resolveGrokTranscriptPath(
  cwd: string,
  sessionId: string,
  grokHome?: string,
): string {
  validateGrokSessionId(sessionId)
  return join(
    getGrokSessionsRoot(grokHome),
    encodeGrokSessionsDir(cwd),
    sessionId,
    'chat_history.jsonl',
  )
}
