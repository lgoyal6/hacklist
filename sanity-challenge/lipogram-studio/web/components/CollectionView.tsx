'use client'
// A collection, live. Poem cards show the verdicts the recheck function wrote.
// On sandbox collections, visitors can tighten a rule: the preview counts the
// poems that would break using the same checker the function runs, then the
// change is sent and the page watches for the function's verdicts to land.
import {check, describe, toLines, type Constraint} from '@lipogram/checker'
import Link from 'next/link'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

import {PoemText} from './Poem'

type Verdict = {constraint: string; ok: boolean; constraintVersion: number; failures: any[]}
type PoemRow = {_id: string; title: string; author: string; provenance: string; text: string; status: string; constraints: (Constraint & {_id: string; version: number})[]; verdicts: Verdict[]}
type C = Constraint & {_id: string; title: string; description?: string; version: number; used: number; collectionMode?: string}
type Event = {_id: string; at: string; source: string; fromVersion: number; toVersion: number; constraint: string; poemsChecked: number; broke: string[] | null; fixed: string[] | null; toParams: string}
export type CollectionData = {_id: string; title: string; slug: string; mode: string; sandbox: boolean; description: string; constraints: C[]; poems: PoemRow[]; events: Event[]}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

function wouldBreak(poems: PoemRow[], c: C, params: any) {
  const next = {...c, params}
  return poems.filter((p) => p.constraints?.some((x) => x?._id === c._id) && !check(toLines(p.text), next).ok)
}

function SandboxControl({c, poems, onApply, busy}: {c: C; poems: PoemRow[]; onApply: (id: string, params: any) => void; busy: boolean}) {
  const [draft, setDraft] = useState<any>(c.params)
  useEffect(() => setDraft(c.params), [c._id, c.version, JSON.stringify(c.params)])
  const breaking = useMemo(() => wouldBreak(poems, c, draft), [poems, c, draft])
  const nowBroken = useMemo(() => wouldBreak(poems, c, c.params), [poems, c])
  const changed = JSON.stringify(draft) !== JSON.stringify(c.params)

  let control: React.ReactNode = null
  if (c.kind === 'lipogram') {
    const on = new Set(String(draft.letters ?? ''))
    control = (
      <div className="letters" role="group" aria-label="Banned letters">
        {[...ALPHABET].map((l) => (
          <button
            key={l}
            className={on.has(l) ? 'on' : ''}
            aria-pressed={on.has(l)}
            onClick={() => {
              const next = new Set(on)
              next.has(l) ? next.delete(l) : next.add(l)
              if (next.size === 0 || next.size > 8) return
              setDraft({letters: [...next].sort().join('')})
            }}
          >
            {l}
          </button>
        ))}
      </div>
    )
  } else if (c.kind === 'maxLineLength') {
    control = (
      <label className="ui">
        {draft.maxChars} characters per line
        <input type="range" min={12} max={c.collectionMode === 'brand' ? 140 : 80} value={draft.maxChars} onChange={(e) => setDraft({maxChars: Number(e.target.value)})} />
      </label>
    )
  } else if (c.kind === 'lineCount') {
    control = (
      <label className="ui">
        at most {draft.maxLines} lines
        <input type="range" min={1} max={20} value={draft.maxLines} onChange={(e) => setDraft({minLines: 1, maxLines: Number(e.target.value)})} />
      </label>
    )
  } else if (c.kind === 'bannedWords') {
    control = <BannedWords words={draft.words ?? []} onChange={(words) => setDraft({words})} />
  }

  return (
    <div>
      <strong>{c.title}</strong> <span className="badge">v{c.version}</span>
      <div className="preview">{describe({...c, params: draft})}</div>
      {control ?? <p className="preview">Not editable from the site.</p>}
      {control && (
        <div className="preview" style={{marginTop: 8}}>
          {changed ? (
            <>
              <strong>{breaking.length}</strong> of {c.used} would break
              {breaking.length !== nowBroken.length && <> (now {nowBroken.length})</>}.{' '}
              <button className="primary" disabled={busy} onClick={() => onApply(c._id, draft)}>Apply</button>{' '}
              <button onClick={() => setDraft(c.params)} disabled={busy}>Undo</button>
            </>
          ) : (
            <>{nowBroken.length} of {c.used} break it now.</>
          )}
        </div>
      )}
    </div>
  )
}

function BannedWords({words, onChange}: {words: string[]; onChange: (w: string[]) => void}) {
  const [input, setInput] = useState('')
  return (
    <div className="ui">
      {words.map((w) => (
        <button key={w} className="badge" onClick={() => onChange(words.filter((x) => x !== w))} title="Remove">{w} ×</button>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); const w = input.trim().toLowerCase(); if (w && !words.includes(w) && words.length < 20) onChange([...words, w]); setInput('') }} style={{marginTop: 6}}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ban a word" size={14} />
      </form>
    </div>
  )
}

