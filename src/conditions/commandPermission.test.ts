import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectCommandPermission } from './commandPermission.js'

const fixture = JSON.parse(readFileSync(new URL('../../testing/fixtures/conditions/command-approval.json', import.meta.url), 'utf8'))
const screen: string = fixture.lines.join('\n')
const pending = [{ toolCallId: 'call_permission_fixture', command: 'rm -rf ./permission-probe' }]

describe('captured native command-approval card', () => {
  it('exposes one-shot choices, never the first always-approve row', () => {
    const card = detectCommandPermission(screen, pending)
    expect(card?.command).toBe(pending[0]!.command)
    expect(card?.actions).toEqual([
      { id: 'allow-once', label: 'Yes, proceed', key: '3' },
      { id: 'reject-once', label: 'No, reject (type to add feedback)', key: '4' },
    ])
  })

  it('derives the key from the observed row rather than the choice order in an API array', () => {
    const changed = screen.replace('3 (\u25cb) Yes, proceed', '3 (\u25cb) Unrecognized choice')
    expect(detectCommandPermission(changed, pending)).toBeNull()
  })

  it('refuses pending-tool evidence without the focused native approval card', () => {
    expect(detectCommandPermission('', pending)).toBeNull()
    expect(detectCommandPermission(screen.replace('Tab:next option', 'Tab:focus permission'), pending)).toBeNull()
  })

  it('requires an exact, unambiguous pending command match', () => {
    expect(detectCommandPermission(screen, [])).toBeNull()
    expect(detectCommandPermission(screen, [{ ...pending[0]!, command: 'rm -rf ./another-directory' }])).toBeNull()
    expect(detectCommandPermission(screen, [...pending, { ...pending[0]!, toolCallId: 'other-call' }])).toBeNull()
  })

  it('binds the action token to both the tool identity and the visible card', () => {
    const original = detectCommandPermission(screen, pending)!
    expect(detectCommandPermission(screen, [{ ...pending[0]!, toolCallId: 'next-call' }])!.id).not.toBe(original.id)
    expect(detectCommandPermission(screen.replaceAll('Remove only the disposable fixture directory', 'Different request description'), pending)!.id).not.toBe(original.id)
    expect(detectCommandPermission(screen.replace('<fixture-cwd>', 'unrelated project header'), pending)!.id).toBe(original.id)
  })
})
