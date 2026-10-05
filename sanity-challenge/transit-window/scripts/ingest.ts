// NASA Exoplanet Archive + ExoClock -> one normalized dataset.
//
// Fetches when the cache is missing; pass --refresh to refetch.
// Writes data/catalog.json (what the app and eval read) and data/sanity.ndjson
// (what `sanity dataset import` reads).
//
// Two things the archive does that cost an afternoon each, written down so they
// do not cost another:
//   - Cloudflare blocks curl's default user agent with an HTML page and a 200.
//     The response is checked for HTML, not just the status.
//   - The firewall in front of TAP rejects IN (...) lists and % wildcards, so
//     the query pulls every row with an ephemeris and filters here.

import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {Candidate, select} from '../lib/select'
import {parseTimeSystem, toBjdTdb, dateToJd} from '../lib/time'

const root = resolve(import.meta.dirname, '..')
const PS_CACHE = resolve(root, 'data/ps_ephem.csv')
const EXO_CACHE = resolve(root, 'data/exoclock_planets.json')
const refresh = process.argv.includes('--refresh')

const TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'
const COLUMNS = [
  'pl_name', 'hostname', 'ra', 'dec', 'sy_vmag', 'pl_tranmid', 'pl_tranmiderr1', 'pl_tranmiderr2',
  'pl_orbper', 'pl_orbpererr1', 'pl_orbpererr2', 'pl_trandur', 'pl_trandep', 'pl_pubdate',
  'pl_refname', 'pl_tsystemref', 'default_flag', 'disc_refname', 'ttv_flag',
]
const UA = 'transit-window/0.1 (+https://github.com/lgoyal6/transit-window)'

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {headers: {'user-agent': UA}})
  const text = await res.text()
  if (!res.ok || text.trimStart().startsWith('<')) {
    throw new Error(`${url}: HTTP ${res.status}, ${text.slice(0, 80).replace(/\s+/g, ' ')}`)
  }
  return text
}

async function loadArchive(): Promise<string> {
  if (existsSync(PS_CACHE) && !refresh) return readFileSync(PS_CACHE, 'utf8')
  const query = `select ${COLUMNS.join(',')} from ps where pl_tranmid is not null and pl_orbper is not null`
  const csv = await fetchText(`${TAP}?${new URLSearchParams({query, format: 'csv'})}`)
  writeFileSync(PS_CACHE, csv)
  return csv
}

async function loadExoclock(): Promise<Record<string, any>> {
  if (existsSync(EXO_CACHE) && !refresh) return JSON.parse(readFileSync(EXO_CACHE, 'utf8'))
  const json = await fetchText('https://www.exoclock.space/database/planets_json')
  writeFileSync(EXO_CACHE, json)
  return JSON.parse(json)
}

/** Minimal RFC 4180 CSV parser; the archive quotes names and HTML references. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [header, ...body] = rows
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

/** "WASP-12 b", "WASP-12b", "wasp12b" -> "wasp12b". */
export function planetKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s))

/** "<a refstr=KOKORI_ET_AL__2023 href=...>Kokori et al. 2023</a>" -> {label, url}. */
const ENTITIES: Record<string, string> = {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '}
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      if (ENTITIES[name]) return ENTITIES[name]
      // Accented letters: "&ouml;" -> "o" + combining mark, normalized.
      const acc = name.match(/^([a-z])(uml|acute|grave|circ|tilde|cedil|ring|caron)$/i)
      if (!acc) return m
      const mark = {uml: '\u0308', acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', cedil: '\u0327', ring: '\u030A', caron: '\u030C'}[acc[2].toLowerCase() as 'uml']
      return (acc[1] + mark).normalize('NFC')
    })
}