export function CollectionView({initial}: {initial: CollectionData}) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const prev = useRef(new Map(initial.poems.map((p) => [p._id, p.status])))

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/collection/${initial.slug}`, {cache: 'no-store'})
    if (!res.ok) return null
    const next: CollectionData = await res.json()
    const flipped = new Set(next.poems.filter((p) => prev.current.get(p._id) !== p.status).map((p) => p._id))
    prev.current = new Map(next.poems.map((p) => [p._id, p.status]))
    if (flipped.size) {
      setFlash(flipped)
      setTimeout(() => setFlash(new Set()), 900)
    }
    setData(next)
    return next
  }, [initial.slug])

  useEffect(() => {
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  async function apply(constraintId: string, params: any) {
    setBusy(true)
    setStatus('Sending the new rule…')
    const before = data.constraints.find((c) => c._id === constraintId)?.version ?? 0
    try {
      const res = await fetch('/api/sandbox', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({constraintId, params})})
      const body = await res.json()
      if (!res.ok) {
        setStatus(body.error ?? 'Refused.')
        return
      }
      setStatus(body.mode === 'function' ? 'Rule saved. Waiting for the recheck function…' : 'Rule saved. Rechecking…')
      const started = Date.now()
      // Watch for the function's work: the constraint's version moves when it runs.
      for (let i = 0; i < 40; i++) {
        const next = await refresh()
        const c = next?.constraints.find((x) => x._id === constraintId)
        if (c && c.version > before) {
          const ev = next!.events[0]
          setStatus(
            `Rechecked ${ev?.poemsChecked ?? '?'} poems in ${((Date.now() - started) / 1000).toFixed(1)} s: ` +
              `${ev?.broke?.length ?? 0} broke, ${ev?.fixed?.length ?? 0} recovered.`,
          )
          return
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      setStatus('The rule was saved, but no recheck arrived yet. Refresh in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const violated = data.poems.filter((p) => p.status === 'violated').length
  const noun = data.mode === 'brand' ? 'pieces' : 'poems'

  return (
    <>
      <h1>{data.title}</h1>
      <p className="lede">{data.description}</p>
      <p className="ui">{data.poems.length} {noun}, <strong style={{color: 'var(--bad)'}}>{violated} breaking a rule</strong>.</p>

      <div className="panel">
        <div className="controls ui">
          {data.constraints.map((c) =>
            data.sandbox ? (
              <SandboxControl key={c._id} c={{...c, collectionMode: data.mode} as any} poems={data.poems} onApply={apply} busy={busy} />
            ) : (
              <div key={c._id}>
                <strong>{c.title}</strong> <span className="badge">v{c.version}</span>
                <div className="preview">{describe(c)}. Used by {c.used}.</div>
              </div>
            ),
          )}
        </div>
        <div className="status" aria-live="polite" style={{marginTop: 10}}>{status}</div>
      </div>

      <div className="grid">
        {data.poems.map((p) => {
          const failures = (p.verdicts ?? []).filter((v) => !v.ok).flatMap((v) => v.failures ?? [])
          const brokenRules = (p.verdicts ?? []).filter((v) => !v.ok).map((v) => p.constraints?.find((c) => c?._id === v.constraint)?.title).filter(Boolean)
          return (
            <article key={p._id} className={`card ${p.status === 'violated' ? 'violated' : ''} ${flash.has(p._id) ? 'flash' : ''}`}>
              <h3><Link href={`/p/${p._id}`}>{p.title}</Link></h3>
              <div className="byline">{p.author} · {p.provenance}</div>
              <PoemText text={p.text} failures={failures} />
              <div>
                {(p.constraints ?? []).filter(Boolean).map((c) => {
                  const ok = !brokenRules.includes(c.title)
                  return <span key={c._id} className={`badge ${ok ? 'good' : 'bad'}`}>{ok ? '✓' : '✗'} {c.title}</span>
                })}
              </div>
            </article>
          )
        })}
      </div>

      <h2>What changed</h2>
      <ul className="events">
        {data.events.length === 0 && <li className="preview">No rule changes yet.</li>}
        {data.events.map((e) => (
          <li key={e._id}>
            <strong>{e.constraint}</strong> v{e.fromVersion}→v{e.toVersion} via {e.source}, {new Date(e.at).toLocaleString()}:{' '}
            {e.poemsChecked} checked
            {e.broke?.length ? <>, <span style={{color: 'var(--bad)'}}>broke {e.broke.join(', ')}</span></> : null}
            {e.fixed?.length ? <>, <span style={{color: 'var(--good)'}}>recovered {e.fixed.join(', ')}</span></> : null}
          </li>
        ))}
      </ul>
    </>
  )
}
