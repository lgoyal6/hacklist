// A constraint's params changed: re-check every poem that references it, then
// tick the workflow of every poem that flipped. The trigger filter
// (sanity.blueprint.ts) fires only on params changes, and nothing here writes
// params, so this cannot retrigger itself.
import {documentEventHandler} from '@sanity/functions'
import {recheckConstraint, tickPoemWorkflows} from '@lipogram/engine'

import {clients} from '../shared'

export const handler = documentEventHandler<{_id: string; fromParams?: unknown}>(async ({context, event}) => {
  const {client, engine, where} = clients(context.clientOptions)
  const result = await recheckConstraint(client as any, event.data._id, {
    by: 'function',
    source: 'studio',
    fromParams: event.data.fromParams,
  })
  const moved = await tickPoemWorkflows(engine as any, where, [...result.broke, ...result.fixed])
  console.log(
    `constraint ${event.data._id} -> v${result.toVersion}: ${result.poemsChecked} poems checked, ` +
      `${result.broke.length} broke, ${result.fixed.length} fixed, ${moved.length} workflow(s) moved`,
  )
})
