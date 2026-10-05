import {describe, expect, it} from 'vitest'

import {Candidate, select} from '../lib/select'

const base = {isArchiveDefault: false, usable: true, publishedYear: 2020, citation: 'x'}
const c = (id: string, t0: number, t0Err: number, period: number, periodErr: number, extra: Partial<Candidate> = {}): Candidate =>
  ({...base, id, origin: 'archive', t0, t0Err, period, periodErr, ...extra}) as Candidate

const AT = 2461317.75

describe('select', () => {
  it('prefers a corroborated ExoClock solution', () => {
    const s = select(
      [
        c('exo', 2458000, 0.0001, 3, 1e-7, {origin: 'exoclock'}),
        c('paper', 2458000.0002, 0.0002, 3, 2e-7),
        c('old', 2454000, 0.001, 3.00001, 5e-6, {isArchiveDefault: true}),
      ],
      AT,
      0.5,
    )
    expect(s.chosenId).toBe('exo')
    expect(s.rule).toBe('exoclock-fit')
    expect(s.assessments.find((a) => a.candidateId === 'old')!.verdict).toBe('stale')
  })

  it('does not trust a precise solution nothing agrees with (XO-3b case)', () => {
    // 7.0 days off, not a whole number of 3.19-day orbits, tiny errors.
    const s = select(
      [
        c('typo', 2457424.98786, 0.00011, 3.19152309, 1.4e-7, {isArchiveDefault: true}),
        c('a', 2457417.98678, 0.00013, 3.19152449, 2e-7),
        c('b', 2458691.40475, 0.0001, 3.19152416, 1.5e-7, {origin: 'exoclock'}),
      ],
      AT,
      0,
    )
    expect(s.chosenId).not.toBe('typo')
    expect(s.assessments.find((a) => a.candidateId === 'typo')!.verdict).toBe('stale')
  })

  it('skips ExoClock when its uncertainty tonight is far worse', () => {
    const s = select(
      [
        c('exo', 2455000, 0.01, 50, 0.01, {origin: 'exoclock'}),
        c('p1', 2460000, 0.0002, 50.0000, 1e-5),
        c('p2', 2460000.0001, 0.0003, 50.0000, 1e-5),
      ],
      AT,
      0,
    )
    expect(s.rule).toBe('smallest-propagated-sigma')
  })

  it('flags drift when ExoClock reports its own residual beyond 3 sigma', () => {
    const s = select(
      [c('exo', 2458000, 0.0001, 1.09, 4e-8, {origin: 'exoclock'}), c('p', 2458000, 0.0001, 1.09, 4e-8)],
      AT,
      -5.5,
    )
    expect(s.driftWarning).toBe(true)
  })

  it('marks unknown time systems unusable instead of guessing', () => {
    const s = select(
      [c('exo', 2458000, 0.0001, 3, 1e-7, {origin: 'exoclock'}), c('jd', 2458000, 0.0001, 3, 1e-7, {usable: false, unusableReason: 'unknown-time-system'})],
      AT,
      0,
    )
    expect(s.assessments.find((a) => a.candidateId === 'jd')!.verdict).toBe('unusable')
  })
})
