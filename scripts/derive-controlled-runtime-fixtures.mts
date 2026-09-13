import { deriveControlledRuntimeFixtures } from '../src/testing/controlled-runtime/deriveFixtures.js'

// No implicit capture discovery: the private capture storage must be supplied
// explicitly, even for the inventory. Generation additionally requires opt-in
// and a fresh output directory. Neither mode edits captures or runs native Grok.
const [source, output, ...extra] = process.argv.slice(2)
if (!source || extra.length) {
  console.error('Usage: npx tsx scripts/derive-controlled-runtime-fixtures.mts <private-capture-root> [new-output-directory]')
  process.exitCode = 1
} else {
  try {
    const manifest = await deriveControlledRuntimeFixtures(source, output)
    // The inventory prints only the manifest: counts, hashes and gaps, never timelines.
    console.log(JSON.stringify(manifest, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fixture derivation failed')
    process.exitCode = 1
  }
}
