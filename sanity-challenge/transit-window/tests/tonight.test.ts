import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

import {loadCatalog, plannerPlanetsFromCatalog} from '../lib/local'
import {nightWindow, planNight} from '../lib/tonight'

// The observability questions in eval/questions.json were answered by astropy.
// The TypeScript planner must give the same sets.
const questions = JSON.parse(readFileSync(resolve(__dirname, '../eval/questions.json'), 'utf8')).questions
const planets = plannerPlanetsFromCatalog(loadCatalog(resolve(__dirname, '../data/catalog.json')))

describe('planner agrees with the astropy answer key', () => {
  for (const q of questions.filter((q: any) => q.kind === 'observable')) {
    it(`${q.id} ${q.params.night}`, () => {
      const site = {latitude: q.params.site.lat, longitude: q.params.site.lon, elevationM: q.params.site.h}
      const window = {darkStart: new Date(`${q.params.night}T01:00:00Z`), darkEnd: new Date(`${q.params.night}T14:00:00Z`)}
      // Same population as the key: ExoClock-trusted, non-TTV planets.
      const eligible = planets.filter((p) => p.chosen?.origin === 'exoclock' && !p.ttv && p.archiveDefault)
      const rows = planNight(eligible, site, window, {minDepthMmag: q.params.depthMmag, maxVmag: q.params.vmagMax})
      // The key only takes each planet's first transit after the window opens.
      const names = [...new Set(rows.map((r) => r.planet))].sort()
      expect(names).toEqual(q.truth.planets)
    })
  }

  it('finds an astronomical night of sensible length in La Jolla', () => {
    const w = nightWindow({latitude: 32.88, longitude: -117.23, elevationM: 100}, new Date('2026-10-06T19:00:00Z'))
    const hours = (w.darkEnd.getTime() - w.darkStart.getTime()) / 3_600_000
    expect(hours).toBeGreaterThan(9)
    expect(hours).toBeLessThan(11)
  })
})
