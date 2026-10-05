// seed/content.ts -> seed/seed.ndjson for `sanity dataset import`.
// Deterministic ids (no dots: dotted ids are private in a public dataset).
// Initial verdicts and statuses are computed with the same checker the
// function uses, marked checkedBy: "seed".
import {check, toLines} from '@lipogram/checker'
import {verdictId} from '@lipogram/engine'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {collections, constraints, poems} from './content'

const now = new Date().toISOString()
const docs: Record<string, unknown>[] = []
const ref = (id: string, key?: string) => ({_type: 'reference', _ref: id, ...(key ? {_key: key} : {})})

for (const c of collections) {
  docs.push({_id: `collection-${c.key}`, _type: 'collection', title: c.title, slug: {_type: 'slug', current: c.key}, mode: c.mode, sandbox: c.sandbox, description: c.description})
}
for (const c of constraints) {
  docs.push({_id: `constraint-${c.key}`, _type: 'constraint', title: c.title, collection: ref(`collection-${c.collection}`), kind: c.kind, params: c.params, description: c.description, version: 1})
}
const byKey = new Map(constraints.map((c) => [c.key, c]))
for (const p of poems) {
  const poemId = `poem-${p.key}`
  let allOk = true
  for (const k of p.constraints) {
    const c = byKey.get(k)!
    const v = check(toLines(p.text), {kind: c.kind as any, params: c.params as any})
    allOk &&= v.ok
    docs.push({
      _id: verdictId(poemId, `constraint-${k}`),
      _type: 'verdict',
      poem: {...ref(poemId), _weak: true},
      constraint: {...ref(`constraint-${k}`), _weak: true},
      constraintVersion: 1,
      ok: v.ok,
      failures: v.failures.map((f, i) => ({_key: `f${i}`, ...f})),
      checkedAt: now,
      checkedBy: 'seed',
    })
  }
  docs.push({
    _id: poemId,
    _type: 'poem',
    title: p.title,
    author: p.author,
    provenance: p.provenance,
    collection: ref(`collection-${p.collection}`),
    constraints: p.constraints.map((k, i) => ref(`constraint-${k}`, `c${i}`)),
    text: p.text,
    status: allOk ? 'valid' : 'violated',
  })
}
writeFileSync(resolve(import.meta.dirname, 'seed.ndjson'), docs.map((d) => JSON.stringify(d)).join('\n') + '\n')
console.log(`${docs.length} documents`)
