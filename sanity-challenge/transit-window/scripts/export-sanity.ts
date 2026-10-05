// data/catalog.json -> data/sanity.ndjson for `sanity dataset import`.
//
// Scope: the planets ExoClock monitors (776), every published ephemeris for
// them, their stars and their sources: about 7,500 documents, inside the free
// plan's 10,000. These are the targets an amateur can actually observe; the
// other 4,300 archive planets are mostly too faint or too shallow.
//
// IDs are deterministic, so re-importing with --replace updates in place.

import {readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const root = resolve(import.meta.dirname, '..')
const {planets, atBjd} = JSON.parse(readFileSync(resolve(root, 'data/catalog.json'), 'utf8'))

const docs: Record<string, unknown>[] = []
const idSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
const finite = (n: number) => (Number.isFinite(n) ? n : undefined)
const sources = new Map<string, Record<string, unknown>>()
const stars = new Map<string, Record<string, unknown>>()

for (const p of planets) {
  if (!p.exoclock) continue
  const planetId = `planet-${idSafe(p.key)}`
  const starId = `star-${idSafe(p.host)}`
  if (!stars.has(starId)) {
    stars.set(starId, {_id: starId, _type: 'star', name: p.host, raDeg: p.raDeg, decDeg: p.decDeg, vmag: p.vmag ?? undefined})
  }
  const assessments = new Map(p.selection.assessments.map((a: any) => [a.candidateId, a]))
  const def = p.candidates.find((c: any) => c.isArchiveDefault)
  const defA: any = def ? assessments.get(def.id) : undefined

  for (const c of p.candidates) {
    const sourceId = `source-${idSafe(c.sourceKey)}`
    if (!sources.has(sourceId)) {
      sources.set(sourceId, {
        _id: sourceId,
        _type: 'source',
        citation: c.citation,
        kind: c.origin === 'exoclock' ? 'catalogue' : /exofop/i.test(c.citation) ? 'database' : 'paper',
        year: c.publishedYear ?? undefined,
        url: c.sourceUrl ?? undefined,
        archiveKey: c.sourceKey,
      })
    }
    const a: any = assessments.get(c.id)
    docs.push({
      _id: idSafe(c.id),
      _type: 'ephemeris',
      planet: {_type: 'reference', _ref: planetId},
      source: {_type: 'reference', _ref: sourceId},
      origin: c.origin,
      isArchiveDefault: c.isArchiveDefault,
      t0BjdTdb: c.t0,
      t0ErrDays: finite(c.t0Err),
      periodDays: c.period,
      periodErrDays: finite(c.periodErr),
      timeSystemAsPublished: c.timeSystem,
      usable: c.usable,
      unusableReason: c.unusableReason,
      publishedYear: c.publishedYear ?? undefined,
      assessment: a
        ? {
            verdict: a.verdict,
            offsetMin: finite(a.offsetMin),
            sigmaMin: finite(a.sigmaMin),
            tension: a.tension ?? undefined,
            atBjd,
          }
        : undefined,
    })
  }

  docs.push({
    _id: planetId,
    _type: 'planet',
    name: p.name,
    slug: {_type: 'slug', current: idSafe(p.name)},
    star: {_type: 'reference', _ref: starId},
    depthMmag: p.depthMmag ?? undefined,
    durationHours: p.durationH ?? undefined,
    minTelescopeInches: p.minTelescopeIn ?? undefined,
    ttv: p.ttv,
    chosenEphemeris: p.selection.chosenId ? {_type: 'reference', _ref: idSafe(p.selection.chosenId)} : undefined,
    selection: {
      rule: p.selection.rule,
      reason: p.selection.reason,
      corroboration: p.selection.corroboration,
      driftWarning: p.selection.driftWarning,
      residualMin: p.selection.residualMin ?? undefined,
      defaultOffsetMin: defA ? finite(defA.offsetMin) : undefined,
      defaultVerdict: defA ? defA.verdict : 'no-default',
    },
    exoclock: {
      priority: p.exoclock.priority,
      recentObservations: p.exoclock.recentObservations,
      url: `https://www.exoclock.space/database/planets/${p.name}/`,
    },
  })
}

const all = [...stars.values(), ...sources.values(), ...docs]
writeFileSync(resolve(root, 'data/sanity.ndjson'), all.map((d) => JSON.stringify(d)).join('\n') + '\n')
const count = (t: string) => all.filter((d) => d._type === t).length
console.log(
  `${all.length} documents: ${count('planet')} planets, ${count('star')} stars, ` +
    `${count('ephemeris')} ephemerides, ${count('source')} sources`,
)

// A slim copy of the planner projection for local development and as a
// fallback when the dataset is unreachable. Same shape as plannerPlanetsQuery.
import {plannerPlanetsFromCatalog} from '../lib/local'
const fixture = plannerPlanetsFromCatalog(JSON.parse(readFileSync(resolve(root, 'data/catalog.json'), 'utf8')))
writeFileSync(resolve(root, 'data/planner-fixture.json'), JSON.stringify(fixture))
console.log(`planner fixture: ${fixture.length} planets`)

// Per-planet detail fixtures, same shape as planetDetailQuery.
import {mkdirSync} from 'node:fs'
const detailDir = resolve(root, 'data/planet-details')
mkdirSync(detailDir, {recursive: true})
const catalogAgain = JSON.parse(readFileSync(resolve(root, 'data/catalog.json'), 'utf8'))
for (const p of catalogAgain.planets) {
  if (!p.exoclock) continue
  const assess = new Map(p.selection.assessments.map((a: any) => [a.candidateId, a]))
  const def = p.candidates.find((c: any) => c.isArchiveDefault)
  const defA: any = def ? assess.get(def.id) : undefined
  const detail = {
    name: p.name,
    slug: idSafe(p.name),
    star: {name: p.host, raDeg: p.raDeg, decDeg: p.decDeg, vmag: p.vmag},
    depthMmag: p.depthMmag,
    durationHours: p.durationH,
    minTelescopeInches: p.minTelescopeIn,
    ttv: p.ttv,
    selection: {
      ...p.selection,
      assessments: undefined,
      defaultOffsetMin: defA ? finite(defA.offsetMin) ?? null : null,
      defaultVerdict: defA ? defA.verdict : 'no-default',
    },
    exoclock: {...p.exoclock, url: `https://www.exoclock.space/database/planets/${p.name}/`},
    chosenId: p.selection.chosenId ? idSafe(p.selection.chosenId) : null,
    solutions: [...p.candidates]
      .sort((a: any, b: any) => (b.publishedYear ?? 3000) - (a.publishedYear ?? 3000))
      .map((c: any) => {
        const a: any = assess.get(c.id)
        return {
          id: idSafe(c.id),
          origin: c.origin,
          isArchiveDefault: c.isArchiveDefault,
          t0BjdTdb: c.t0,
          t0ErrDays: finite(c.t0Err) ?? null,
          periodDays: c.period,
          periodErrDays: finite(c.periodErr) ?? null,
          timeSystemAsPublished: c.timeSystem,
          usable: c.usable,
          unusableReason: c.unusableReason ?? null,
          publishedYear: c.publishedYear,
          assessment: a ? {verdict: a.verdict, offsetMin: finite(a.offsetMin) ?? null, sigmaMin: finite(a.sigmaMin) ?? null, tension: a.tension ?? null} : null,
          source: {citation: c.citation, url: c.sourceUrl, kind: c.origin === 'exoclock' ? 'catalogue' : 'paper', year: c.publishedYear},
        }
      }),
  }
  writeFileSync(resolve(detailDir, `${detail.slug}.json`), JSON.stringify(detail))
}
console.log('planet detail fixtures written')
