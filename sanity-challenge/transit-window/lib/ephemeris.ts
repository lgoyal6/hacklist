// Linear ephemerides: T(n) = T0 + n * P, with the uncertainty that grows as you
// propagate away from the reference epoch. That growth is the whole story: a
// 2012 ephemeris with a period error of 2e-6 days is 20 minutes uncertain after
// 2,500 orbits even though both of its numbers were right when published.

export interface Ephemeris {
  /** Reference midtime, BJD_TDB. */
  t0: number
  /** 1-sigma error on t0, days. NaN when not published. */
  t0Err: number
  /** Period, days. */
  period: number
  /** 1-sigma error on period, days. NaN when not published. */
  periodErr: number
}

export interface PredictedTransit {
  epoch: number
  /** Midtime, BJD_TDB. */
  mid: number
  /** Propagated 1-sigma, minutes. NaN when the ephemeris states no errors. */
  sigmaMin: number
}

const MIN_PER_DAY = 1440

export function sigmaAtEpochMinutes(e: Ephemeris, epoch: number): number {
  return Math.hypot(e.t0Err, epoch * e.periodErr) * MIN_PER_DAY
}

/** Every predicted midtime in [fromBjd, toBjd]. */
export function transitsBetween(e: Ephemeris, fromBjd: number, toBjd: number): PredictedTransit[] {
  const first = Math.ceil((fromBjd - e.t0) / e.period)
  const last = Math.floor((toBjd - e.t0) / e.period)
  const out: PredictedTransit[] = []
  for (let epoch = first; epoch <= last; epoch++) {
    out.push({epoch, mid: e.t0 + epoch * e.period, sigmaMin: sigmaAtEpochMinutes(e, epoch)})
  }
  return out
}

/** The predicted midtime nearest a given time. */
export function nearestTransit(e: Ephemeris, bjd: number): PredictedTransit {
  const epoch = Math.round((bjd - e.t0) / e.period)
  return {epoch, mid: e.t0 + epoch * e.period, sigmaMin: sigmaAtEpochMinutes(e, epoch)}
}

/**
 * Signed disagreement in minutes between two ephemerides at the transit nearest
 * `bjd`: b - a. Wrapped to half a period so a mislabelled epoch count cannot
 * masquerade as a 3-day "drift".
 */
export function disagreementMinutes(a: Ephemeris, b: Ephemeris, bjd: number): number {
  const ta = nearestTransit(a, bjd).mid
  const tb = nearestTransit(b, ta).mid
  const halfPeriodMin = (a.period * MIN_PER_DAY) / 2
  let diff = (tb - ta) * MIN_PER_DAY
  diff = ((diff + halfPeriodMin) % (2 * halfPeriodMin) + 2 * halfPeriodMin) % (2 * halfPeriodMin) - halfPeriodMin
  return diff
}
