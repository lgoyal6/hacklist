import Link from 'next/link'
import {notFound} from 'next/navigation'

import {getPlanetDetail} from '../../../lib/sanity'

export const dynamic = 'force-dynamic'

const verdictClass: Record<string, string> = {chosen: 'good', consistent: '', stale: 'bad', unusable: 'warn'}

/** Offset from the chosen solution (y) against publication year (x), with 1-sigma bars. */
function TimingChart({solutions}: {solutions: any[]}) {
  const pts = solutions.filter((s) => s.assessment && Number.isFinite(s.assessment.offsetMin) && s.publishedYear)
  if (pts.length < 2) return null
  const W = 720, H = 260, pad = 44
  const years = pts.map((p) => p.publishedYear)
  const x0 = Math.min(...years) - 1, x1 = Math.max(...years, new Date().getFullYear()) + 1
  const lim = Math.min(240, Math.max(15, ...pts.map((p) => Math.abs(p.assessment.offsetMin) + Math.min(p.assessment.sigmaMin ?? 0, 60))))
  const sx = (y: number) => pad + ((y - x0) / (x1 - x0)) * (W - 2 * pad)
  const sy = (m: number) => H / 2 - (Math.max(-lim, Math.min(lim, m)) / lim) * (H / 2 - 20)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Predicted midtime tonight from each published solution">
      <line x1={pad} x2={W - pad} y1={sy(0)} y2={sy(0)} stroke="#6fd39b" strokeDasharray="4 4" />
      <text x={W - pad} y={sy(0) - 6} fill="#6fd39b" fontSize="11" textAnchor="end">chosen solution</text>
      {[-lim, -lim / 2, lim / 2, lim].map((m) => (
        <text key={m} x={6} y={sy(m) + 4} fill="#9aa3b5" fontSize="11">{m > 0 ? '+' : ''}{m.toFixed(0)}m</text>
      ))}
      {pts.map((p) => {
        const s = Math.min(p.assessment.sigmaMin ?? 0, lim * 2)
        const color = p.isArchiveDefault ? '#ff6b6b' : p.assessment.verdict === 'stale' ? '#ffb454' : '#7cc4ff'
        return (
          <g key={p.id}>
            <line x1={sx(p.publishedYear)} x2={sx(p.publishedYear)} y1={sy(p.assessment.offsetMin - s)} y2={sy(p.assessment.offsetMin + s)} stroke={color} opacity={0.6} />
            {Math.abs(p.assessment.offsetMin) > lim && (
              <text x={sx(p.publishedYear) - 10} y={sy(p.assessment.offsetMin) + (p.assessment.offsetMin > 0 ? 16 : -10)} fill={color} fontSize="11" textAnchor="end">
                off chart: {p.assessment.offsetMin > 0 ? '+' : ''}{p.assessment.offsetMin.toFixed(0)} min
              </text>
            )}
            <circle cx={sx(p.publishedYear)} cy={sy(p.assessment.offsetMin)} r={p.isArchiveDefault ? 6 : 4} fill={color}>
              <title>{`${p.source?.citation}: ${p.assessment.offsetMin.toFixed(1)} min${p.isArchiveDefault ? ' (NASA default)' : ''}`}</title>
            </circle>
          </g>
        )
      })}
      {Array.from({length: Math.floor(x1) - Math.ceil(x0) + 1}, (_, i) => Math.ceil(x0) + i).filter((y) => y % 2 === 0).map((y) => (
        <text key={y} x={sx(y)} y={H - 6} fill="#9aa3b5" fontSize="11" textAnchor="middle">{y}</text>
      ))}
    </svg>
  )
}

export default async function PlanetPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const p = await getPlanetDetail(slug)
  if (!p) notFound()
  const sel = p.selection ?? {}
  return (
    <>
      <p className="small"><Link href="/">Tonight</Link></p>
      <h1>{p.name}</h1>
      <p className="lede">
        Host {p.star?.name}, V = {p.star?.vmag ?? '?'}. Depth {p.depthMmag ?? '?'} mmag, duration {p.durationHours ?? '?'} h.
        {p.minTelescopeInches ? ` ExoClock suggests at least a ${p.minTelescopeInches} inch telescope.` : ''}
        {p.ttv ? ' This system shows transit timing variations, so no straight-line ephemeris is reliable.' : ''}
      </p>
      <div className="panel">
        <strong>Timing used:</strong> {p.solutions.find((s: any) => s.id === p.chosenId)?.source?.citation ?? 'none'}{' '}
        <span className="badge good">{sel.rule}</span>
        <p className="small">{sel.reason}</p>
        {typeof sel.defaultOffsetMin === 'number' && (
          <p className="small">
            The NASA Exoplanet Archive default disagrees by <strong>{sel.defaultOffsetMin.toFixed(1)} minutes</strong> at the
            next transit ({sel.defaultVerdict}).
          </p>
        )}
        {sel.driftWarning && (
          <p className="small"><span className="badge warn">drifting</span> ExoClock&apos;s latest residual is {sel.residualMin} min: even the best solution is falling behind recent transits.</p>
        )}
      </div>
      <h2>Every published solution, predicted forward to tonight</h2>
      <p className="small muted">Each dot is one paper or catalogue. Height is how far its prediction for the next transit sits from the chosen solution; bars are its own 1-sigma at that date. Red is the NASA default.</p>
      <div className="panel"><TimingChart solutions={p.solutions} /></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Source</th><th>Year</th><th>Time system</th><th>Offset</th><th>Own ±</th><th>Verdict</th></tr></thead>
          <tbody>
            {p.solutions.map((s: any) => (
              <tr key={s.id}>
                <td className="wrap">
                  {s.source?.url ? <a href={s.source.url}>{s.source.citation}</a> : s.source?.citation}
                  {s.isArchiveDefault && <> <span className="badge bad">NASA default</span></>}
                </td>
                <td>{s.publishedYear ?? ''}</td>
                <td>{s.timeSystemAsPublished}</td>
                <td>{s.assessment && Number.isFinite(s.assessment.offsetMin) ? `${s.assessment.offsetMin > 0 ? '+' : ''}${s.assessment.offsetMin.toFixed(1)} min` : ''}</td>
                <td>{s.assessment && Number.isFinite(s.assessment.sigmaMin) ? `${s.assessment.sigmaMin.toFixed(1)} min` : 'not stated'}</td>
                <td><span className={`badge ${verdictClass[s.assessment?.verdict] ?? ''}`}>{s.assessment?.verdict ?? ''}</span>{s.unusableReason && <span className="small muted"> {s.unusableReason}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
