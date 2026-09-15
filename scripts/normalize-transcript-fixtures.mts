import { generateTranscriptFixtures } from '../src/testing/transcriptCorpus.js'

// No implicit home reads: source storage must be explicitly supplied, even
// for the content-free inventory. Generation additionally requires opt-in
// and a fresh output directory. Neither mode edits source files or uses auth.
const [source, output, ...extra] = process.argv.slice(2)
if (!source || extra.length) {
  console.error('Usage: npx tsx scripts/normalize-transcript-fixtures.mts <sessions-root> [new-output-directory]')
  process.exitCode = 1
} else {
  try {
    console.log(JSON.stringify(await generateTranscriptFixtures(source, output), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fixture generation failed')
    process.exitCode = 1
  }
}
