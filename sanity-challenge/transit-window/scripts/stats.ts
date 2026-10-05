// The headline numbers, recomputed from data/catalog.json with the filters
// written next to each one. Nothing in the post is quoted from anywhere else.
//
//   npx tsx scripts/stats.ts [ISO date, default 2026-10-04T06:00:00Z]

import {readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {nearestTransit, sigmaAtEpochMinutes} from '../lib/ephemeris'
import {dateToJd} from '../lib/time'

const root = resolve(import.meta.dirname, '..')
const at = new Date(process.argv[2] ?? '2026-10-04T06:00:00Z')
const atBjd = dateToJd(at)
const {planets} = JSON.parse(readFileSync(resolve(root, 'data/catalog.json'), 'utf8'))

interface Row {
  name: string
  offsetMin: number
  defaultSigmaMin: number
  exoSigmaMin: number
  tension: number
  defaultCitation: string
  defaultYear: number | null
}

const rows: Row[] = []
const excluded = {noExoclock: 0, exoclockNotChosen: 0, ttv: 0, noDefault: 0, defaultUnusable: 0}
for (const p of planets) {
  const exo = p.candidates.find((c: any) => c.origin === 'exoclock')
  if (!exo) { excluded.noExoclock++; continue }
  // Compare against ExoClock only where the selection rule itself trusts it.
  if (p.selection.chosenId !== exo.id) { excluded.exoclockNotChosen++; continue }
  if (p.ttv) { excluded.ttv++; continue }
  const def = p.candidates.find((c: any) => c.isArchiveDefault)
  if (!def) { excluded.noDefault++; continue }
  if (!def.usable) { excluded.defaultUnusable++; continue }
  const e = nearestTransit(exo, atBjd)
  const d = nearestTransit(def, e.mid)
  const offsetMin = (d.mid - e.mid) * 1440
  const defaultSigmaMin = sigmaAtEpochMinutes(def, d.epoch)
  rows.push({
    name: p.name,
    offsetMin,
    defaultSigmaMin,
    exoSigmaMin: e.sigmaMin,
    tension: Math.abs(offsetMin) / Math.hypot(defaultSigmaMin, e.sigmaMin),
    defaultCitation: def.citation,
    defaultYear: def.publishedYear,
  })
}

const abs = rows.map((r) => Math.abs(r.offsetMin)).sort((a, b) => a - b)
const median = abs[Math.floor(abs.length / 2)]
const count = (f: (r: Row) => boolean) => rows.filter(f).length
const findings = {
  at: at.toISOString(),
  population:
    'Planets in both the NASA Exoplanet Archive and ExoClock where the selection rule picks ExoClock ' +
    '(corroborated by another published solution and near the smallest uncertainty), excluding ' +
    'systems the archive flags for transit timing variations, whose archive default solution has a ' +
    'midtime in a known time system and stated errors.',
  compared: rows.length,
  excluded,
  medianAbsOffsetMin: Number(median.toFixed(1)),
  offBy5Min: count((r) => Math.abs(r.offsetMin) >= 5),
  offBy10Min: count((r) => Math.abs(r.offsetMin) >= 10),
  offBy20Min: count((r) => Math.abs(r.offsetMin) >= 20),
  // The strict number: wrong by 10+ minutes AND outside 3 sigma of what the
  // default itself claims, so the default's own error bar does not cover it.
  confidentlyWrong: count((r) => Math.abs(r.offsetMin) >= 10 && r.tension > 3),
  // The default's own propagated error is 10+ minutes: it is honest, but useless tonight.
  selfDeclaredUseless: count((r) => r.defaultSigmaMin >= 10),
  worst: rows
    .filter((r) => Math.abs(r.offsetMin) >= 10 && r.tension > 3)
    .sort((a, b) => Math.abs(b.offsetMin) - Math.abs(a.offsetMin))
    .slice(0, 25)
    .map((r) => ({...r, offsetMin: Number(r.offsetMin.toFixed(1)), defaultSigmaMin: Number(r.defaultSigmaMin.toFixed(1)), tension: Number(r.tension.toFixed(1))})),
}
writeFileSync(resolve(root, 'data/findings.json'), JSON.stringify(findings, null, 2))
console.log(JSON.stringify({...findings, worst: findings.worst.slice(0, 12)}, null, 1))
