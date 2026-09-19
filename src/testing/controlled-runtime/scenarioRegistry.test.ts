import { describe, expect, it } from 'vitest'

import { scenarios } from './scenarios.js'
import { contentScenarios } from './contentScenarios.js'
import { advancedScenarios } from './advancedScenarios.js'
import { failureScenarios } from './failureScenarios.js'

describe('controlled-runtime scenario registry', () => {
  it('keeps lifecycle and ownership agenda cases explicit and uniquely addressable', () => {
    const registered = [...scenarios, ...contentScenarios, ...advancedScenarios, ...failureScenarios]
    const ids = registered.map(scenario => scenario.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'tui-draft-during-acp',
      'resource-link-unavailable',
      'load-unavailable-session',
      'rewind-history-replacement',
      'leader-loss-idle',
      'leader-loss-mid-turn',
      'tui-submit-after-acp',
      'concurrent-acp-then-tui',
      'concurrent-tui-then-acp',
      'permission-dual-client-race',
      'second-session-control',
      'mcp-remove-restore',
      'native-restart-resume',
      'native-startup-failure',
      'cleanup-retry-native',
      'client-supplied-prompt-identity',
      'cancel-queued-prompt',
      'tui-new-session',
    ]))
    expect(registered.every(scenario => scenario.targets.length > 0)).toBe(true)
  })
})
