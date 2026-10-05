// "What can I see tonight?" Deterministic: same inputs, same list.

import {nearestTransit, transitsBetween} from './ephemeris'
import {DEFAULT_LIMITS, ObservabilityLimits, Site, sunAltitude, visibility} from './observe'
import {bjdTdbToJdUtc, dateToJd, jdToDate} from './time'

/** The fields the planner needs, as returned by the GROQ query in lib/queries.ts. */
export interface PlannerPlanet {
  name: string
  slug: string
  raDeg: number
  decDeg: number
  vmag: number | null
  depthMmag: number | null
  durationHours: number | null
  minTelescopeInches: number | null
  ttv: boolean
  chosen: {
    id: string
    t0BjdTdb: number
    t0ErrDays: number | null
    periodDays: number
    periodErrDays: number | null
    citation: string
    origin: string
  } | null
  archiveDefault: {
    id: string
    t0BjdTdb: number
    t0ErrDays: number | null
    periodDays: number
    periodErrDays: number | null
    citation: string
    usable: boolean
  } | null
  driftWarning: boolean
  residualMin: number | null
}

export interface TonightRow {
  planet: string
  slug: string
  ingressUtc: string
  midUtc: string
  egressUtc: string
  sigmaMin: number
  minAltDeg: number
  midAltDeg: number
  depthMmag: number | null
  vmag: number | null
  minTelescopeInches: number | null
  source: string
  /** What the NASA default would have told you, minutes relative to the chosen solution. */
  defaultOffsetMin: number | null
  defaultSigmaMin: number | null
  driftWarning: boolean
  ttv: boolean
}

export interface NightWindow {
  /** Evening and morning when the Sun crosses the limit, UTC. */
  darkStart: Date
  darkEnd: Date
}

/** Astronomical night for the evening of `localDate` (a Date at local noon). */
export function nightWindow(site: Site, localNoon: Date, sunLimitDeg = -12): NightWindow {
  // Walk from noon in 5-minute steps; precise to a few minutes, which is all
  // the list needs, since every transit is then checked on its own samples.
  const step = 5 * 60_000
  let t = localNoon.getTime()
  const end = t + 24 * 3_600_000
  let darkStart: number | null = null
  let darkEnd: number | null = null
  for (; t < end; t += step) {
    const alt = sunAltitude(site, new Date(t))
    if (darkStart === null && alt <= sunLimitDeg) darkStart = t
    if (darkStart !== null && alt > sunLimitDeg) { darkEnd = t; break }
  }
  if (darkStart === null) return {darkStart: new Date(localNoon), darkEnd: new Date(localNoon)}
  return {darkStart: new Date(darkStart), darkEnd: new Date(darkEnd ?? end)}
}

export interface PlannerOptions {
  limits?: ObservabilityLimits
  minDepthMmag?: number
  maxVmag?: number
  apertureInches?: number
}

export function planNight(
  planets: PlannerPlanet[],
  site: Site,
  window: NightWindow,
  options: PlannerOptions = {},
): TonightRow[] {
  const limits = options.limits ?? DEFAULT_LIMITS
  const fromBjd = dateToJd(window.darkStart) - 0.01
  const toBjd = dateToJd(window.darkEnd) + 0.01
  const rows: TonightRow[] = []
  for (const p of planets) {
    if (!p.chosen || !p.durationHours) continue
    if (options.minDepthMmag && (p.depthMmag ?? 0) < options.minDepthMmag) continue
    if (options.maxVmag && (p.vmag ?? 99) > options.maxVmag) continue
    if (options.apertureInches && p.minTelescopeInches && p.minTelescopeInches > options.apertureInches) continue
    const eph = {
      t0: p.chosen.t0BjdTdb,
      t0Err: p.chosen.t0ErrDays ?? NaN,
      period: p.chosen.periodDays,
      periodErr: p.chosen.periodErrDays ?? NaN,
    }
    for (const tr of transitsBetween(eph, fromBjd, toBjd)) {
      const midUtc = jdToDate(bjdTdbToJdUtc(tr.mid, p.raDeg, p.decDeg))
      if (midUtc < window.darkStart || midUtc > window.darkEnd) continue
      const vis = visibility(site, {name: p.name, raDeg: p.raDeg, decDeg: p.decDeg, durationH: p.durationHours}, tr.mid, limits)
      if (!vis.fullyObservable) continue
      let defaultOffsetMin: number | null = null
      let defaultSigmaMin: number | null = null
      if (p.archiveDefault?.usable) {
        const d = nearestTransit(
          {
            t0: p.archiveDefault.t0BjdTdb,
            t0Err: p.archiveDefault.t0ErrDays ?? NaN,
            period: p.archiveDefault.periodDays,
            periodErr: p.archiveDefault.periodErrDays ?? NaN,
          },
          tr.mid,
        )
        defaultOffsetMin = (d.mid - tr.mid) * 1440
        defaultSigmaMin = Number.isFinite(d.sigmaMin) ? d.sigmaMin : null
      }
      rows.push({
        planet: p.name,
        slug: p.slug,
        ingressUtc: vis.ingressUtc.toISOString(),
        midUtc: vis.midUtc.toISOString(),
        egressUtc: vis.egressUtc.toISOString(),
        sigmaMin: tr.sigmaMin,
        minAltDeg: vis.minAltDeg,
        midAltDeg: vis.midAltDeg,
        depthMmag: p.depthMmag,
        vmag: p.vmag,
        minTelescopeInches: p.minTelescopeInches,
        source: p.chosen.citation,
        defaultOffsetMin,
        defaultSigmaMin,
        driftWarning: p.driftWarning,
        ttv: p.ttv,
      })
    }
  }
  return rows.sort((a, b) => a.midUtc.localeCompare(b.midUtc))
}
