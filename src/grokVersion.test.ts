import { describe, expect, it } from 'vitest'
import { GROK_HEADLESS_VERSION } from './grokVersion.js'

describe('GROK_HEADLESS_VERSION', () => {
  it('is a semver string', () => {
    expect(GROK_HEADLESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
