// summary.json — per-session metadata written and MAINTAINED by grok itself.
// Field set verified against real sessions (stage-0 + fixtures). Fields are
// optional because grok normalizes the document on load (stage-0 synthesis
// probe: it rewrote counts rather than rejecting divergence), so a partially
// populated summary from a hand-synthesized session is a legal on-disk state.

export interface GrokSummaryInfo {
  id: string
  cwd: string
  [key: string]: unknown
}

export interface GrokSessionSummary {
  info: GrokSummaryInfo
  session_summary?: string
  generated_title?: string
  created_at?: string
  updated_at?: string
  last_active_at?: string
  num_messages?: number
  num_chat_messages?: number
  current_model_id?: string
  chat_format_version?: number
  grok_home?: string
  git_root_dir?: string
  git_remotes?: string[]
  reasoning_effort?: string
  sandbox_profile?: string
  agent_name?: string
  [key: string]: unknown
}

export function parseGrokSummary(json: string): GrokSessionSummary {
  const parsed = JSON.parse(json) as GrokSessionSummary
  // info.id + info.cwd are the identity pair every consumer (discovery,
  // resume, switching) keys on; anything else degrades gracefully.
  if (typeof parsed?.info?.id !== 'string' || typeof parsed?.info?.cwd !== 'string') {
    throw new Error('summary.json missing info.id / info.cwd identity pair')
  }
  return parsed
}
