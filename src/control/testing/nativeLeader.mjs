// Process-boundary fixture, not an emulation used to claim native compatibility.
// The opted-in native probe checks these contracts against installed Grok too.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
const args = process.argv
const path = args[args.indexOf('--leader-socket') + 1]
const mode = process.env.GROK_CONTROL_FIXTURE_MODE
if (process.env.GROK_CONTROL_FIXTURE_STATE) writeFileSync(process.env.GROK_CONTROL_FIXTURE_STATE, JSON.stringify({ pid: process.pid, socketPath: path, inherited: process.env.GROK_CONTROL_PARENT_FIXTURE !== undefined }))
const frame = value => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
createServer(socket => {
  let buffer = Buffer.alloc(0)
  let mcpServers = []
  let mcpPolls = 0
  let heldPrompt
  let promptHeld = false
  let promptErrorSent = false
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
      const size = buffer.readUInt32BE()
      const value = JSON.parse(buffer.subarray(4, size + 4).toString())
      buffer = buffer.subarray(size + 4)
      if (mode === 'no-register') continue
      if (value.type === 'register') socket.write(frame({ type: 'registered', client_id: 1, ready: true, leader_protocol_version: 1, leader_capabilities: { control_v1: true } }))
      else if (value.type === 'control') socket.write(frame({ type: 'control_result', request_id: value.request_id, result: { Ok: { type: 'leader_info', pid: process.pid, leader_protocol_version: 1 } } }))
      else if (value.type === 'acp') {
        const rpc = JSON.parse(value.payload)
        if (mode === 'exit-on-prompt' && rpc.method === 'session/prompt') process.exit(3)
        if (mode === 'prompt-error' && rpc.method === 'session/prompt' && !promptErrorSent) {
          promptErrorSent = true
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Fixture failure' } }) }))
          continue
        }
        if (mode === 'hold-prompt' && rpc.method === 'session/prompt' && !promptHeld) {
          promptHeld = true
          heldPrompt = rpc
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', method: 'fixture/prompt_received' }) }))
          continue
        }
        if (rpc.method === 'session/cancel') {
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', method: 'fixture/cancel_received', params: rpc.params }) }))
        }
        if (rpc.method === 'fixture/release' && heldPrompt) {
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: heldPrompt.id, result: { stopReason: 'cancelled' } }) }))
          heldPrompt = undefined
        }
        if (rpc.method === 'fixture/interaction') {
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission',
            params: { sessionId: rpc.params.sessionId, toolCall: { toolCallId: 'call_fixture' } } }) }))
        }
        if (rpc.method === 'fixture/resolve_interaction') {
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', method: '_x.ai/session_notification',
            params: { sessionId: rpc.params.sessionId, update: { sessionUpdate: 'interaction_resolved', tool_call_id: 'call_fixture' } } }) }))
        }
        if (!rpc.method) continue // reverse-request replies are not new RPCs
        if (!('id' in rpc)) continue
        if (rpc.method === '_x.ai/session/update_mcp_servers') { mcpServers = rpc.params.mcpServers; mcpPolls = 0 }
        if (rpc.method === '_x.ai/mcp/list') {
          mcpPolls++
          // Native 1.0.25 exposes session-only HTTP servers as catalog stdio
          // placeholders without a URL. Observed by the real ACP probe and
          // explained by extensions/mcp.rs's session-only catalog append path.
          const servers = mcpServers.map(server => ({ name: server.name, source: 'local', type: 'stdio', command: '',
            session: { enabled: true, status: mcpPolls < 2 ? 'initializing' : 'ready' } }))
          socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { result: { servers } } }) }))
          continue
        }
        const result = rpc.method === 'initialize' ? { protocolVersion: mode === 'wrong-protocol' ? 999 : 1 } : rpc.method === 'session/new'
          ? { sessionId: rpc.params._meta.sessionId } : { stopReason: 'end_turn', text: rpc.params?.prompt?.[0]?.text }
        socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) }))
      }
    }
  })
}).listen(path)
await new Promise(() => {})
