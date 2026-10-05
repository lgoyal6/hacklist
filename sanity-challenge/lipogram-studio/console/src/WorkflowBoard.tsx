// Every poem's review, live, by stage. Opening one mounts a workflow session:
// the engine evaluates what this editor may do right now, and the buttons are
// exactly that evaluation. Nothing here edits instance documents directly.
import {useClient} from '@sanity/sdk-react'
import {Badge, Box, Button, Card, Flex, Grid, Heading, Spinner, Stack, Text} from '@sanity/ui'
import {createEngine, type Engine} from '@sanity/workflow-engine'
import {useWorkflowInstances, useWorkflowSession} from '@sanity/workflow-sdk'
import {useMemo, useState} from 'react'

import {ENGINE_DATASET, PROJECT_ID, WORKFLOW_TAG} from './config'

const STAGES = ['drafting', 'checking', 'review', 'published', 'violated']

function Detail({engine, instanceId}: {engine: Engine; instanceId: string}) {
  const session = useWorkflowSession({engine, instanceId})
  if (session.invalid) return <Text>Unreadable instance: {String(session.invalid.reason)}</Text>
  if (session.error) return <Text>Could not load: {String(session.error)}</Text>
  if (session.evaluationError) return <Text>Could not evaluate: {String(session.evaluationError)}</Text>
  if (!session.ready || !session.evaluation) return <Spinner />
  const ev: any = session.evaluation
  return (
    <Card padding={4} radius={2} border>
      <Stack gap={3}>
        <Heading size={1}>Stage: {ev.instance.currentStage}</Heading>
        {(ev.currentStage?.activities ?? []).map((a: any) => (
          <Stack key={a.activity?.name ?? a.name} gap={2}>
            <Text weight="semibold">{a.activity?.title ?? a.activity?.name ?? a.name}</Text>
            <Flex gap={2} wrap="wrap">
              {(a.actions ?? []).map((act: any) => (
                <Button
                  key={act.action.name}
                  text={act.action.title ?? act.action.name}
                  mode="ghost"
                  disabled={!act.allowed}
                  title={act.allowed ? '' : (act.reasons ?? []).map((r: any) => r.message ?? r.kind).join('; ')}
                  onClick={() => void session.fireAction({activity: a.activity?.name ?? a.name, action: act.action.name} as any)}
                />
              ))}
            </Flex>
          </Stack>
        ))}
        {(ev.currentStage?.activities ?? []).length === 0 && <Text size={1} muted>No one acts in this stage; code moves it on.</Text>}
      </Stack>
    </Card>
  )
}

export function WorkflowBoard() {
  const client = useClient({apiVersion: '2026-10-01'})
  const engine = useMemo(
    () =>
      createEngine({
        client: client.withConfig({dataset: ENGINE_DATASET}) as any,
        workflowResource: {type: 'dataset', id: `${PROJECT_ID}.${ENGINE_DATASET}`},
        tag: WORKFLOW_TAG,
      }),
    [client],
  )
  const {instances, loading, error} = useWorkflowInstances({engine})
  const [open, setOpen] = useState<string | null>(null)
  if (error) return <Text>Could not load workflows: {String(error)}</Text>
  if (loading || !instances) return <Spinner />
  const title = (i: any) => i.fields?.find?.((f: any) => f.name === 'subject')?.value?.id?.split(':').pop() ?? i._id
  return (
    <Grid gridTemplateColumns={[1, 1, 2]} gap={4}>
      <Stack gap={4}>
        {STAGES.map((stage) => {
          const rows = instances.filter((i: any) => i.currentStage === stage)
          return (
            <Stack key={stage} gap={2}>
              <Flex gap={2} align="center"><Text weight="semibold">{stage}</Text><Badge tone={stage === 'violated' ? 'critical' : 'default'}>{rows.length}</Badge></Flex>
              {rows.map((i: any) => (
                <Card key={i._id} padding={2} radius={2} border tone={open === i._id ? 'primary' : 'default'} onClick={() => setOpen(i._id)} style={{cursor: 'pointer'}}>
                  <Text size={1}>{title(i)}</Text>
                </Card>
              ))}
            </Stack>
          )
        })}
      </Stack>
      <Box>{open ? <Detail engine={engine} instanceId={open} /> : <Text muted>Open a poem&apos;s workflow.</Text>}</Box>
    </Grid>
  )
}
