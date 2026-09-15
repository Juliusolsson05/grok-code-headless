// Everything the caller needs to spawn one observable Grok terminal.
//
// This is the opencode-terminal-headless `prepareOpencodeTerminalLaunch` slot:
// values the app session needs BEFORE the PTY exists. The caller still spawns the
// PTY itself (the package never owns a process, like its siblings) with exactly
// these arguments and environment, then hands the PTY and this launch to
// GrokHeadless.
//
// WHY the guard socket is an input, not something prepared here: the terminal
// must connect to the owned guard, and the guard listens on a private socket it
// creates itself (GrokTuiSocketGuard.create). Native forces the order that makes
// this safe: the terminal uses connect-or-spawn for its leader with no
// connect-only flag, so the app session must start the leader and the guard
// BEFORE spawning this terminal, or the terminal launches an unowned leader
// (contract.md, "Root class shape"). Nothing here starts anything.
//
// WHY `--resume <id>` for fresh sessions too: it is the only recorded way to
// attach a terminal to an app-assigned session through a guard. The app session
// creates a fresh session over control first, as Agent Code pre-creates OpenCode
// Terminal sessions in the app, and a resume points the terminal at the existing
// one. A fresh `--session-id`, or spawning before the session exists, is unrecorded
// (process.lifecycle gap).
//
// WHY `--fullscreen`: every Stage 1 recording ran the terminal fullscreen, so it is
// the terminal mode the catalog's facts were observed in.
//
// WHY TERM is fixed and COLORTERM/NO_COLOR are not: the recorder's harness ran
// every recording with exactly `TERM=xterm-256color` and nothing else, so that is
// the only terminal environment the recorded behaviour is known under. Inventing
// COLORTERM=truecolor or NO_COLOR here would run the terminal in an environment
// no observation covers.
//
// WHY synchronous where OpenCode's is async: OpenCode resolves a database path and
// allocates a port. Grok needs neither; the private socket comes from the guard.

import { validateGrokSessionId } from '../transcript/SessionDirEncoding.js'

export type GrokTerminalLaunch = {
  binary: string
  args: string[]
  env: Record<string, string>
  sessionId: string
  guardSocketPath: string
}

export type PrepareGrokTerminalLaunchOptions = {
  binary: string
  env: Record<string, string>
  /** The app-assigned session, already created (fresh) or existing (resume) on the owned leader. */
  sessionId: string
  /** The owned guard's private socket (GrokTuiSocketGuard.socketPath). */
  guardSocketPath: string
  /** Mode flags only; identity, leader and update flags are reserved. */
  extraArgs?: string[]
}

// Arguments that would replace the session identity, the leader the terminal
// connects to, or the update behaviour this launch fixes. Any of them would let
// the terminal read or write a conversation, or reach a leader, the app does not own.
const RESERVED = /^(?:-r|-s|-c|-p|--resume|--session-id|--continue|--single|--cwd|--fork-session|--leader|--leader-socket|--no-leader|--no-auto-update)(?:=|$)/

export function prepareGrokTerminalLaunch(options: PrepareGrokTerminalLaunchOptions): GrokTerminalLaunch {
  validateGrokSessionId(options.sessionId)
  if (!options.guardSocketPath) throw new Error('Grok terminal launch requires the owned guard socket')
  const extra = options.extraArgs ?? []
  if (extra.some(arg => RESERVED.test(arg))) throw new Error('Extra arguments cannot override session, leader or update ownership')
  return {
    binary: options.binary,
    args: ['--no-auto-update', '--fullscreen', '--leader', '--leader-socket', options.guardSocketPath, '--resume', options.sessionId, ...extra],
    env: { ...options.env, TERM: 'xterm-256color' },
    sessionId: options.sessionId,
    guardSocketPath: options.guardSocketPath,
  }
}
