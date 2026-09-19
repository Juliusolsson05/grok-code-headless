const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string'
const boolean = (value: unknown) => typeof value === 'boolean'
const u32 = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff
const unsigned = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const i32 = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= -0x80000000 && (value as number) <= 0x7fffffff
const optional = (value: unknown, check: (value: unknown) => boolean) => value == null || check(value)
const strings = (value: unknown) => Array.isArray(value) && value.every(string)
const formats = (value: unknown) => Array.isArray(value) && value.every(format => format === 'svg' || format === 'folded')
const defaultBoolean = (value: unknown) => value === undefined || boolean(value)

/** Inspect without rewriting the packet. JSON.parse's last-key-wins and lone
 * surrogate acceptance differ from Rust serde; forwarding those original bytes
 * makes the native client disconnect despite our apparently valid parsed view.
 * The scan runs only after JSON.parse proves grammar, so it need only enforce
 * these cross-runtime differences rather than become another JSON parser. */
export function parseLeaderEnvelope(bytes: Buffer): Record<string, any> {
  // ignoreBOM=true preserves the marker as text instead of silently stripping
  // bytes that the native JSON parser would reject when we forward them.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(4))
  const value: unknown = JSON.parse(text)
  if (!record(value) || !string(value.type)) throw new Error('Invalid leader envelope')
  const stack: Array<{ keys: Set<string> | null; key?: string }> = []
  const integers = new Set(['pid', 'leader_protocol_version', 'frequency_hz', 'uptime_ms', 'active_tool_calls', 'grace_ms'])
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const raw = token[0]
    if (raw === '{') stack.push({ keys: new Set() })
    else if (raw === '[') stack.push({ keys: null })
    else if (raw === '}' || raw === ']') stack.pop()
    else if (raw[0] !== '"') {
      const key = stack.at(-1)?.key
      const registrationInteger = stack.length === 1 && (key === 'client_id' || key === 'leader_protocol_version')
      const controlInteger = stack.length === 3 && stack[0]?.key === 'result' && stack[1]?.key === 'Ok' && integers.has(key ?? '')
      // Number.isInteger(1.0) and Number.isInteger(1e0) are true, but serde's
      // integer fields reject both original wire tokens. Validate syntax at
      // the declared field location, while leaving opaque ACP JSON in strings.
      if (!Number.isFinite(Number(raw)) || ((registrationInteger || controlInteger) &&
        (!(key === 'frequency_hz' ? /^-?\d+$/ : /^\d+$/).test(raw) || raw === '-0'))) throw new Error('Invalid native number syntax')
    }
    else {
      const decoded: string = JSON.parse(raw)
      for (const character of decoded) {
        const code = character.codePointAt(0)!
        if (code >= 0xd800 && code <= 0xdfff) throw new Error('Invalid leader string')
      }
      let next = token.index! + raw.length
      while (next < text.length && /[ \t\r\n]/.test(text[next]!)) next++
      if (text[next] === ':') {
        const current = stack.at(-1)
        if (!current?.keys || current.keys.has(decoded)) throw new Error('Ambiguous leader field')
        current.keys.add(decoded); current.key = decoded
      }
    }
  }
  return value
}

export function validLeaderRegistration(value: Record<string, any>): boolean {
  const capabilities = value.leader_capabilities
  return unsigned(value.client_id) && boolean(value.ready) && value.leader_protocol_version === 1 &&
    optional(value.leader_binary_version, string) && record(capabilities) && capabilities.control_v1 === true &&
    ['runtime_cpu_profile', 'workspace_exposure', 'relaunch_v1'].every(key => defaultBoolean(capabilities[key])) &&
    (capabilities.profile_formats === undefined || formats(capabilities.profile_formats))
}

// These control payload shapes come from leader/protocol.rs and shell-base's
// cpu_profile.rs. Unknown shapes fail closed instead of asking the native TUI
// to discover the incompatibility by disconnecting and spawning a replacement.
export function validLeaderControlResult(value: Record<string, any>): boolean {
  if (!string(value.request_id) || !record(value.result) || Object.keys(value.result).length !== 1) return false
  if ('Err' in value.result) {
    const error = value.result.Err
    return record(error) && string(error.message) && ['runtime_profiling_unsupported', 'profile_already_active', 'profile_not_active',
      'profile_stop_in_progress', 'invalid_frequency', 'output_path_collision', 'artifact_write_failed', 'internal_error'].includes(error.code)
  }
  const result = value.result.Ok
  if (!record(result)) return false
  const fields = (keys: string[], check: (value: unknown) => boolean) => keys.every(key => check(result[key]))
  switch (result.type) {
    case 'leader_info':
      return fields(['pid', 'leader_protocol_version'], u32) && fields(['socket_path', 'lock_path', 'ws_url_suffix', 'leader_binary_version'], string) &&
        fields(['profiling_supported', 'profiling_compiled_in', 'cpu_profile_active'], boolean) && defaultBoolean(result.cpu_profile_stopping) &&
        optional(result.profile_started_at, string) && formats(result.profile_formats)
    case 'cpu_profile_status':
      return boolean(result.active) && defaultBoolean(result.stopping) && optional(result.started_at, string) && optional(result.svg_path, string) && optional(result.frequency_hz, i32)
    case 'cpu_profile_started': return u32(result.pid) && i32(result.frequency_hz) && fields(['svg_path', 'started_at'], string)
    case 'cpu_profile_stopped': return u32(result.pid) && fields(['svg_path', 'started_at', 'stopped_at'], string)
    case 'workspace_status': return string(result.state) && unsigned(result.uptime_ms) && fields(['active_tool_calls', 'pid'], u32) &&
      optional(result.hub_url, string) && optional(result.cwd, string) && (result.sessions === undefined || strings(result.sessions))
    case 'relaunching': return fields(['from_version', 'to_version'], string) && unsigned(result.grace_ms)
    case 'relaunch_declined': return string(result.reason)
    default: return false
  }
}
