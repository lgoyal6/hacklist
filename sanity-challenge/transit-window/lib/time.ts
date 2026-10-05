// Time systems for transit midtimes.
//
// Published midtimes come in at least five systems, and the differences are the
// same size as the drift this project is about:
//   BJD_TDB vs geocentric JD: up to ~8.3 min (light travel across Earth's orbit)
//   TDB vs UTC:               69.184 s today (32.184 s + 37 leap seconds)
//   BJD vs HJD:               up to ~4 s (barycentre vs Sun centre)
// Everything is normalized to BJD_TDB before two ephemerides are compared, and
// converted to UTC at the observer only at the very end.
import {BaryState, Body, MakeTime} from 'astronomy-engine'

export type TimeSystem =
  | 'BJD_TDB'
  | 'BJD_UTC'
  | 'HJD_UTC'
  | 'HJD_TDB'
  | 'JD_UNKNOWN'

const SECONDS_PER_DAY = 86400
const AU_LIGHT_SECONDS = 499.004783836
const JD_J2000 = 2451545.0
const TT_MINUS_TAI = 32.184

// TAI - UTC after each leap second, as [JD of the UTC instant it took effect, seconds].
const LEAP_SECONDS: Array<[number, number]> = [
  [2450630.5, 31], // 1997-07-01
  [2451179.5, 32], // 1999-01-01
  [2453736.5, 33], // 2006-01-01
  [2454832.5, 34], // 2009-01-01
  [2456109.5, 35], // 2012-07-01
  [2457204.5, 36], // 2015-07-01
  [2457754.5, 37], // 2017-01-01
]

/** TAI - UTC at a UTC Julian date. Older than 1997 is not needed for transit work. */
export function taiMinusUtc(jdUtc: number): number {
  let value = 30
  for (const [jd, seconds] of LEAP_SECONDS) if (jdUtc >= jd) value = seconds
  return value
}

/** TDB - UTC in seconds. TDB - TT is periodic and under 2 ms, so it is dropped. */
export function tdbMinusUtc(jdUtc: number): number {
  return TT_MINUS_TAI + taiMinusUtc(jdUtc)
}

/** Map the archive's free-text time-system labels to something we can convert. */
export function parseTimeSystem(label: string | null | undefined): TimeSystem {
  const s = String(label ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  if (s === 'BJDTDB' || s === 'BJDTBD' || s === 'BJDTT') return 'BJD_TDB'
  // A bare "BJD" is BJD_TDB in practice: Eastman et al. 2010 made it the
  // convention, and the archive uses it for rows that say nothing more.
  if (s === 'BJD') return 'BJD_TDB'
  if (s === 'BJDUTC' || s === 'UTCBJD') return 'BJD_UTC'
  if (s === 'HJDUTC' || s === 'HJD') return 'HJD_UTC'
  if (s === 'HJDTDB') return 'HJD_TDB'
  // "JD", empty, TCB and anything else: we cannot tell barycentric from
  // geocentric, which is an 8-minute ambiguity. Kept, but never trusted first.
  return 'JD_UNKNOWN'
}

/** Unit vector toward a star from J2000 RA/Dec in degrees (ICRS ~ EQJ). */
export function starVector(raDeg: number, decDeg: number): [number, number, number] {
  const ra = (raDeg * Math.PI) / 180
  const dec = (decDeg * Math.PI) / 180
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]
}

function astroTimeFromJdTdb(jdTdb: number) {
  // astronomy-engine takes days since J2000 in UT and applies its own Delta T;
  // the barycentric position moves ~0.0007 AU per minute, so a minute of slop
  // here costs well under a second of light time.
  return MakeTime(jdTdb - JD_J2000 - 69.184 / SECONDS_PER_DAY)
}

/** Light-time from the solar system barycentre to Earth's centre along the star direction, in seconds. */
export function barycentricLightTimeSeconds(jdTdb: number, raDeg: number, decDeg: number): number {
  const earth = BaryState(Body.Earth, astroTimeFromJdTdb(jdTdb))
  const [x, y, z] = starVector(raDeg, decDeg)
  return (earth.x * x + earth.y * y + earth.z * z) * AU_LIGHT_SECONDS
}

/** Light-time from the Sun's centre to Earth's centre along the star direction, in seconds. */
function heliocentricLightTimeSeconds(jdTdb: number, raDeg: number, decDeg: number): number {
  const time = astroTimeFromJdTdb(jdTdb)
  const earth = BaryState(Body.Earth, time)
  const sun = BaryState(Body.Sun, time)
  const [x, y, z] = starVector(raDeg, decDeg)
  return ((earth.x - sun.x) * x + (earth.y - sun.y) * y + (earth.z - sun.z) * z) * AU_LIGHT_SECONDS
}

/**
 * Convert a published midtime to BJD_TDB.
 * Returns null for JD_UNKNOWN: guessing would bake an 8-minute error into the
 * comparison this whole project is about.
 */
export function toBjdTdb(t: number, system: TimeSystem, raDeg: number, decDeg: number): number | null {
  switch (system) {
    case 'BJD_TDB':
      return t
    case 'BJD_UTC':
      return t + tdbMinusUtc(t) / SECONDS_PER_DAY
    case 'HJD_TDB': {
      const helio = heliocentricLightTimeSeconds(t, raDeg, decDeg)
      const bary = barycentricLightTimeSeconds(t, raDeg, decDeg)
      return t + (bary - helio) / SECONDS_PER_DAY
    }
    case 'HJD_UTC': {
      const tdb = t + tdbMinusUtc(t) / SECONDS_PER_DAY
      const helio = heliocentricLightTimeSeconds(tdb, raDeg, decDeg)
      const bary = barycentricLightTimeSeconds(tdb, raDeg, decDeg)
      return tdb + (bary - helio) / SECONDS_PER_DAY
    }
    case 'JD_UNKNOWN':
      return null
  }
}

/**
 * BJD_TDB of an event to the UTC Julian date it is seen at Earth's centre.
 * BJD = JD_geo + (r_earth . n)/c, so JD_geo = BJD - (r_earth . n)/c, iterated
 * once because Earth's position should be taken at the arrival time.
 * The observer's offset from Earth's centre is at most 21 ms and is ignored.
 */
export function bjdTdbToJdUtc(bjdTdb: number, raDeg: number, decDeg: number): number {
  let geoTdb = bjdTdb - barycentricLightTimeSeconds(bjdTdb, raDeg, decDeg) / SECONDS_PER_DAY
  geoTdb = bjdTdb - barycentricLightTimeSeconds(geoTdb, raDeg, decDeg) / SECONDS_PER_DAY
  const approxUtc = geoTdb - 69.184 / SECONDS_PER_DAY
  return geoTdb - tdbMinusUtc(approxUtc) / SECONDS_PER_DAY
}

export function jdToDate(jd: number): Date {
  return new Date((jd - 2440587.5) * SECONDS_PER_DAY * 1000)
}

export function dateToJd(date: Date): number {
  return date.getTime() / (SECONDS_PER_DAY * 1000) + 2440587.5
}
