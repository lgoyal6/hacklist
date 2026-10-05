import {defineWorkflowConfig} from '@sanity/workflow-engine/define'

import {poemReview} from './workflows/poem-review'

const projectId = process.env.SANITY_PROJECT_ID ?? 'your-project-id'

export default defineWorkflowConfig({
  deployments: [
    {
      name: 'production',
      tag: 'prod',
      expectedMinReaderModel: 10,
      workflowResource: {type: 'dataset', id: `${projectId}.workflows`},
      definitions: [poemReview],
    },
  ],
})
