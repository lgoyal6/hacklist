import Link from 'next/link'

import {COLLECTIONS, live, query} from '../lib/data'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const cols = await query<any[]>(COLLECTIONS)
  return (
    <>
      <h1>Writing rules, stored as content.</h1>
      <p className="lede">
        A lipogram is a poem that never uses a letter. Here every rule like that is a document in Sanity, and every
        poem points at the rules it keeps. Change a rule and a Sanity Function re-checks every poem that points at it.
        Poems that now break it turn red, and their review workflow moves them to <em>violated</em>. Loosen the rule
        and they come back.
      </p>
      <p className="lede">The same engine is a style guide: swap &ldquo;never use the letter e&rdquo; for &ldquo;never write utilize&rdquo;.</p>
      <div className="grid" style={{marginTop: 24}}>
        {cols.map((c) => (
          <Link key={c._id} href={`/c/${c.slug}`} className="card" style={{textDecoration: 'none', color: 'inherit'}}>
            <h3>{c.title}</h3>
            <p className="byline">{c.sandbox ? 'Sandbox: you can tighten these rules' : 'Read only'} · {c.mode === 'brand' ? 'style guide' : 'poetry'}</p>
            <p>{c.description}</p>
            <p className="ui">{c.pieces} pieces{c.violated ? <>, <span style={{color: 'var(--bad)'}}>{c.violated} breaking a rule</span></> : ', all keeping their rules'}</p>
          </Link>
        ))}
      </div>
      {!live && <p className="preview" style={{marginTop: 24}}>Running offline against the seed data: rule changes are rechecked by the same engine on this server instead of by the Sanity Function.</p>}
    </>
  )
}
