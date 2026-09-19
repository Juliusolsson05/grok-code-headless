import type { GrokAcpServerRequest } from '../../control/GrokAcpClient.js'
import type { NativeHarness } from './NativeHarness.js'

export type ModelStep = { name: string; arguments: Record<string, unknown> } | ((actualOutputs: any[]) => { name: string; arguments: Record<string, unknown> })
export function innerParams(request: GrokAcpServerRequest): any {
  const params = request.params as any
  return params?.method && params?.params ? params.params : params
}

/** Scripted model stimuli advance only after the actual native tool result
 * appears in a subsequent inference request. Auxiliary calls stay in the
 * recording but cannot consume a step merely by arriving first. This probes
 * the native tool loop; it is not autonomous-model capability evidence. */
export async function modelSequence(context: NativeHarness, steps: ModelStep[], interaction?: (request: GrokAcpServerRequest) => Promise<void>): Promise<any[]> {
  let step = 0
  let sent = false
  let planError: string | undefined
  const outputs: any[] = []
  const ids = steps.map((_, index) => `call_capture_step_${index}`)
  context.backend.handler = body => {
    if (planError) return { kind: 'text', text: 'FIXTURE_STIMULUS_GAP' }
    if (sent) {
      const actual = (body.input ?? []).find((item: any) => item.type === 'function_call_output' && item.call_id === ids[step])
      if (!actual) return { kind: 'text', text: 'FIXTURE_AUXILIARY_REPLY' }
      outputs.push(actual.output)
      context.capture.record('observation', 'native-tool-output', { callId: ids[step], output: actual.output })
      step++; sent = false
    }
    if (step >= steps.length) return { kind: 'text', text: 'FIXTURE_SEQUENCE_DONE' }
    try {
      const current = steps[step]!
      const next = typeof current === 'function' ? current(outputs) : current
      if (!context.backend.advertisedToolNames(body).includes(next.name)) return { kind: 'text', text: 'FIXTURE_AUXILIARY_REPLY' }
      sent = true
      return { kind: 'tool', ...next, callId: ids[step] }
    } catch (error) {
      planError = error instanceof Error ? error.message : 'Unknown stimulus planning failure'
      context.capture.record('coverage', 'stimulus-gap', { step, planError })
      return { kind: 'text', text: 'FIXTURE_STIMULUS_GAP' }
    }
  }
  let nextRequest = context.requests.length
  let settled = false
  const turn = context.prompt('Execute the controlled capture scenario.').finally(() => { settled = true })
  void turn.catch(() => {})
  while (!settled) {
    await context.waitFor(() => settled || context.requests.length > nextRequest, 'native tool-loop observation')
    while (nextRequest < context.requests.length) {
      const request = context.requests[nextRequest++]!
      if (request.method === 'session/request_permission') {
        const params = innerParams(request)
        if (!ids.includes(params?.toolCall?.toolCallId)) throw new Error('Permission does not belong to a scripted fixture call')
        // Both fields were observed in the initial native permission capture.
        // Do not generalize AllowOnce alone into the TUI's global-approve option.
        const allow = params.options?.find((option: any) => option.optionId === 'allow-once' && option.kind === 'allow_once')
        if (!allow) throw new Error('Recorded one-shot permission option is unavailable')
        await context.answer(request, { outcome: { outcome: 'selected', optionId: allow.optionId } })
      } else if (interaction) await interaction(request)
      else throw new Error('Unclassified native interaction; retained for the coverage catalog')
    }
  }
  await turn
  if (planError) throw new Error(planError)
  if (step !== steps.length) throw new Error(`Native tool-loop coverage incomplete: ${step}/${steps.length} results observed`)
  await context.checkpoint('after-native-tool-sequence')
  return outputs
}
