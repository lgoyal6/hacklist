// The whole loop in memory: a poem is reviewed and published through the
// workflow, a constraint is tightened, the real recheck engine runs against
// the bench's in-memory Content Lake, ticks the workflow, and the poem's
// instance lands in `violated`. Then the rule is loosened and it comes back.
import {recheckConstraint, tickPoemWorkflows} from '@lipogram/engine'
import {createBench, subjectField} from '@sanity/workflow-engine-test'
import {expect, test} from 'vitest'

import {poemReview} from './poem-review'

const poet = {kind: 'person' as const, id: 'g-pat', roles: ['contributor']}
const editor = {kind: 'person' as const, id: 'g-ed', roles: ['editor']}

test('tightening a constraint moves a published poem to violated, loosening brings it back', async () => {
  const constraint = {_id: 'c-noe', _type: 'constraint', title: 'No e', kind: 'lipogram', params: {letters: 'e'}, version: 1}
  const poem = {
    _id: 'poem-1',
    _type: 'poem',
    title: 'Moon',
    text: 'a moon is full\nits light a calm warm gold',
    constraints: [{_key: 'k1', _type: 'reference', _ref: 'c-noe'}],
    status: 'valid',
  }
  const bench = createBench({now: '2026-10-04T00:00:00.000Z', documents: [constraint, poem, {...poem, _id: 'drafts.poem-1'}]})
  await bench.deployDefinitions({expectedMinReaderModel: 10, definitions: [poemReview]})
  const {instance} = await bench.startInstance({definition: 'poem-review', initialFields: [subjectField('poem-1', {type: 'poem'})]})
  await bench.fireAction({instanceId: instance._id, activity: 'write', action: 'submit', actor: poet})
  await bench.fireAction({instanceId: instance._id, activity: 'decide', action: 'approve', actor: editor})
  expect(await bench.currentStage(instance._id)).toBe('published')

  const where = {projectId: 'test', dataset: 'test'}
  const ticker = {
    instancesForDocument: (args: {document: string}) => bench.instancesForDocument(args as any) as any,
    tick: (args: {instanceId: string}) => bench.tick(args) as any,
  }

  // Tighten: "a" is banned too. The poem is full of a's.
  await bench.client.patch('c-noe').set({params: {letters: 'ea'}}).commit()
  const tightened = await recheckConstraint(bench.client as any, 'c-noe', {by: 'function', fromParams: {letters: 'e'}})
  expect(tightened.broke).toEqual(['poem-1'])
  await tickPoemWorkflows(ticker, where, tightened.broke)
  expect(await bench.currentStage(instance._id)).toBe('violated')

  // Loosen back: the rule-loosened transition returns it to published.
  await bench.client.patch('c-noe').set({params: {letters: 'e'}}).commit()
  const loosened = await recheckConstraint(bench.client as any, 'c-noe', {by: 'function'})
  expect(loosened.fixed).toEqual(['poem-1'])
  await tickPoemWorkflows(ticker, where, loosened.fixed)
  expect(await bench.currentStage(instance._id)).toBe('published')

  const events = await bench.client.fetch('*[_type == "changeEvent"] | order(toVersion asc){toVersion, "broke": count(broke), "fixed": count(fixed)}')
  expect(events).toEqual([{toVersion: 2, broke: 1, fixed: 0}, {toVersion: 3, broke: 0, fixed: 1}])
})
