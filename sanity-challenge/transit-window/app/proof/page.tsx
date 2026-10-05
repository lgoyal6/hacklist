import Link from 'next/link'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import findings from '../../data/findings.json'

export const dynamic = 'force-static'

async function evalResults(): Promise<any | null> {
  try {
    return JSON.parse(await readFile(resolve(process.cwd(), 'eval/results.json'), 'utf8'))
  } catch {
    return null
  }
}

export default async function Proof() {
  const results = await evalResults()
  return (
    <>
      <h1>How we know</h1>
      <p className="lede">Every number on this page is recomputed by a script in the repository. The filters are written next to each one.</p>

      <h2>1. The NASA default is often wrong tonight</h2>
      <p className="small muted">{findings.population} Evaluated at {findings.at}. Script: <code>scripts/stats.ts</code>.</p>
      <div className="stats">
        <div className="panel stat"><div className="n">{findings.compared}</div><div className="l">planets compared</div></div>
        <div className="panel stat"><div className="n">{findings.offBy10Min}</div><div className="l">NASA default off by 10+ min</div></div>
        <div className="panel stat"><div className="n">{findings.offBy20Min}</div><div className="l">off by 20+ min</div></div>
        <div className="panel stat"><div className="n">{findings.confidentlyWrong}</div><div className="l">off by 10+ min and outside 3σ of its own stated error</div></div>
        <div className="panel stat"><div className="n">{findings.medianAbsOffsetMin} min</div><div className="l">median disagreement</div></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Planet</th><th>NASA default minus chosen</th><th>Default&apos;s own ±</th><th>Tension</th><th>Default cites</th></tr></thead>
          <tbody>
            {findings.worst.map((r: any) => (
              <tr key={r.name}>
                <td><Link href={`/planet/${r.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`}>{r.name}</Link></td>
                <td>{r.offsetMin > 0 ? '+' : ''}{r.offsetMin} min</td>
                <td>{r.defaultSigmaMin} min</td>
                <td>{r.tension}σ</td>
                <td className="wrap">{r.defaultCitation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        XO-3b tops the list for a reason worth knowing: the archive&apos;s default row gives a reference midtime of
        2457424.98786, while the paper it cites (Rusznak et al., arXiv:2412.04438, fitted-parameter table) states
        2457417.98762, seven days earlier. Seven days is not a whole number of 3.19-day orbits, so every prediction
        made from the default is about 15 hours off.
      </p>

      <h2>2. The timing engine agrees with astropy</h2>
      <p className="small">
        The TypeScript engine that runs this site is checked against an independent astropy implementation for 50
        planets: BJD_TDB to UTC within 0.03 s, HJD_UTC to BJD_TDB within 0.03 s, altitudes within 0.006°. The
        observable-tonight lists for six nights match astropy exactly. Tests: <code>tests/</code>.
      </p>

      <h2>3. The agent against keyword search and against no data</h2>
      {results ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Question kind</th>{results.arms.map((a: any) => <th key={a.name}>{a.label}</th>)}</tr></thead>
            <tbody>
              {results.kinds.map((k: string) => (
                <tr key={k}>
                  <td>{k}</td>
                  {results.arms.map((a: any) => <td key={a.name}>{a.byKind[k].correct}/{a.byKind[k].total}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">The evaluation has not been run against the live endpoints yet. <code>npm run eval</code>.</p>
      )}
    </>
  )
}
