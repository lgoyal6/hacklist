// The poem's text field, with every referenced constraint checked as you type.
// Uses the same checker as the re-check function and the publish action.
import {checkAll, describe, toLines, type Constraint, type Failure} from '@lipogram/checker'
import {Badge, Box, Card, Flex, Stack, Text} from '@sanity/ui'
import {useEffect, useMemo, useState} from 'react'
import {type StringInputProps, useClient, useFormValue} from 'sanity'

type Ref = {_ref: string}

function useConstraints(refs: Ref[] | undefined): Constraint[] {
  const client = useClient({apiVersion: '2026-10-01'})
  const ids = useMemo(() => (refs ?? []).map((r) => r._ref).filter(Boolean), [refs])
  const [constraints, setConstraints] = useState<Constraint[]>([])
  useEffect(() => {
    if (!ids.length) {
      setConstraints([])
      return
    }
    const query = `*[_id in $ids]{_id, title, kind, params, version}`
    let alive = true
    client.fetch(query, {ids}).then((c) => alive && setConstraints(c))
    // Live: tighten a constraint in another tab and this poem re-highlights.
    const sub = client.listen(query, {ids}, {visibility: 'query'}).subscribe(() => {
      client.fetch(query, {ids}).then((c) => alive && setConstraints(c))
    })
    return () => {
      alive = false
      sub.unsubscribe()
    }
  }, [client, ids])
  return constraints
}

function Highlighted({line, failures}: {line: string; failures: Failure[]}) {
  if (!failures.length) return <span>{line || ' '}</span>
  const marks = new Array(line.length).fill(false)
  for (const f of failures) for (let i = f.start; i < Math.min(f.end, line.length); i++) marks[i] = true
  const parts: {text: string; bad: boolean}[] = []
  for (let i = 0; i < line.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.bad === marks[i]) last.text += line[i]
    else parts.push({text: line[i], bad: marks[i]})
  }
  const wholeLine = failures.some((f) => f.start === 0 && f.end >= line.length)
  return (
    <span style={wholeLine ? {textDecoration: 'underline wavy #e5484d'} : undefined}>
      {parts.map((p, i) =>
        p.bad && !wholeLine ? (
          <mark key={i} style={{background: 'rgba(229,72,77,.25)', color: 'inherit', borderBottom: '2px solid #e5484d'}}>{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  )
}

export function ConstrainedTextInput(props: StringInputProps) {
  const refs = useFormValue(['constraints']) as Ref[] | undefined
  const constraints = useConstraints(refs)
  const lines = toLines(props.value ?? '')
  const results = checkAll(lines, constraints)
  const byLine = new Map<number, Failure[]>()
  for (const r of results) for (const f of r.verdict.failures) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f])
  const broken = results.filter((r) => !r.verdict.ok)

  return (
    <Stack gap={3}>
      {props.renderDefault(props)}
      {constraints.length > 0 && (
        <Card padding={3} radius={2} tone={broken.length ? 'critical' : 'positive'} border>
          <Stack gap={3}>
            <Flex gap={2} wrap="wrap">
              {results.map(({constraint, verdict}) => (
                <Badge key={constraint._id} tone={verdict.ok ? 'positive' : 'critical'} title={describe(constraint)}>
                  {verdict.ok ? '✓' : '✗'} {constraint.title ?? describe(constraint)}
                </Badge>
              ))}
            </Flex>
            <Box style={{fontFamily: 'ui-serif, Georgia, serif', fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap'}}>
              {lines.map((line, i) => (
                <div key={i}>
                  <Highlighted line={line} failures={byLine.get(i) ?? []} />
                </div>
              ))}
            </Box>
            {broken.map(({constraint, verdict}) => (
              <Stack key={constraint._id} gap={2}>
                <Text size={1} weight="semibold">{constraint.title}</Text>
                {verdict.failures.slice(0, 8).map((f, i) => (
                  <Text key={i} size={1} muted>
                    {f.line >= 0 ? `Line ${f.line + 1} ` : 'The poem '}
                    {f.message}
                  </Text>
                ))}
                {verdict.failures.length > 8 && <Text size={1} muted>and {verdict.failures.length - 8} more</Text>}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}
