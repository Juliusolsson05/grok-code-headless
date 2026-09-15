// This is an offline publication boundary, not runtime redaction. A denylist
// of secrets cannot know the user's prompts, MCP names, repository paths or
// future extension fields. Only fixed protocol vocabulary may pass through;
// everything else is generated from structure and within-session equality.
const fields = new Set([
  'type', 'content', 'text', 'url', 'synthetic_reason', 'cwd_generation',
  'prior_turn_interrupt', 'prompt_index', 'tool_calls', 'id', 'name',
  'arguments', 'tool_call_id', 'images', 'kind', 'tool_type', 'summary',
  'encrypted_content', 'model_id', 'model_fingerprint', 'reasoning_effort',
  'status', 'action', 'query', 'queries', 'results', 'title', 'output',
  'command', 'description', 'path', 'file_path', 'old_string', 'new_string',
  'pattern', 'include', 'limit', 'offset', 'metadata',
])
const enums: Record<string, ReadonlySet<string>> = {
  type: new Set(['system', 'user', 'assistant', 'tool_result', 'backend_tool_call',
    'reasoning', 'text', 'image', 'summary_text', 'function_call', 'function_call_output',
    'web_search_call', 'code_interpreter_call', 'search', 'open_page', 'find_in_page']),
  synthetic_reason: new Set(['compaction_meta', 'system_reminder', 'length_continue',
    'project_instructions', 'auto_continue', 'auto_recovery', 'interjection',
    'agent_message', 'parent_agent_message', 'task_completed', 'subagent_completed',
    'notification_drain', 'goal_summary', 'goal_classifier_nudge', 'scheduler_fired',
    'stop_hook_feedback', 'working_directory_switch', 'unknown']),
  tool_type: new Set(['web_search', 'x_search', 'code_interpreter']),
  status: new Set(['completed', 'in_progress', 'failed', 'incomplete']),
  reasoning_effort: new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
}

export function normalizeTranscript(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const mappings = new Map<string, Map<unknown, number>>()
  for (const key of ['prompt_index', 'cwd_generation']) {
    const values = [...new Set(records.map(record => record[key]).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))].sort((a, b) => a - b)
    mappings.set(key, new Map(values.map((value, index) => [value, index])))
  }
  const ordinal = (namespace: string, value: unknown): number => {
    let map = mappings.get(namespace)
    if (!map) { map = new Map(); mappings.set(namespace, map) }
    if (!map.has(value)) map.set(value, map.size)
    return map.get(value)!
  }
  const text = (value: string): string => `[fixture text ${ordinal('text', value.trim()) + 1}]`
  const visit = (value: unknown, key = '', depth = 0): unknown => {
    if (depth > 100) throw new Error('Transcript fixture exceeds the normalization depth limit')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (key === 'id' || key === 'tool_call_id') return ordinal('numeric-id', value) + 1
      // Native counters live on the record, not in arbitrary tool payloads.
      // Keep invalid counter categories invalid instead of laundering corrupt
      // evidence into a valid zero-based prompt rank.
      if (depth === 1 && (key === 'prompt_index' || key === 'cwd_generation')) {
        if (value < 0) return -1
        if (!Number.isInteger(value)) return 1.5
        if (!Number.isSafeInteger(value)) return Number.MAX_SAFE_INTEGER + 1
        return ordinal(key, value)
      }
      return value === 0 ? 0 : Math.sign(value) * (Number.isInteger(value) ? 1 : 1.5)
    }
    if (Array.isArray(value)) return value.map(item => visit(item, key, depth + 1))
    if (typeof value === 'object') {
      // Object.fromEntries safely preserves own __proto__-like input keys as
      // anonymized data. Never assign untrusted keys onto a normal prototype.
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [
        fields.has(field) ? field : `field_${ordinal('field', field) + 1}`,
        visit(item, field, depth + 1),
      ]))
    }
    if (typeof value !== 'string') throw new Error('Transcript fixture must contain only JSON values')
    if (value === '') return ''
    if (Object.hasOwn(enums, key) && enums[key].has(value)) return value
    if (key === 'encrypted_content') return '[encrypted payload omitted]'
    if (key === 'id' || key === 'tool_call_id') return `fixture-id-${ordinal('id', value) + 1}`
    if (key === 'name') return `fixture-tool-${ordinal('tool', value) + 1}`
    if (key === 'url') {
      const id = ordinal('url', value) + 1
      const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value)
      if (data) {
        const mime = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(data[1]) ? data[1] : 'application/octet-stream'
        // Intentionally not a usable image. This corpus proves the inline
        // carrier branch, not image decoding or provider inference validity.
        return `data:${mime};base64,${Buffer.from(`fixture image ${id}`).toString('base64')}`
      }
      return `https://fixture.invalid/image-${id}.png`
    }
    if (key === 'arguments') {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { return '[invalid JSON arguments omitted]' }
      // A JSON string is still a string on disk; only its nested keys/values
      // are normalized. Do not turn malformed recorded arguments into valid
      // calls and accidentally hide the native parser's opaque/error branch.
      return JSON.stringify(visit(parsed, '', depth + 1))
    }
    if (key === 'text' || key === 'content') {
      // These two exact native wrappers affect bootstrap and human-prompt
      // classification. Keep their positions, not arbitrary user-authored XML
      // names or attributes. In particular user_info must still start the text
      // and user_query must keep its native newline-delimited body.
      if (!value.trim()) return value.includes('\n') ? '\n' : ' '
      return value.split(/(<\/?(?:user_query|user_info)>)/g).map(part => {
        if (/^<\/?(?:user_query|user_info)>$/.test(part)) return part
        if (!part) return ''
        return `${part.startsWith('\n') ? '\n' : ''}${part.trim() ? text(part) : ''}${part.endsWith('\n') && part !== '\n' ? '\n' : ''}`
      }).join('')
    }
    return text(value)
  }
  return records.map(record => visit(record) as Record<string, unknown>)
}
