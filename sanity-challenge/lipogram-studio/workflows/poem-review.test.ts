import type {Actor} from '@sanity/workflow-engine'
import {createBench, subjectField} from '@sanity/workflow-engine-test'
import {expect, test} from 'vitest'

import {poemReview} from './poem-review'

const poet: Actor = {kind: 'person', id: 'g-pat', roles: ['contributor']}
const editor: Actor = {kind: 'person', id: 'g-ed', roles: ['editor']}
const system: Actor = {kind: 'system', id: 'g-recheck-function', roles: []}

async function start(status: 'valid' | 'violated' | 'unchecked' = 'unchecked') {
  const poem = {_id: 'poem-1', _type: 'poem', title: 'Moon', text: 'a moon is full', status}
  const bench = createBench({now: '2026-10-04T00:00:00.000Z', documents: [poem, {...poem, _id: 'drafts.poem-1'}]})
  await bench.deployDefinitions({expectedMinReaderModel: 10, definitions: [poemReview]})
  const {instance} = await bench.startInstance({definition: 'poem-review', initialFields: [subjectField('poem-1', {type: 'poem'})]})
  return {bench, id: instance._id}
}

/** What the recheck function does: write status, then tick. */
async function setStatus(bench: Awaited<ReturnType<typeof start>>['bench'], id: string, status: string) {
  await bench.editDocument({documentId: 'drafts.poem-1', patch: {set: {status}}})
  return bench.tick({instanceId: id, actor: system})
}

test('a valid poem goes drafting -> checking -> review -> published', async () => {
  const {bench, id} = await start('valid')
  await bench.fireAction({instanceId: id, activity: 'write', action: 'submit', actor: poet})
  expect(await bench.currentStage(id)).toBe('review')
  await bench.fireAction({instanceId: id, activity: 'decide', action: 'approve', actor: editor})
  expect(await bench.currentStage(id)).toBe('published')
})

test('a broken poem goes back to drafting from the check', async () => {
  const {bench, id} = await start('violated')
  await bench.fireAction({instanceId: id, activity: 'write', action: 'submit', actor: poet})
  expect(await bench.currentStage(id)).toBe('drafting')
})

test('a published poem falls into violated when a rule tightens, and returns when it loosens', async () => {
  const {bench, id} = await start('valid')
  await bench.fireAction({instanceId: id, activity: 'write', action: 'submit', actor: poet})
  await bench.fireAction({instanceId: id, activity: 'decide', action: 'approve', actor: editor})
  await setStatus(bench, id, 'violated')
  expect(await bench.currentStage(id)).toBe('violated')
  await setStatus(bench, id, 'valid')
  expect(await bench.currentStage(id)).toBe('published')
})

test('only an editor can approve', async () => {
  const {bench, id} = await start('valid')
  await bench.fireAction({instanceId: id, activity: 'write', action: 'submit', actor: poet})
  await expect(bench.fireAction({instanceId: id, activity: 'decide', action: 'approve', actor: poet})).rejects.toThrow()
})
