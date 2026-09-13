/** The native leader's own frame bound; a larger header is a desynchronised or
 * hostile stream, never a real message, so it is refused before buffering. */
export const MAX_LEADER_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Splits a native leader byte stream into its 4-byte big-endian length-framed
 * JSON envelopes.
 *
 * WHY one splitter shared by the recorder and the verifier: they used to carry
 * separate copies whose rules had already drifted (id matching, error handling),
 * so a recording could satisfy the harness's fail-fast check and then be refused
 * by the verifier after a whole native run. The independence that matters is
 * from the production framing in `src/control/`, whose defects these captures
 * exist to expose; this module deliberately never imports it.
 *
 * WHY chunks are kept as a list: concatenating the whole buffer on every chunk
 * copies quadratically for large frames. Bytes are joined only once a complete
 * header or body is known to be present.
 */
export class FrameSplitter {
  private chunks: Buffer[] = []
  private length = 0

  /** Bytes received that do not yet form a complete frame. A nonzero value at
   * the end of a stream means the stream was truncated mid-frame. */
  get pendingBytes(): number { return this.length }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength) {
      // Copied: a view would make correctness depend on every caller never
      // reusing its buffer after push, a contract nothing enforces.
      this.chunks.push(Buffer.from(chunk))
      this.length += chunk.byteLength
    }
    const envelopes: unknown[] = []
    while (this.length >= 4) {
      const size = this.front(4).readUInt32BE(0)
      if (size > MAX_LEADER_FRAME_BYTES) throw new Error('Leader frame exceeds the native size limit')
      if (this.length - 4 < size) break
      const frame = this.take(4 + size)
      // JSON.parse error messages quote the input, which may be a private
      // prompt; report only that the body was not JSON.
      try { envelopes.push(JSON.parse(frame.subarray(4).toString('utf8'))) }
      catch { throw new Error('Leader frame body is not JSON') }
    }
    return envelopes
  }

  /** The first `count` buffered bytes, merging chunks only when the first chunk
   * is too short (callers guarantee `count <= length`). */
  private front(count: number): Buffer {
    if (this.chunks[0]!.length < count) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]!.subarray(0, count)
  }

  private take(count: number): Buffer {
    const bytes = this.front(count)
    const first = this.chunks[0]!
    if (first.length === count) this.chunks.shift()
    else this.chunks[0] = first.subarray(count)
    this.length -= count
    return bytes
  }
}
