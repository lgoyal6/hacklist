// An in-memory Content Lake for running without a Sanity project: real GROQ
// (groq-js, Sanity's own implementation) over the seed documents, and just
// enough of the transaction API for the recheck engine. The production path
// never touches this; it exists so the site and the sandbox work offline, and
// so the same engine code runs in both.
import {evaluate, parse} from 'groq-js'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import type {LakeClient} from '@lipogram/engine'

type Doc = Record<string, any> & {_id: string}

function load(): Map<string, Doc> {
  const path = resolve(process.cwd(), '../seed/seed.ndjson')
  const docs = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Doc)
  return new Map(docs.map((d) => [d._id, d]))
}

const g = globalThis as unknown as {__lake?: Map<string, Doc>; __lakeListeners?: Set<() => void>}
const store = (g.__lake ??= load())
const listeners = (g.__lakeListeners ??= new Set())

export async function memoryFetch<T = any>(query: string, params: Record<string, unknown> = {}): Promise<T> {
  const tree = parse(query, {params})
  const result = await evaluate(tree, {dataset: [...store.values()], params})
  return (await result.get()) as T
}

export function onMemoryChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function resetMemoryLake() {
  g.__lake = load()
  store.clear()
  for (const [k, v] of g.__lake) store.set(k, v)
  listeners.forEach((fn) => fn())
}

export const memoryLake: LakeClient = {
  fetch: memoryFetch,
  patch(id: string) {
    return {set: (attrs: Record<string, unknown>) => ({id, attrs})}
  },
  transaction() {
    const ops: (() => void)[] = []
    const tx = {
      createOrReplace(doc: any) {
        ops.push(() => store.set(doc._id, structuredClone(doc)))
        return tx
      },
      create(doc: any) {
        ops.push(() => store.set(doc._id, structuredClone(doc)))
        return tx
      },
      patch(p: {id: string; attrs: Record<string, unknown>}) {
        ops.push(() => {
          const d = store.get(p.id)
          if (d) store.set(p.id, {...d, ...structuredClone(p.attrs)})
        })
        return tx
      },
      async commit() {
        ops.forEach((op) => op())
        listeners.forEach((fn) => fn())
        return {}
      },
    }
    return tx
  },
}
