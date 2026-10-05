// A poem's words or its rule list changed: re-check it and tick its workflow
// (a poem waiting in `checking` moves on as soon as its status is written).
import {documentEventHandler} from '@sanity/functions'
import {recheckPoem, tickPoemWorkflows} from '@lipogram/engine'

import {clients} from '../shared'

export const handler = documentEventHandler<{_id: string}>(async ({context, event}) => {
  const {client, engine, where} = clients(context.clientOptions)
  const result = await recheckPoem(client as any, event.data._id, 'function')
  const moved = await tickPoemWorkflows(engine as any, where, [event.data._id])
  console.log(`poem ${event.data._id}: ${result.broke.length ? 'now violated' : result.fixed.length ? 'now valid' : 'unchanged'}, ${moved.length} workflow(s) moved`)
})
