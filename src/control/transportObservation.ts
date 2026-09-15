export type GrokTransportObservation = {
  role: 'control' | 'tui' | 'guard-upstream'
  connectionId: string
  kind: 'opened' | 'received' | 'write-attempt' | 'write-complete' | 'write-error' | 'closing' | 'closed'
  writeId?: number
  bytes?: Uint8Array
}
export type GrokTransportObserver = (event: GrokTransportObservation) => void

/** Diagnostic/capture-only seam. A recorder cannot alter protocol buffers or
 * acquire lifecycle authority by throwing. No bytes are copied when disabled;
 * capture helpers and filesystem policy stay outside the production runtime.
 * A write-attempt is deliberately distinct from its callback, and neither is
 * provider acceptance. Consumers must preserve those distinctions in evidence. */
export function observeTransport(observer: GrokTransportObserver | undefined, event: Omit<GrokTransportObservation, 'bytes'>, bytes?: Uint8Array): void {
  if (!observer) return
  try { observer({ ...event, ...(bytes ? { bytes: Buffer.from(bytes) } : {}) }) }
  catch { /* capture failure must not change the process being observed */ }
}
