import { SseDecoder, type SseFrame } from './SseDecoder.js'

type Identity = { flowId: string; responseId: string }
export type GrokStreamEvent =
  | (Identity & { type: 'started' })
  | (Identity & { type: 'text-delta'; itemId: string; delta: string })
  | (Identity & { type: 'reasoning-delta'; itemId: string; delta: string })
  | (Identity & { type: 'tool-started'; itemId: string; callId: string; name: string })
  | (Identity & { type: 'tool-arguments-delta'; itemId: string; delta: string })
  | (Identity & { type: 'tool-arguments-done'; itemId: string; arguments: string })
  | (Identity & { type: 'completed' | 'failed' | 'incomplete' })
  | { type: 'diagnostic'; flowId: string; code: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// One observer belongs to ONE HTTP request. Session IDs or equal text are
// not enough to merge streams: title generation and dashboard recap can share
// both with a user turn. This API deliberately makes no main-turn claim.
export class GrokResponseObserver {
  private readonly decoder: SseDecoder
  private responseId: string | undefined
  private terminal = false
  private ended = false
  private failure: string | undefined

  constructor(private readonly options: {
    flowId: string
    onEvent: (event: GrokStreamEvent) => void
    maxFrameBytes?: number
  }) {
    this.decoder = new SseDecoder(frame => this.accept(frame), code => this.fail(code), options.maxFrameBytes)
  }

  get failureCode(): string | undefined { return this.failure }
  write(chunk: Uint8Array): void { if (!this.ended && !this.failure) this.decoder.write(chunk) }
  end(): void {
    if (this.ended) return
    this.ended = true
    this.decoder.end()
    if (!this.terminal && !this.failure) this.fail('incomplete-stream')
  }

  private publish(event: GrokStreamEvent): void {
    // A renderer/recorder callback must not abort model inference. The relay
    // can inspect failureCode and report degraded observation independently.
    try { this.options.onEvent(event) } catch { this.failure = 'consumer-error' }
  }
  private fail(code: string): void {
    if (this.failure) return
    this.failure = code
    this.publish({ type: 'diagnostic', flowId: this.options.flowId, code })
  }

  private accept(frame: SseFrame): void {
    if (this.failure || this.terminal || frame.data === '' || frame.data === '[DONE]') return
    let value: unknown
    try { value = JSON.parse(frame.data) } catch { this.fail('invalid-json'); return }
    if (!record(value) || typeof value.type !== 'string') { this.fail('invalid-event'); return }
    if (frame.event !== 'message' && frame.event !== value.type) { this.fail('event-type-mismatch'); return }
    const response = record(value.response) ? value.response : undefined
    if (value.type === 'response.created') {
      if (typeof response?.id !== 'string' || response.id.length === 0 || this.responseId) { this.fail('invalid-response-identity'); return }
      this.responseId = response.id
      this.publish({ type: 'started', flowId: this.options.flowId, responseId: this.responseId })
      return
    }
    if (!this.responseId) { this.fail('missing-response-identity'); return }
    if (response?.id !== undefined && response.id !== this.responseId) { this.fail('response-identity-changed'); return }
    const identity = { flowId: this.options.flowId, responseId: this.responseId }
    switch (value.type) {
      case 'response.output_text.delta':
      case 'response.reasoning_summary_text.delta':
      case 'response.function_call_arguments.delta': {
        if (typeof value.item_id !== 'string' || typeof value.delta !== 'string') { this.fail('invalid-delta'); return }
        const type = value.type === 'response.output_text.delta' ? 'text-delta'
          : value.type === 'response.reasoning_summary_text.delta' ? 'reasoning-delta' : 'tool-arguments-delta'
        this.publish({ ...identity, type, itemId: value.item_id, delta: value.delta })
        break
      }
      case 'response.output_item.added': {
        const item = record(value.item) ? value.item : undefined
        if (item?.type !== 'function_call') return
        if (typeof item.id !== 'string' || typeof item.call_id !== 'string' || typeof item.name !== 'string') { this.fail('invalid-tool-call'); return }
        this.publish({ ...identity, type: 'tool-started', itemId: item.id, callId: item.call_id, name: item.name })
        break
      }
      case 'response.function_call_arguments.done':
        if (typeof value.item_id !== 'string' || typeof value.arguments !== 'string') { this.fail('invalid-tool-arguments'); return }
        this.publish({ ...identity, type: 'tool-arguments-done', itemId: value.item_id, arguments: value.arguments })
        break
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
        if (response?.id !== this.responseId) { this.fail('invalid-response-identity'); return }
        this.terminal = true
        this.publish({ ...identity, type: value.type === 'response.completed' ? 'completed' : value.type === 'response.failed' ? 'failed' : 'incomplete' })
        break
      case 'error': this.fail('provider-error'); break
      // Done/item metadata is not an extra text delta. Re-emitting it would
      // duplicate the streamed answer. Durable history remains its own input.
    }
  }
}
