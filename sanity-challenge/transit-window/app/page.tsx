import Link from 'next/link'
import {Suspense} from 'react'

import findings from '../data/findings.json'
import {LocalTime} from '../components/LocalTime'
import {SiteForm} from '../components/SiteForm'
import {dataSourceLabel, getPlannerPlanets} from '../lib/sanity'
import {nightWindow, planNight} from '../lib/tonight'

export const dynamic = 'force-dynamic'

function num(v: string | string[] | undefined, fallback: number) {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) ? n : fallback
}

function offsetBadge(offset: number | null, sigma: number | null) {
  if (offset === null) return <span className="badge">no usable NASA default</span>
  const abs = Math.abs(offset)
  const cls = abs >= 10 ? 'bad' : abs >= 5 ? 'warn' : 'good'
  const note = sigma !== null && sigma >= abs && abs >= 5 ? ` (its own error: ±${sigma.toFixed(0)})` : ''
  return <span className={`badge ${cls}`}>{offset > 0 ? '+' : ''}{offset.toFixed(1)} min{note}</span>
}

export default async function Tonight({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const sp = await searchParams
  const site = {latitude: num(sp.lat, 32.8801), longitude: num(sp.lon, -117.234), elevationM: 100}
  const date = typeof sp.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : new Date().toISOString().slice(0, 10)
  // Local solar noon on that date, from longitude: no timezone database needed.
  const localNoon = new Date(Date.parse(`${date}T12:00:00Z`) - (site.longitude / 15) * 3_600_000)
  const window = nightWindow(site, localNoon)
  const planets = await getPlannerPlanets()
  const rows = planNight(planets, site, window, {
    apertureInches: sp.aperture ? num(sp.aperture, 0) : undefined,
    minDepthMmag: sp.depth ? num(sp.depth, 0) : undefined,
  })

  return (
    <>
      <h1>Which transits can you actually see tonight?</h1>
      <p className="lede">
        NASA&apos;s Exoplanet Archive predicts the wrong transit time by 10 minutes or more for{' '}
        <strong>{findings.offBy10Min} of {findings.compared}</strong> planets amateurs can observe. This list uses
        whichever published timing solution holds up against recent observations, and shows what the NASA default would
        have told you. <Link href="/proof">How we know</Link>.
      </p>
      <Suspense><SiteForm /></Suspense>
      <p className="small muted">
        Astronomical dark: <LocalTime iso={window.darkStart.toISOString()} withDate /> to{' '}
        <LocalTime iso={window.darkEnd.toISOString()} withDate />. Full transit plus 30 minutes either side, target
        above 30°, Sun below −12°. {rows.length} transits. Data: {dataSourceLabel}.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Planet</th><th>Ingress</th><th>Mid</th><th>Egress</th><th>±</th><th>Lowest alt</th>
              <th>Depth</th><th>V</th><th>NASA default would say</th><th>Timing from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.planet + r.midUtc}>
                <td>
                  <Link href={`/planet/${r.slug}`}>{r.planet}</Link>
                  {r.driftWarning && <> <span className="badge warn" title="Even the best solution is drifting from recent observations">drifting</span></>}
                </td>
                <td><LocalTime iso={r.ingressUtc} /></td>
                <td><strong><LocalTime iso={r.midUtc} /></strong></td>
                <td><LocalTime iso={r.egressUtc} /></td>
                <td>{Number.isFinite(r.sigmaMin) ? `${r.sigmaMin.toFixed(1)} min` : '?'}</td>
                <td>{r.minAltDeg.toFixed(0)}°</td>
                <td>{r.depthMmag?.toFixed(1) ?? '?'} mmag</td>
                <td>{r.vmag?.toFixed(1) ?? '?'}</td>
                <td>{offsetBadge(r.defaultOffsetMin, r.defaultSigmaMin)}</td>
                <td className="small muted" title={r.source}>{r.source.startsWith('ExoClock') ? 'ExoClock' : r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted">No full transits meet the limits for this night and place.</p>}
    </>
  )
}
