import {useQuery} from '@sanity/sdk-react'
import {Badge, Card, Flex, Stack, Text} from '@sanity/ui'

type Ev = {_id: string; at: string; source: string; fromVersion: number; toVersion: number; constraint: string; poemsChecked: number; broke: string[] | null; fixed: string[] | null; fromParams: string | null; toParams: string}

const EVENTS = `*[_type == "changeEvent"] | order(at desc)[0...50]{
  _id, at, source, fromVersion, toVersion, poemsChecked, fromParams, toParams,
  "constraint": constraint->title, "broke": broke[]->title, "fixed": fixed[]->title
}`

export function ChangeLog() {
  const {data} = useQuery<Ev[]>({query: EVENTS})
  if (!data.length) return <Text muted>No rule has changed yet.</Text>
  return (
    <Stack gap={3}>
      {data.map((e) => (
        <Card key={e._id} padding={3} radius={2} border>
          <Stack gap={2}>
            <Flex gap={2} align="center">
              <Text weight="semibold">{e.constraint}</Text>
              <Badge>v{e.fromVersion} → v{e.toVersion}</Badge>
              <Badge>{e.source}</Badge>
              <Text size={1} muted>{new Date(e.at).toLocaleString()}</Text>
            </Flex>
            <Text size={1} muted>{e.fromParams ?? '(created)'} → {e.toParams}</Text>
            <Text size={1}>
              {e.poemsChecked} poems checked
              {e.broke?.length ? ` · broke: ${e.broke.join(', ')}` : ''}
              {e.fixed?.length ? ` · recovered: ${e.fixed.join(', ')}` : ''}
            </Text>
          </Stack>
        </Card>
      ))}
    </Stack>
  )
}
