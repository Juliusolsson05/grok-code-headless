// Read literal catalog metadata, not application code execution. This inventory
// preserves Claude's exact keys/evidence references without treating those keys
// as Grok capabilities or importing renderer modules into the capture harness.
import ts from 'typescript'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [appRootArg, outputArg] = process.argv.slice(2)
if (!appRootArg || !outputArg) throw new Error('Usage: inventory-claude-shapes.mts APP_ROOT NEW_OUTPUT_JSON')
const appRoot = resolve(appRootArg)
const catalogPath = 'src/providers/claude/renderer/shapes.ts'
const text = await readFile(join(appRoot, catalogPath), 'utf8')
const source = ts.createSourceFile(catalogPath, text, ts.ScriptTarget.Latest, true)
function literal(node: ts.Expression): unknown {
  if (ts.isAsExpression(node)) return literal(node.expression)
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item))
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
    if (!ts.isPropertyAssignment(property)) throw new Error('Nonliteral catalog metadata')
    return [property.name.getText(source).replace(/^['"]|['"]$/g, ''), literal(property.initializer)]
  }))
  throw new Error('Catalog metadata needs an explicit literal reader update')
}
let entries: unknown[] | undefined
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(source) !== 'CLAUDE_RENDER_SHAPES') continue
    const call = declaration.initializer
    if (!call || !ts.isCallExpression(call) || !call.arguments[1] || !ts.isObjectLiteralExpression(call.arguments[1])) throw new Error('Unexpected catalog declaration')
    entries = call.arguments[1].properties.map(property => {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isCallExpression(property.initializer)) throw new Error('Unexpected shape declaration')
      const body = property.initializer.arguments[0]
      if (!body || !ts.isObjectLiteralExpression(body)) throw new Error('Unexpected shape body')
      const selected = Object.fromEntries(body.properties.flatMap(field => {
        if (!ts.isPropertyAssignment(field)) return []
        const name = field.name.getText(source)
        return ['eventTypes', 'planes', 'lifecycles', 'fixtures'].includes(name) ? [[name, literal(field.initializer)]] : []
      }))
      return { claudeShapeId: property.name.text, ...selected }
    })
  }
}
if (!entries?.length) throw new Error('No catalog shapes found')
const output = resolve(outputArg)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  source: { repository: 'agent-code', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim(), path: catalogPath, sha256: createHash('sha256').update(text).digest('hex') },
  evidencePolicy: 'Catalog keys are collection targets. Referenced bundles/curated fixtures are not all verbatim native recordings. This inventory establishes no Grok support.',
  shapeCount: entries.length, shapes: entries,
}, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ shapes: entries.length, output }))
