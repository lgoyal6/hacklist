// Which published ephemeris to trust for a planet, decided by code.
//
// The model never picks. It reads the decision and its stored reason, so the
// same question always gets the same timing, and the reason can be checked.

import {Ephemeris, nearestTransit, sigmaAtEpochMinutes} from './ephemeris'

export type Origin = 'exoclock' | 'archive'

export interface Candidate extends Ephemeris {
  id: string
  origin: Origin
  isArchiveDefault: boolean
  /** BJD_TDB conversion succeeded and both errors are stated. */
  usable: boolean
  /** Why unusable, when it is. */
  unusableReason?: 'unknown-time-system' | 'no-errors'
  publishedYear: number | null
  citation: string
}

export interface Assessment {
  candidateId: string
  /** Predicted midtime at the target epoch minus the chosen one, minutes. */
  offsetMin: number
  /** This candidate's own propagated 1-sigma at the target epoch, minutes. */
  sigmaMin: number
  /** |offset| measured in combined sigma; null when either side lacks errors. */
  tension: number | null
  verdict: 'chosen' | 'consistent' | 'stale' | 'unusable'
}

export interface Selection {
  chosenId: string | null
  rule: 'exoclock-fit' | 'smallest-propagated-sigma' | 'none'
  reason: string
  /** ExoClock's own latest residual for the chosen ephemeris, minutes (exoclock only). */
  residualMin: number | null
  /** The chosen ephemeris itself is drifting: latest residual > 3 sigma and > 3 min. */
  driftWarning: boolean
  /** Number of other published solutions that agree with the chosen one. */
  corroboration: number
  assessments: Assessment[]
}

const MIN_PER_DAY = 1440

/** Predicted midtime nearest `bjd` and its sigma, for one candidate. */
function at(c: Candidate, bjd: number) {
  return nearestTransit(c, bjd)
}

/**
 * How many other usable solutions agree with this one at `bjd`: within 3
 * combined sigma or 5 minutes, whichever is larger. Solutions whose own
 * uncertainty tonight exceeds 30 minutes agree with everything, so they do
 * not get to vote.
 */
export function corroboration(c: Candidate, others: Candidate[], bjd: number): number {
  const mine = at(c, bjd)
  let n = 0
  for (const o of others) {
    if (o.id === c.id) continue
    const theirs = at(o, mine.mid)
    if (!(theirs.sigmaMin < 30)) continue
    const diff = Math.abs(theirs.mid - mine.mid) * MIN_PER_DAY
    if (diff <= Math.max(3 * Math.hypot(theirs.sigmaMin, mine.sigmaMin), 5)) n++
  }
  return n
}

export function select(
  candidates: Candidate[],
  atBjd: number,
  exoclockResidualMin: number | null,
): Selection {
  const usable = candidates.filter((c) => c.usable)
  const votes = new Map(usable.map((c) => [c.id, corroboration(c, usable, atBjd)]))
  // A solution nothing else agrees with is more likely a transcription error
  // than a discovery (XO-3b's archive default sits 7.0 days, not a whole number
  // of orbits, from every other published solution). Only fall back to
  // uncorroborated solutions when there is nothing else.
  const corroborated = usable.filter((c) => (votes.get(c.id) ?? 0) >= 1)
  const pool = corroborated.length ? corroborated : usable
  const sigmaOf = (c: Candidate) => at(c, atBjd).sigmaMin
  const best = [...pool].sort((a, b) => sigmaOf(a) - sigmaOf(b))[0]
  const exo = pool.find((c) => c.origin === 'exoclock')

  let chosen: Candidate | undefined
  let rule: Selection['rule'] = 'none'
  let reason = 'No published ephemeris with a known time system and stated errors.'
  if (exo && best && sigmaOf(exo) <= Math.max(2 * sigmaOf(best), sigmaOf(best) + 1)) {
    chosen = exo
    rule = 'exoclock-fit'
    reason =
      `ExoClock fits every available midtime, including recent amateur and space observations, in one ` +
      `BJD_TDB solution; its uncertainty tonight (${sigmaOf(exo).toFixed(1)} min) is within reach of the ` +
      `most precise solution, and ${votes.get(exo.id)} other published solution(s) agree with it.`
  } else if (best) {
    chosen = best
    rule = 'smallest-propagated-sigma'
    reason =
      `Smallest uncertainty propagated to tonight (${sigmaOf(best).toFixed(1)} min) among solutions that ` +
      `${corroborated.length ? `at least one other published solution agrees with (${votes.get(best.id)} do)` : 'have stated errors; none is corroborated, so treat with care'}.`
  }

  const chosenMid = chosen ? at(chosen, atBjd) : null
  const assessments: Assessment[] = candidates.map((c) => {
    const p = at(c, chosenMid ? chosenMid.mid : atBjd)
    const sigmaMin = p.sigmaMin
    if (!chosenMid || !chosen || (!c.usable && c.unusableReason === 'unknown-time-system')) {
      return {candidateId: c.id, offsetMin: NaN, sigmaMin, tension: null, verdict: 'unusable'}
    }
    const offsetMin = (p.mid - chosenMid.mid) * MIN_PER_DAY
    const combined = Math.hypot(sigmaMin, chosenMid.sigmaMin)
    const tension = Number.isFinite(combined) && combined > 0 ? Math.abs(offsetMin) / combined : null
    let verdict: Assessment['verdict']
    if (c.id === chosen.id) verdict = 'chosen'
    else if (!c.usable) verdict = 'unusable'
    // Stale: disagrees with the chosen solution by more than 3 combined sigma
    // AND by enough minutes to cost an observer the edges of the transit.
    else verdict = tension !== null && tension > 3 && Math.abs(offsetMin) >= 5 ? 'stale' : 'consistent'
    return {candidateId: c.id, offsetMin, sigmaMin, tension, verdict}
  })

  const chosenSigma = chosenMid?.sigmaMin ?? NaN
  const residual = rule === 'exoclock-fit' ? exoclockResidualMin : null
  const driftWarning =
    residual !== null && Math.abs(residual) > 3 && Math.abs(residual) > 3 * (chosenSigma || 0)

  return {
    chosenId: chosen?.id ?? null,
    rule,
    reason,
    residualMin: residual,
    driftWarning,
    corroboration: chosen ? votes.get(chosen.id) ?? 0 : 0,
    assessments,
  }
}
