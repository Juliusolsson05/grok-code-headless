// Session discovery: enumerate grok sessions by cwd (resume picker) or
// globally (debug walkers), newest first, plus transcript resolution.
//
// Mirrors the two-tier list API of claude-code-headless
// (listSessionsForCwd / listAllClaudeSessions) so the app-side registry
// slots in without a compatibility shim (registry.main.ts pattern).

import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { encodeGrokSessionsDir, getGrokSessionsRoot } from './SessionDirEncoding.js'
import { parseGrokSummary, type GrokSessionSummary } from './SummaryJson.js'

export interface GrokSessionListEntry {
  sessionId: string
  cwd: string
  title: string
  createdAt?: string
  updatedAt?: string
  modelId?: string
}

function toEntry(summary: GrokSessionSummary): GrokSessionListEntry {
  return {
    sessionId: summary.info.id,
    cwd: summary.info.cwd,
    title: summary.session_summary ?? summary.generated_title ?? summary.info.id,
    createdAt: summary.created_at,
    updatedAt: summary.updated_at ?? summary.last_active_at,
    modelId: summary.current_model_id,
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
  const dir = join(getGrokSessionsRoot(options.grokHome), encodeGrokSessionsDir(options.cwd))
  const out: GrokSessionListEntry[] = []
  for (const entry of listDirEntries(dir)) {
    if (!entry.isDirectory()) continue
    const summaryPath = join(dir, entry.name, 'summary.json')
    if (!existsSync(summaryPath)) continue
    // Unreadable/corrupt summaries are skipped, not thrown: a crashed
    // mid-write must not hide the user's other resumable sessions.
    try {
      out.push(toEntry(parseGrokSummary(readFileSync(summaryPath, 'utf8'))))
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
  const root = getGrokSessionsRoot(options?.grokHome)
  const out: GrokSessionListEntry[] = []
  for (const cwdDir of listDirEntries(root)) {
    if (!cwdDir.isDirectory()) continue
    const cwdPath = join(root, cwdDir.name)
    for (const sessionDir of listDirEntries(cwdPath)) {
      if (!sessionDir.isDirectory()) continue
      const summaryPath = join(cwdPath, sessionDir.name, 'summary.json')
      if (!existsSync(summaryPath)) continue
      try {
        out.push(toEntry(parseGrokSummary(readFileSync(summaryPath, 'utf8'))))
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
  return join(
    getGrokSessionsRoot(grokHome),
    encodeGrokSessionsDir(cwd),
    sessionId,
    'chat_history.jsonl',
  )
}
