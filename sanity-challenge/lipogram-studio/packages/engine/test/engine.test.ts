import {describe, expect, it} from 'vitest'

import {recheckConstraint, type LakeClient} from '../src/index'

/** An in-memory Content Lake good enough for the queries the engine runs. */
function fakeLake(docs: Record<string, any>) {
  const writes: any[] = []
  const client: LakeClient = {
    async fetch(query: string, params: any = {}): Promise<any> {
      if (query.startsWith('*[_id == $id][0]{_id, version, params}')) {
        const d = docs[params.id]
        return d ? {_id: d._id, version: d.version, params: d.params} : null
      }
      if (query.includes('references($id)')) {
        return Object.values(docs)
          .filter((d: any) => d._type === 'poem' && d.constraints?.some((r: any) => r._ref === params.id))
          .map((p: any) => ({
            _id: p._id,
            title: p.title,
            text: p.text,
            constraints: p.constraints.map((r: any) => docs[r._ref]),
            previous: Object.values(docs)
              .filter((v: any) => v._type === 'verdict' && v.poem._ref === p._id)
              .map((v: any) => ({constraintId: v.constraint._ref, ok: v.ok})),
          }))
      }
      throw new Error('unexpected query ' + query)
    },
    patch(id: string) {
      return {set: (attrs: any) => ({id, attrs})}
    },
    transaction() {
      const ops: any[] = []
      const tx = {
        createOrReplace: (d: any) => (ops.push(['put', d]), tx),
        create: (d: any) => (ops.push(['create', d]), tx),
        patch: (p: any) => (ops.push(['patch', p.id, {set: p.attrs}]), tx),
        commit: async () => {
          for (const op of ops) {
            writes.push(op)
            if (op[0] === 'put') docs[op[1]._id] = op[1]
            if (op[0] === 'patch' && docs[op[1]]) Object.assign(docs[op[1]], op[2].set)
          }
          return {}
        },
      }
      return tx
    },
  }
  return {client, docs, writes}
}

describe('recheckConstraint', () => {
  it('flips poems that now break, records the blast radius, and bumps the version', async () => {
    const lake = fakeLake({
      'c-noe': {_id: 'c-noe', _type: 'constraint', title: 'No e', kind: 'lipogram', params: {letters: 'e'}, version: 1},
      'p-ok': {_id: 'p-ok', _type: 'poem', title: 'Moon', text: 'a moon is full', constraints: [{_ref: 'c-noe'}]},
      'p-a': {_id: 'p-a', _type: 'poem', title: 'Sun', text: 'a sun at noon', constraints: [{_ref: 'c-noe'}]},
    })
    // Tighten: now "a" is banned too.
    lake.docs['c-noe'].params = {letters: 'ea'}
    const r = await recheckConstraint(lake.client, 'c-noe', {by: 'function', fromParams: {letters: 'e'}, now: '2026-10-04T00:00:00Z'})
    expect(r.toVersion).toBe(2)
    expect(r.poemsChecked).toBe(2)
    expect(r.broke.sort()).toEqual(['p-a', 'p-ok'])
    expect(lake.docs['p-a'].status).toBe('violated')
    expect(lake.docs['verdict-p-a-c-noe']).toMatchObject({ok: false, constraintVersion: 2})
    const event = lake.writes.find((w) => w[0] === 'put' && w[1]._type === 'changeEvent')[1]
    expect(event).toMatchObject({_type: 'changeEvent', fromVersion: 1, toVersion: 2, poemsChecked: 2})
    expect(event.broke).toHaveLength(2)

    // Loosen again: both come back.
    lake.docs['c-noe'].params = {letters: 'e'}
    const r2 = await recheckConstraint(lake.client, 'c-noe', {by: 'function'})
    expect(r2.fixed.sort()).toEqual(['p-a', 'p-ok'])
    expect(lake.docs['p-ok'].status).toBe('valid')
  })

  it('never writes the fields its own trigger watches', async () => {
    const lake = fakeLake({
      c: {_id: 'c', _type: 'constraint', kind: 'lipogram', params: {letters: 'z'}, version: 3},
      p: {_id: 'p', _type: 'poem', text: 'zebra', constraints: [{_ref: 'c'}]},
    })
    await recheckConstraint(lake.client, 'c', {by: 'function'})
    const patches = lake.writes.filter((w) => w[0] === 'patch').map((w) => Object.keys(w[2].set))
    // Function filters fire on constraint.params and poem.text/constraints only.
    expect(patches.flat().sort()).toEqual(['status', 'version'])
  })
})
