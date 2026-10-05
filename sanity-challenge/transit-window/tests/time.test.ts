import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

import {bjdTdbToJdUtc, parseTimeSystem, toBjdTdb, barycentricLightTimeSeconds} from '../lib/time'
import {sunAltitude, targetAltitude} from '../lib/observe'
import {disagreementMinutes, sigmaAtEpochMinutes} from '../lib/ephemeris'
import {jdToDate} from '../lib/time'

const oracle = JSON.parse(readFileSync(new URL('./fixtures/astropy-oracle.json', import.meta.url), 'utf8'))
const site = {latitude: oracle.site.lat, longitude: oracle.site.lon, elevationM: oracle.site.h}

describe('agrees with astropy', () => {
  it('BJD_TDB to UTC within 2 seconds for 50 planets', () => {
    let worst = 0
    for (const c of oracle.cases) {
      const err = Math.abs(bjdTdbToJdUtc(c.bjdTdb, c.raDeg, c.decDeg) - c.jdUtc) * 86400
      worst = Math.max(worst, err)
    }
    expect(worst).toBeLessThan(2)
  })

  it('barycentric light time within 1 second', () => {
    for (const c of oracle.cases) {
      expect(Math.abs(barycentricLightTimeSeconds(c.bjdTdb, c.raDeg, c.decDeg) - c.lightTimeSec)).toBeLessThan(1)
    }
  })

  it('HJD_UTC to BJD_TDB within 2 seconds', () => {
    for (const c of oracle.cases) {
      const got = toBjdTdb(c.hjdUtcInput, 'HJD_UTC', c.raDeg, c.decDeg)!
      expect(Math.abs(got - c.bjdTdbFromHjdUtc) * 86400).toBeLessThan(2)
    }
  })

  it('target and Sun altitude within 0.1 degree', () => {
    for (const c of oracle.cases) {
      const when = jdToDate(c.jdUtc)
      expect(Math.abs(targetAltitude(site, c.raDeg, c.decDeg, when) - c.altDeg)).toBeLessThan(0.1)
      expect(Math.abs(sunAltitude(site, when) - c.sunAltDeg)).toBeLessThan(0.1)
    }
  })
})

describe('time system labels', () => {
  it('maps archive labels', () => {
    expect(parseTimeSystem('BJD')).toBe('BJD_TDB')
    expect(parseTimeSystem('BJD-TDB')).toBe('BJD_TDB')
    expect(parseTimeSystem('BJD-TBD')).toBe('BJD_TDB')
    expect(parseTimeSystem('HJD')).toBe('HJD_UTC')
    expect(parseTimeSystem('BJD-UTC')).toBe('BJD_UTC')
    expect(parseTimeSystem('JD')).toBe('JD_UNKNOWN')
    expect(parseTimeSystem('')).toBe('JD_UNKNOWN')
  })
  it('refuses to guess an unknown system', () => {
    expect(toBjdTdb(2460000, 'JD_UNKNOWN', 10, 10)).toBeNull()
  })
})

describe('ephemeris arithmetic', () => {
  it('grows uncertainty with epoch', () => {
    const e = {t0: 2455000, t0Err: 0.0002, period: 2.5, periodErr: 2e-6}
    expect(sigmaAtEpochMinutes(e, 0)).toBeCloseTo(0.288, 2)
    expect(sigmaAtEpochMinutes(e, 2500)).toBeCloseTo(7.2, 1)
  })
  it('wraps disagreement to half a period', () => {
    const a = {t0: 2455000, t0Err: 0, period: 2, periodErr: 0}
    const b = {t0: 2455000 + 2 + 10 / 1440, t0Err: 0, period: 2, periodErr: 0}
    expect(disagreementMinutes(a, b, 2460000)).toBeCloseTo(10, 6)
  })
})
