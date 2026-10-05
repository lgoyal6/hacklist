import {visionTool} from '@sanity/vision'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'

import {withConstraintCheck} from './actions/checkedPublish'
import {schemaTypes} from './schemaTypes'

export default defineConfig({
  name: 'default',
  title: 'Lipogram Studio',
  projectId: process.env.SANITY_STUDIO_PROJECT_ID!,
  dataset: process.env.SANITY_STUDIO_DATASET ?? 'production',
  plugins: [structureTool(), visionTool()],
  schema: {types: schemaTypes},
  document: {
    actions: (prev, context) =>
      context.schemaType === 'poem'
        ? prev.map((action) => (action.action === 'publish' ? withConstraintCheck(action) : action))
        : prev,
  },
})
