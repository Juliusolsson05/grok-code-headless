// PTY round-trip runner — executed as a PLAIN node main process by the
// system test, NOT imported into the vitest fork.
//
// WHY a subprocess runner: node-pty 1.x on macOS execs a `spawn-helper`
// binary via posix_spawnp, and that spawn fails inside fork()ed children
// (vitest's `forks` pool AND plain child_process.fork repro it) while
// succeeding in a main process — which is how production uses node-pty
// (Electron main). Until that quirk is root-caused (agent-code#832), the
// integration test keeps real coverage by delegating only the PTY piece to
// a true main process and asserting on this script's JSON verdict.
//
// Verdict shape on stdout (single JSON line):
//   { ok: true, cwd, sessionId, kinds: string[], sawPrompt: boolean }
//   { ok: false, error: string }
import { mkdtempSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error }) + '\n')
  process.exit(0) // exit 0: the TEST asserts on the verdict, not the exit code
}

function grokBinary() {
  for (const candidate of ['grok', join(homedir(), '.local', 'bin', 'grok')]) {
    if (spawnSync(candidate, ['--version'], { timeout: 15000 }).status === 0) return candidate
  }
  return null
}

const grok = grokBinary()
if (!grok) fail('grok CLI unavailable')
if (!existsSync(join(homedir(), '.grok', 'auth.json'))) fail('grok auth unavailable')

let pty
try {
  pty = require('node-pty')
} catch {
  fail('node-pty not installed in this checkout (peer dependency)')
}

// Repair node-pty 1.1.0's prebuilt spawn-helper before first use: npm
// extracts it from the published tarball WITHOUT the executable bit
// (mode 644), and posix_spawnp(spawn-helper) then fails with a bare
// "posix_spawnp failed" — EACCES masquerading as ENOENT. A reinstall can
// reset the bit at any time, so repair (idempotently) rather than assume.
// agent-code itself never hits this: its postinstall electron-rebuild
// compiles node-pty from source. See agent-code#832 stage notes.
import { chmodSync, statSync, existsSync as pathExists } from 'node:fs'
{
  const candidates = []
  const selfDir = dirname(fileURLToPath(import.meta.url))
  for (const base of [join(selfDir, '..', '..')]) {
    candidates.push(
      join(base, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(base, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
      join(base, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
    )
  }
  for (const helper of candidates) {
    if (pathExists(helper) && (statSync(helper).mode & 0o111) === 0) {
      try { chmodSync(helper, 0o755) } catch { /* read-only checkout: the spawn will tell us */ }
    }
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'grok-integ-'))
// Encode inline (duplicates SessionDirEncoding on purpose — the runner must
// stay plain-node with zero TS-source imports; the system test separately
// verifies the library encoder against the same dirnames):
import { realpathSync } from 'node:fs'
const encode = p => realpathSync(p).split('/').map(encodeURIComponent).join('%2F')

const term = pty.spawn(grok, ['--no-auto-update'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
await sleep(12000) // TUI warm-up (MCP + models fetch on cold start)
term.write('Reply with exactly the single word KIWI.\r')

const deadline = Date.now() + 90000
let committed = null
let sessionId = null
while (Date.now() < deadline) {
  await sleep(2000)
  try {
    const dir = join(join(homedir(), '.grok', 'sessions'), encode(cwd))
    for (const s of readdirSync(dir)) {
      const ch = join(dir, s, 'chat_history.jsonl')
      if (existsSync(ch)) {
        const text = readFileSync(ch, 'utf8')
        // The oracle is the ASSISTANT answer, not the prompt echo — the
        // <user_query> line contains KIWI too, and matching it would let a
        // session that never answered count as a round-trip.
        const answered = text
          .split('\n')
          .filter(l => l !== '')
          .some(l => {
            try {
              const item = JSON.parse(l)
              return item.type === 'assistant' && typeof item.content === 'string' &&
                item.content.includes('KIWI')
            } catch { return false }
          })
        if (answered) {
          committed = text
          sessionId = s
          break
        }
      }
    }
  } catch {
    // session dir not created until the first prompt lands
  }
  if (committed) break
}
term.kill()

if (!committed) fail('no committed KIWI line within deadline')
const kinds = committed.split('\n').filter(l => l !== '').map(l => JSON.parse(l).type)
if (!kinds.includes('assistant')) fail('KIWI line committed but no assistant item — poll oracle broken')
process.stdout.write(
  JSON.stringify({ ok: true, cwd, sessionId, kinds, sawPrompt: committed.includes('<user_query>') }) + '\n',
)
