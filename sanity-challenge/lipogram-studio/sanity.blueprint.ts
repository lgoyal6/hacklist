import {defineBlueprint, defineDocumentFunction} from '@sanity/blueprints'

const dataset = {type: 'dataset' as const, id: `${process.env.SANITY_PROJECT_ID}.production`}

export default defineBlueprint({
  resources: [
    defineDocumentFunction({
      name: 'recheck-constraint',
      event: {
        on: ['create', 'update'],
        // Only a change to the rule itself. The function writes `version`, which
        // this filter ignores, so it cannot trigger itself.
        filter: '_type == "constraint" && (delta::operation() == "create" || delta::changedAny(params))',
        projection: '{_id, "fromParams": before().params}',
        resource: dataset,
      },
    }),
    defineDocumentFunction({
      name: 'recheck-poem',
      event: {
        on: ['create', 'update'],
        // Only the words or the rule list. The function writes `status`, which
        // this filter ignores.
        filter: '_type == "poem" && (delta::operation() == "create" || delta::changedAny((text, constraints)))',
        projection: '{_id}',
        resource: dataset,
      },
    }),
  ],
})
