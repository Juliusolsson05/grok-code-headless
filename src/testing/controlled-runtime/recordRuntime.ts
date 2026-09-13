import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertPrivateCaptureLocation } from './Capture.js'
import { EvidenceRejectedError } from './EvidenceVerification.js'
import { NativeHarness } from './NativeHarness.js'
import { advancedScenarios } from './advancedScenarios.js'
import { contentScenarios } from './contentScenarios.js'
import { failureScenarios } from './failureScenarios.js'
import { fixtureTools, scenarios } from './scenarios.js'

/**
 * One scenario's outcome in a recording batch.
 *
 * WHY `evidence-rejected` is separate from `capture-incomplete`: Stage 1 counts
 * native behaving differently from a scenario's claim as an observed variant,
 * but refuses a truncated or unverifiable capture. Reporting both as incomplete
 * would hide exactly the cases the catalog needs to see.
 */
export type RecordingResult = {
  scenario: string
  outcome: 'passed' | 'failed' | 'startup-failed' | 'capture-incomplete' | 'evidence-rejected'
  captureComplete?: boolean
  observations?: number
  bytes?: number
  directory?: string
  failure?: string
}

/**
 * Record the selected scenarios against the installed native CLI.
 *
 * WHY this body lives under src/ behind a thin script: the package type-check
 * covers only src/, and this is where native runs are sequenced and their
 * outcomes classified. Same split as scripts/normalize-transcript-fixtures.mts.
 */
export async function recordControlledRuntime(outputPath: string, selected: string | undefined): Promise<{ batch: string; results: RecordingResult[] }> {
  const output = resolve(outputPath)
  const cases = [...scenarios, ...contentScenarios, ...advancedScenarios, ...failureScenarios]
    .filter(scenario => selected === 'all' || selected?.split(',').includes(scenario.id))
  if (!cases.length) throw new Error('Unknown capture scenario')
  // Refuse BEFORE creating anything. RuntimeCapture.create enforces the same
  // boundary for every capture directory, but this runner also writes its own
  // batch index here, which names private capture paths and failure text.
  await assertPrivateCaptureLocation(output)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const results: RecordingResult[] = []
  const report = (result: RecordingResult) => { results.push(result); console.log(JSON.stringify(result)) }
  const failureOutcome = (error: unknown) => error instanceof EvidenceRejectedError ? 'evidence-rejected' as const : 'capture-incomplete' as const
  const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

  for (const scenario of cases) {
    // `kind` exists only on StartupFailureScenario; testing presence alone lets
    // the compiler narrow both branches (adding `&& kind === ...` defeats that).
    if ('kind' in scenario) {
      try {
        const captured = await NativeHarness.recordExpectedStartupFailure(output, scenario)
        report({ scenario: scenario.id, outcome: captured.manifest.scenarioOutcome, captureComplete: captured.manifest.captureComplete,
          observations: captured.manifest.observations, bytes: captured.manifest.totalBytes, directory: captured.directory, failure: captured.failure })
      } catch (error) {
        report({ scenario: scenario.id, outcome: failureOutcome(error), failure: message(error, 'Unknown capture failure') })
      }
      continue
    }
    let context: NativeHarness | undefined
    let failure: string | undefined
    try {
      context = await NativeHarness.create(output, scenario, fixtureTools)
      context.capture.record('scenario', 'started', { id: scenario.id })
      await scenario.run(context)
      context.capture.record('scenario', 'passed', { id: scenario.id })
    } catch (error) {
      failure = message(error, 'Unknown scenario failure')
      context?.capture.record('scenario', 'failed', { id: scenario.id, failure })
    }
    if (!context) { report({ scenario: scenario.id, outcome: 'startup-failed', failure }); continue }
    try {
      const captured = await context.finish(failure ? 'failed' : 'passed')
      report({ scenario: scenario.id, outcome: captured.manifest.scenarioOutcome, captureComplete: captured.manifest.captureComplete,
        observations: captured.manifest.observations, bytes: captured.manifest.totalBytes, directory: captured.directory, failure })
    } catch (error) {
      // A capture-finalization failure can occur before all owned resources have
      // been visited. NativeHarness.close() deliberately permits this second
      // idempotent pass; never advance the batch merely because the evidence
      // manifest could not be certified.
      await context.close().catch(() => {})
      report({ scenario: scenario.id, outcome: failureOutcome(error), directory: context.capture.directory, failure: message(error, 'Unknown capture failure') })
    }
  }
  const batch = join(output, `batch-${randomUUID()}.json`)
  await writeFile(batch, JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ batch, scenarios: results.length }))
  return { batch, results }
}
