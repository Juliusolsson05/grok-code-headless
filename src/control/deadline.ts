/** Node clamps overflowing timers to ~1ms, which would turn a long native turn
 * into an immediate uncertain timeout. Unlimited waits must use explicit null. */
export function validateDeadlineMs(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) throw new Error('Invalid control deadline')
}