function parseRef(html: string): {label: string; url: string | null; key: string} {
  const label = decodeEntities(html.replace(/<[^>]+>/g, '').trim())
  const url = (html.match(/href=([^ >]+)/) ?? [])[1]?.replace(/^"|"$/g, '') ?? null
  const key = (html.match(/refstr=([^ >]+)/) ?? [])[1] ?? label
  return {label, url, key}
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

function hmsToDeg(hms: string): number {
  const [h, m, s] = hms.split(':').map(Number)
  return (h + m / 60 + s / 3600) * 15
}
function dmsToDeg(dms: string): number {
  const sign = dms.trim().startsWith('-') ? -1 : 1
  const [d, m, s] = dms.replace(/^[+-]/, '').split(':').map(Number)
  return sign * (d + m / 60 + s / 3600)
}

const archiveRows = parseCsv(await loadArchive())
const exoclock = await loadExoclock()
const nowBjd = dateToJd(new Date())

interface PlanetOut {
  key: string
  name: string
  host: string
  raDeg: number
  decDeg: number
  vmag: number | null
  depthMmag: number | null
  durationH: number | null
  minTelescopeIn: number | null
  candidates: (Candidate & {timeSystem: string; sourceUrl: string | null; sourceKey: string})[]
  selection: ReturnType<typeof select>
  exoclock: {residualMin: number; priority: string; recentObservations: number} | null
  /** Archive says this system shows transit timing variations: a linear ephemeris is a poor model. */
  ttv: boolean
}

const byPlanet = new Map<string, Record<string, string>[]>()
for (const r of archiveRows) {
  const k = planetKey(r.pl_name)
  if (!byPlanet.has(k)) byPlanet.set(k, [])
  byPlanet.get(k)!.push(r)
}
const exoByKey = new Map(Object.values(exoclock).map((v: any) => [planetKey(v.name), v]))
const keys = new Set([...byPlanet.keys(), ...exoByKey.keys()])

const planets: PlanetOut[] = []
for (const key of keys) {
  const rows = byPlanet.get(key) ?? []
  const exo = exoByKey.get(key)
  const ref = rows.find((r) => r.default_flag === '1') ?? rows[0]
  const raDeg = exo ? hmsToDeg(exo.ra_j2000) : num(ref?.ra)
  const decDeg = exo ? dmsToDeg(exo.dec_j2000) : num(ref?.dec)
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) continue

  const candidates: PlanetOut['candidates'] = []
  for (const r of rows) {
    const system = parseTimeSystem(r.pl_tsystemref)
    const t0 = toBjdTdb(num(r.pl_tranmid), system, raDeg, decDeg)
    const t0Err = Math.max(Math.abs(num(r.pl_tranmiderr1)), Math.abs(num(r.pl_tranmiderr2)))
    const periodErr = Math.max(Math.abs(num(r.pl_orbpererr1)), Math.abs(num(r.pl_orbpererr2)))
    const refInfo = parseRef(r.pl_refname)
    const usable = t0 !== null && Number.isFinite(t0Err) && Number.isFinite(periodErr)
    candidates.push({
      id: `eph-${key}-${slug(refInfo.key)}`,
      origin: 'archive',
      isArchiveDefault: r.default_flag === '1',
      t0: t0 ?? num(r.pl_tranmid),
      t0Err,
      period: num(r.pl_orbper),
      periodErr,
      usable,
      unusableReason: t0 === null ? 'unknown-time-system' : usable ? undefined : 'no-errors',
      publishedYear: Number((r.pl_pubdate || '').slice(0, 4)) || null,
      citation: refInfo.label,
      timeSystem: r.pl_tsystemref || '(none)',
      sourceUrl: refInfo.url,
      sourceKey: refInfo.key,
    })
  }
  if (exo) {
    candidates.push({
      id: `eph-${key}-exoclock`,
      origin: 'exoclock',
      isArchiveDefault: false,
      t0: exo.ephem_mid_time,
      t0Err: Math.max(Math.abs(exo.ephem_mid_time_e1), Math.abs(exo.ephem_mid_time_e2)),
      period: exo.ephem_period,
      periodErr: Math.max(Math.abs(exo.ephem_period_e1), Math.abs(exo.ephem_period_e2)),
      usable: true,
      publishedYear: null,
      citation:
        exo.ephem_parameters_ref === 'OSF.IO'
          ? 'ExoClock Project (Kokori et al.), current catalogue'
          : `ExoClock catalogue, ephemeris from ${exo.ephem_parameters_ref}`,
      timeSystem: 'BJD_TDB',
      sourceUrl: `https://www.exoclock.space/database/planets/${exo.name}/`,
      sourceKey: exo.ephem_parameters_ref === 'OSF.IO' ? 'EXOCLOCK' : exo.ephem_parameters_ref,
    })
  }
  // Duplicate references for one planet (same paper, two rows) collapse to the first.
  const seen = new Set<string>()
  const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
  if (!unique.length) continue

  const selection = select(unique, nowBjd, exo ? exo.current_oc_min : null)
  planets.push({
    key,
    name: exo ? exo.name : ref.pl_name,
    host: exo ? exo.star : ref.hostname,
    raDeg,
    decDeg,
    vmag: exo?.v_mag ?? (Number.isFinite(num(ref?.sy_vmag)) ? num(ref.sy_vmag) : null),
    depthMmag: exo?.depth_r_mmag ?? null,
    durationH: exo?.duration_hours ?? (Number.isFinite(num(ref?.pl_trandur)) ? num(ref.pl_trandur) : null),
    minTelescopeIn: exo?.min_telescope_inches ?? null,
    candidates: unique,
    selection,
    ttv: rows.some((r) => r.ttv_flag === '1'),
    exoclock: exo
      ? {residualMin: exo.current_oc_min, priority: exo.priority, recentObservations: exo.total_observations_recent}
      : null,
  })
}

planets.sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(
  resolve(root, 'data/catalog.json'),
  JSON.stringify({builtAt: new Date().toISOString(), atBjd: nowBjd, planets}, null, 0),
)
console.log(
  `${planets.length} planets, ${planets.reduce((n, p) => n + p.candidates.length, 0)} ephemerides, ` +
    `${planets.filter((p) => p.exoclock).length} with ExoClock`,
)
