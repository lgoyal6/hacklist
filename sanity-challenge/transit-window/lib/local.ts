// Offline twin of the GROQ projections, built from data/catalog.json. Used by
// tests, the eval's keyword arm, and local development without credentials.
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import type {PlannerPlanet} from './tonight'

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')

export function loadCatalog(path = resolve(process.cwd(), 'data/catalog.json')) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function plannerPlanetsFromCatalog(catalog: any): PlannerPlanet[] {
  const out: PlannerPlanet[] = []
  for (const p of catalog.planets) {
    if (!p.exoclock) continue
    const pick = (c: any) =>
      c && {
        id: c.id,
        t0BjdTdb: c.t0,
        t0ErrDays: Number.isFinite(c.t0Err) ? c.t0Err : null,
        periodDays: c.period,
        periodErrDays: Number.isFinite(c.periodErr) ? c.periodErr : null,
        citation: c.citation,
        origin: c.origin,
        usable: c.usable,
      }
    const chosen = p.candidates.find((c: any) => c.id === p.selection.chosenId)
    const def = p.candidates.find((c: any) => c.isArchiveDefault)
    out.push({
      name: p.name,
      slug: slugOf(p.name),
      raDeg: p.raDeg,
      decDeg: p.decDeg,
      vmag: p.vmag,
      depthMmag: p.depthMmag,
      durationHours: p.durationH,
      minTelescopeInches: p.minTelescopeIn,
      ttv: p.ttv,
      chosen: pick(chosen) ?? null,
      archiveDefault: pick(def) ?? null,
      driftWarning: p.selection.driftWarning,
      residualMin: p.selection.residualMin,
    })
  }
  return out
}
