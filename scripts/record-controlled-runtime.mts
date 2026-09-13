import { recordControlledRuntime } from '../src/testing/controlled-runtime/recordRuntime.js'

// Thin argv wrapper. Native recording is explicit opt-in into an explicit private
// directory; sequencing and outcome classification live in recordRuntime.ts so
// the package type-check covers them.
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const caseIndex = args.indexOf('--case')
if (process.env.GROK_RECORD_NATIVE !== '1' || outputIndex < 0 || !args[outputIndex + 1]) {
  throw new Error('Usage: GROK_RECORD_NATIVE=1 record-controlled-runtime.mts --output PRIVATE_DIRECTORY [--case NAME|all]')
}
const { results } = await recordControlledRuntime(args[outputIndex + 1]!, caseIndex >= 0 ? args[caseIndex + 1] : 'text-load-repeat')
if (results.some(result => result.outcome !== 'passed' || result.captureComplete !== true)) process.exitCode = 1
