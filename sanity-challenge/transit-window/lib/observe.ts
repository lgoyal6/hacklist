// Can this transit be seen from here tonight?
import {
  Body,
  Equator,
  Horizon,
  MakeTime,
  Observer,
  Rotation_EQJ_EQD,
  RotateVector,
  SphereFromVector,
  Vector,
} from 'astronomy-engine'

import {bjdTdbToJdUtc, jdToDate} from './time'

export interface Site {
  latitude: number
  longitude: number
  elevationM: number
}

export interface TransitTarget {
  name: string
  raDeg: number
  decDeg: number
  /** Transit duration, hours (first to fourth contact). */
  durationH: number
}

export interface Visibility {
  ingressUtc: Date
  midUtc: Date
  egressUtc: Date
  /** Lowest altitude of the target between ingress and egress, degrees. */
  minAltDeg: number
  /** Altitude at midtime, degrees. */
  midAltDeg: number
  /** Highest Sun altitude between ingress and egress, degrees. */
  maxSunAltDeg: number
  /** Whether the full transit plus a baseline either side is in astronomical dark above the altitude limit. */
  fullyObservable: boolean
}

const JD_UNIX_EPOCH = 2440587.5

function observer(site: Site) {
  return new Observer(site.latitude, site.longitude, site.elevationM)
}

/** Altitude of a J2000 RA/Dec at a UTC instant, precessed to the equator of date, no refraction. */
export function targetAltitude(site: Site, raDeg: number, decDeg: number, utc: Date): number {
  const time = MakeTime(utc)
  const ra = (raDeg * Math.PI) / 180
  const dec = (decDeg * Math.PI) / 180
  const j2000 = new Vector(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), time)
  const ofDate = SphereFromVector(RotateVector(Rotation_EQJ_EQD(time), j2000))
  const hor = Horizon(time, observer(site), ofDate.lon / 15, ofDate.lat, undefined)
  return hor.altitude
}

export function sunAltitude(site: Site, utc: Date): number {
  const time = MakeTime(utc)
  const obs = observer(site)
  const eq = Equator(Body.Sun, time, obs, true, true)
  return Horizon(time, obs, eq.ra, eq.dec, undefined).altitude
}

function sample(from: Date, to: Date, stepMin: number): Date[] {
  const out: Date[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += stepMin * 60_000) out.push(new Date(t))
  out.push(to)
  return out
}

export interface ObservabilityLimits {
  minAltDeg: number
  maxSunAltDeg: number
  /** Out-of-transit baseline wanted on each side, minutes. */
  baselineMin: number
}

export const DEFAULT_LIMITS: ObservabilityLimits = {minAltDeg: 30, maxSunAltDeg: -12, baselineMin: 30}

export function visibility(
  site: Site,
  target: TransitTarget,
  midBjdTdb: number,
  limits: ObservabilityLimits = DEFAULT_LIMITS,
): Visibility {
  const midJdUtc = bjdTdbToJdUtc(midBjdTdb, target.raDeg, target.decDeg)
  const midUtc = jdToDate(midJdUtc)
  const half = (target.durationH / 2) * 3_600_000
  const ingressUtc = new Date(midUtc.getTime() - half)
  const egressUtc = new Date(midUtc.getTime() + half)
  const pad = limits.baselineMin * 60_000
  const window = sample(new Date(ingressUtc.getTime() - pad), new Date(egressUtc.getTime() + pad), 10)
  let minAlt = Infinity
  let maxSun = -Infinity
  for (const t of window) {
    minAlt = Math.min(minAlt, targetAltitude(site, target.raDeg, target.decDeg, t))
    maxSun = Math.max(maxSun, sunAltitude(site, t))
  }
  return {
    ingressUtc,
    midUtc,
    egressUtc,
    minAltDeg: minAlt,
    midAltDeg: targetAltitude(site, target.raDeg, target.decDeg, midUtc),
    maxSunAltDeg: maxSun,
    fullyObservable: minAlt >= limits.minAltDeg && maxSun <= limits.maxSunAltDeg,
  }
}

export {JD_UNIX_EPOCH}
