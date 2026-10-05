// What both recheck functions share: a client, and a workflow engine over the
// `workflows` dataset to tick the poems whose status may have changed.
import {createClient} from '@sanity/client'
import {createEngine} from '@sanity/workflow-engine'

export function clients(clientOptions: Record<string, any>) {
  const client = createClient({...clientOptions, apiVersion: '2026-10-01', useCdn: false})
  const projectId = clientOptions.projectId as string
  const dataset = (clientOptions.dataset as string) ?? 'production'
  const engine = createEngine({
    client: client as any,
    tag: process.env.WORKFLOW_TAG ?? 'prod',
    workflowResource: {type: 'dataset', id: `${projectId}.${process.env.WORKFLOW_DATASET ?? 'workflows'}`},
  })
  return {client, engine, where: {projectId, dataset}}
}
