import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectCommandPermission } from '../../conditions/commandPermission.js'
import type { NativeHarness, Scenario } from './NativeHarness.js'
import type { FixtureTool } from './FixtureBackend.js'
import { generatedPng } from './generatedImage.js'

export const fixtureTools: FixtureTool[] = [
  { name: 'fixture_echo', description: 'Echo controlled fixture data', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    reply: args => ({ content: [{ type: 'text', text: `fixture:${args?.text ?? 'ok'}` }], isError: false }) },
  { name: 'fixture_error', description: 'Return a controlled tool error', inputSchema: { type: 'object', properties: {} },
    reply: () => ({ content: [{ type: 'text', text: 'controlled tool failure' }], isError: true }) },
  { name: 'fixture_structured', description: 'Return controlled structured data and text', inputSchema: { type: 'object', properties: {} },
    reply: () => ({ content: [{ type: 'text', text: 'structured fixture' }], structuredContent: { values: [1, 2], nested: { empty: null } }, isError: false }) },
  { name: 'fixture_image', description: 'Return a generated fixture PNG image', inputSchema: { type: 'object', properties: {} },
    reply: () => ({ content: [{ type: 'image', data: generatedPng().toString('base64'), mimeType: 'image/png' }], isError: false }) },
  { name: 'fixture_mixed', description: 'Return fixture text image and resource content', inputSchema: { type: 'object', properties: {} },
    reply: () => ({ content: [{ type: 'text', text: 'before fixture image' }, { type: 'image', data: generatedPng(100, 80, 2).toString('base64'), mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'fixture://tool/resource', mimeType: 'text/plain', text: 'fixture resource text' } }, { type: 'text', text: 'after fixture resource' }], isError: false }) },
]

async function command(context: NativeHarness, text: string, command: string, permission: 'cancel' | 'allow-once' | 'reject-once' = 'cancel') {
  let sent = false
  context.backend.handler = body => {
    // Auxiliary requests can arrive before the tool-enabled request. Choosing
    // a scripted stimulus is not main-turn attribution; retain all requests and
    // only inject a tool when that actual request advertised its schema.
    if (sent || !context.backend.advertisedToolNames(body).includes('run_terminal_command')) return { kind: 'text', text: 'FIXTURE_TOOL_DONE' }
    sent = true
    return { kind: 'tool', name: 'run_terminal_command', arguments: { command, description: 'Controlled capture fixture' }, callId: 'call_capture_command' }
  }
  const before = context.requests.length
  let settled = false
  const turn = context.prompt(text).finally(() => { settled = true })
  // Install the rejection handler immediately so a source failure is retained,
  // not converted into an unrelated unhandled promise while waiting for a card.
  void turn.catch(() => {})
  await context.waitFor(() => settled || context.requests.length > before, 'tool response or native permission')
  if (!settled) {
    const request = context.requests[before]!
    if (request.method !== 'session/request_permission') throw new Error('Unexpected native interaction; inspect recorded request')
    if (permission === 'cancel') await context.answer(request, { outcome: { outcome: 'cancelled' } })
    else {
      let key: string | undefined
      await context.waitFor(() => {
        const card = detectCommandPermission(context.terminal!.snapshotPlain(), [{ toolCallId: 'call_capture_command', command }])
        key = card?.actions.find(action => action.id === permission)?.key
        return !!key
      }, 'captured one-shot native permission option')
      context.capture.record('action', 'tui-permission-key', { choice: permission, key }, Buffer.from(key!))
      context.tui!.write(key!)
    }
  }
  await turn
  if (!sent) throw new Error('Native tool was not advertised')
  await context.checkpoint('after-tool')
}

export const scenarios: Scenario[] = [
  { id: 'text-load-repeat', description: 'Actual text/thinking output, explicit load, and two identical prompts', targets: ['text', 'thinking', 'load-replay', 'repeated-prompts'],
    async run(context) {
      context.backend.handler = () => ({ kind: 'text', text: 'FIXTURE_REPLY' })
      await context.prompt('Controlled message.\n\tPreserve literal spacing.')
      await context.waitFor(() => context.terminal!.snapshotPlain().includes('FIXTURE_REPLY'), 'native TUI reply')
      await context.checkpoint('first-reply')
      await context.call('session/load', { sessionId: context.sessionId, cwd: context.cwd, mcpServers: context.mcpServers })
      await context.checkpoint('after-load')
      await context.prompt('Identical controlled prompt.')
      await context.checkpoint('duplicate-one')
      await context.prompt('Identical controlled prompt.')
      await context.checkpoint('duplicate-two')
    } },
  { id: 'command-success', description: 'Native shell tool invocation, argument deltas and result', targets: ['tool-call', 'tool-arguments', 'tool-result'],
    run: context => command(context, 'Run the controlled print fixture.', "printf 'FIXTURE_TOOL_OK'", 'allow-once') },
  { id: 'command-error', description: 'Native shell tool with controlled nonzero exit', targets: ['tool-error'],
    run: context => command(context, 'Run the controlled failing fixture.', "printf 'FIXTURE_TOOL_ERROR' >&2; exit 7", 'allow-once') },
  ...(['cancel', 'allow-once', 'reject-once'] as const).map(permission => ({
    id: `permission-${permission}`, description: `Native command permission resolved with ${permission}`, targets: ['permission', permission],
    async run(context: NativeHarness) {
      await mkdir(join(context.cwd, 'permission-probe'))
      await writeFile(join(context.cwd, 'permission-probe', 'owned'), 'fixture')
      const before = context.requests.length
      await command(context, 'Exercise the controlled destructive-command permission.', 'rm -rf ./permission-probe', permission)
      if (context.requests.length === before) throw new Error('No native permission observed')
      const retained = await readFile(join(context.cwd, 'permission-probe', 'owned'), 'utf8').then(() => true, () => false)
      context.capture.record('verification', 'permission-file-outcome', { permission, retained })
      if (retained !== (permission !== 'allow-once')) throw new Error('Unexpected permission file outcome')
    },
  })),
  { id: 'mcp-direct-rich', description: 'Actual control-plane MCP text, error and structured responses', targets: ['mcp-text', 'mcp-error', 'mcp-structured'],
    async run(context) {
      for (const tool of fixtureTools) await context.call('_x.ai/mcp/call', {
        sessionId: context.sessionId, server: 'fixture', serverUrl: context.backend.baseUrl + '/mcp', tool: tool.name, arguments: { text: 'capture' },
      })
      if (context.backend.mcpCalls.length !== fixtureTools.length) throw new Error('MCP server did not receive all controlled calls')
      await context.checkpoint('after-direct-mcp')
    } },
]
