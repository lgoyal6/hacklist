import {describe, expect, it} from 'vitest'

import {checkAgainstEvidence, extractClaims} from '../lib/agent'

describe('number check', () => {
  it('extracts times, decimals and long integers, not small counts', () => {
    expect(extractClaims('Mid at 05:11 UTC, 17.3 min off, epoch 2457417, 3 papers')).toEqual(['05:11', '17.3', '2457417'])
  })
  it('accepts numbers present in tool output, including rounding and sign in words', () => {
    const evidence = '{"midUtc":"2026-10-11T05:11Z","offsetMin":-17.34,"t0":2457417.98762}'
    expect(checkAgainstEvidence('Mid-transit 05:11 UTC; NASA is 17.3 minutes early; T0 2457417.98762', evidence).ok).toBe(true)
  })
  it('flags a number nothing returned', () => {
    const r = checkAgainstEvidence('The transit is at 05:40 and 12.5 minutes late.', '{"midUtc":"05:11","offsetMin":3.1}')
    expect(r.ok).toBe(false)
    expect(r.unsupported).toEqual(['05:40', '12.5'])
  })
  it('does not flag years', () => {
    expect(checkAgainstEvidence('Published in 2012.', '').ok).toBe(true)
  })
})
