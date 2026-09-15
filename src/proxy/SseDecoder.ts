import { StringDecoder } from 'node:string_decoder'

export type SseFrame = { event: string; data: string }

// Network chunk boundaries are not SSE boundaries, nor necessarily UTF-8
// boundaries. Keep one bounded frame, never a growing response transcript.
// A budget violation stops observation; callers must keep relaying bytes.
export class SseDecoder {
  private readonly utf8 = new StringDecoder('utf8')
  private line = ''
  private event = ''
  private data: string[] = []
  private bytes = 0
  private skipLf = false
  private stopped = false

  constructor(
    private readonly onFrame: (frame: SseFrame) => void,
    private readonly onError: (code: 'frame-too-large' | 'unterminated-frame') => void,
    private readonly maxFrameBytes = 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error('Invalid SSE frame budget')
  }

  write(chunk: Uint8Array): void {
    if (!this.stopped) this.consume(this.utf8.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  }

  end(): void {
    if (this.stopped) return
    this.consume(this.utf8.end())
    if (!this.stopped && (this.line || this.data.length)) this.onError('unterminated-frame')
    this.stopped = true
  }

  private consume(text: string): void {
    for (const char of text) {
      if (this.stopped) return
      if (this.skipLf && char === '\n') { this.skipLf = false; continue }
      this.skipLf = false
      this.bytes += Buffer.byteLength(char)
      if (this.bytes > this.maxFrameBytes) {
        this.stopped = true
        this.line = ''; this.data = []
        this.onError('frame-too-large')
        return
      }
      if (char !== '\r' && char !== '\n') { this.line += char; continue }
      this.skipLf = char === '\r'
      if (!this.line) {
        const frame = { event: this.event || 'message', data: this.data.join('\n') }
        const hasData = this.data.length > 0
        this.event = ''; this.data = []; this.bytes = 0
        if (hasData) this.onFrame(frame)
      } else if (this.line.startsWith(':')) {
        // Keep the budget for any pending data lines, but discard comment
        // bytes as soon as the line is consumed. Otherwise legal heartbeats
        // without blank separators eventually disable an idle connection.
        this.bytes -= Buffer.byteLength(this.line) + 1
      } else {
        const separator = this.line.indexOf(':')
        const name = separator < 0 ? this.line : this.line.slice(0, separator)
        let value = separator < 0 ? '' : this.line.slice(separator + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (name === 'event') this.event = value
        if (name === 'data') this.data.push(value)
      }
      this.line = ''
    }
  }
}
