import {describe} from '@lipogram/checker'
import Link from 'next/link'
import {notFound} from 'next/navigation'

import {PoemText} from '../../../components/Poem'
import {POEM, query} from '../../../lib/data'

export const dynamic = 'force-dynamic'

export default async function PoemPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params
  const p = await query<any>(POEM, {id})
  if (!p) notFound()
  const verdictFor = (cid: string) => p.verdicts.find((v: any) => v.constraint === cid)
  const failures = p.verdicts.filter((v: any) => !v.ok).flatMap((v: any) => v.failures ?? [])
  return (
    <>
      <p className="ui"><Link href={`/c/${p.collection.slug}`}>{p.collection.title}</Link></p>
      <h1>{p.title}</h1>
      <div className="byline">{p.author} · {p.provenance}</div>
      <div className="panel"><PoemText text={p.text} failures={failures} /></div>
      <h2>Rules it keeps</h2>
      <ul className="events">
        {p.constraints.filter(Boolean).map((c: any) => {
          const v = verdictFor(c._id)
          return (
            <li key={c._id}>
              <span className={`badge ${v?.ok === false ? 'bad' : 'good'}`}>{v?.ok === false ? '✗' : '✓'}</span>
              <strong>{c.title}</strong> v{c.version}: {describe(c)}
              {v && <span className="preview"> · checked against v{v.constraintVersion} by {v.checkedBy}</span>}
              {v?.ok === false && (
                <ul>
                  {v.failures.slice(0, 10).map((f: any, i: number) => (
                    <li key={i} className="preview">{f.line >= 0 ? `Line ${f.line + 1}` : 'Whole poem'}: {f.message}</li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
