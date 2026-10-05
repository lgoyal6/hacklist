// Start a poem-review instance for every published poem and walk the valid
// ones to `published`, so the board has a realistic starting state.
// Uses an Editor token: the engine reads the caller's roles from it.
//
//   SANITY_PROJECT_ID=... SANITY_WRITE_TOKEN=... npx tsx scripts/start-workflows.ts
import {createClient} from '@sanity/client'
import {createEngine} from '@sanity/workflow-engine'

const projectId = process.env.SANITY_PROJECT_ID!
const token = process.env.SANITY_WRITE_TOKEN!
const client = createClient({projectId, dataset: 'production', token, apiVersion: '2026-10-01', useCdn: false})
const engine = createEngine({client: client as any, tag: 'prod', workflowResource: {type: 'dataset', id: `${projectId}.workflows`}})

const poems = await client.fetch<{_id: string; _type: string; title: string; status: string}[]>(
  `*[_type == "poem" && !(_id in path("drafts.**"))]{_id, _type, title, status}`,
)
for (const p of poems) {
  const subject = {id: `dataset:${projectId}:production:${p._id}`, type: 'poem'}
  const existing = await engine.instancesForDocument({document: subject.id as any})
  if (existing.length) {
    console.log(`skip ${p.title}: already has ${existing[0].currentStage}`)
    continue
  }
  const {instance} = await engine.startInstance({definition: 'poem-review', initialFields: [{name: 'subject', value: subject}]} as any)
  await engine.fireAction({instanceId: instance._id, activity: 'write', action: 'submit'} as any)
  const now = (await engine.tick({instanceId: instance._id})).instance
  if (now.currentStage === 'review') {
    await engine.fireAction({instanceId: instance._id, activity: 'decide', action: 'approve'} as any)
  }
  console.log(`${p.title}: ${(await engine.tick({instanceId: instance._id})).instance.currentStage}`)
}
