// Every rule with its blast radius, live. Selecting one opens an editor whose
// preview runs the shared checker over every poem that references the rule,
// so an editor sees "this will break 4 poems" before committing. Committing
// patches the published constraint; the recheck function does the rest.
import {check, describe, toLines, type Constraint} from '@lipogram/checker'
import {useClient, useQuery} from '@sanity/sdk-react'
import {Badge, Box, Button, Card, Flex, Grid, Heading, Stack, Text, TextInput} from '@sanity/ui'
import {useMemo, useState} from 'react'

type Rule = Constraint & {_id: string; title: string; version: number; collection: string; poems: {_id: string; title: string; text: string; status: string}[]}

const RULES = `*[_type == "constraint"] | order(collection->title asc, title asc){
  _id, title, kind, params, version, "collection": collection->title,
  "poems": *[_type == "poem" && references(^._id)]{_id, title, text, status}
}`

function ParamsEditor({rule, value, onChange}: {rule: Rule; value: any; onChange: (v: any) => void}) {
  const field = (key: string, label: string, parse: (s: string) => unknown = (s) => s, show: (v: unknown) => string = (v) => String(v ?? '')) => (
    <Stack gap={2} key={key}>
      <Text size={1} weight="medium">{label}</Text>
      <TextInput value={show(value[key])} onChange={(e) => onChange({...value, [key]: parse(e.currentTarget.value)})} />
    </Stack>
  )
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
  const nums = (s: string) => s.split(/[-,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  switch (rule.kind) {
    case 'lipogram': return field('letters', 'Banned letters')
    case 'univocalic': return field('vowel', 'The one vowel')
    case 'reuseWord': return field('minWordLength', 'Minimum shared word length', Number)
    case 'syllables': return field('pattern', 'Syllable pattern (e.g. 5-7-5)', nums, (v) => (Array.isArray(v) ? v.join('-') : ''))
    case 'acrostic': return field('word', 'Word the first letters spell')
    case 'noRepeat': return field('ignore', 'Words allowed to repeat (comma separated)', list, (v) => (Array.isArray(v) ? v.join(', ') : ''))
    case 'bannedWords': return field('words', 'Banned words (comma separated)', list, (v) => (Array.isArray(v) ? v.join(', ') : ''))
    case 'maxLineLength': return field('maxChars', 'Maximum characters per line', Number)
    case 'lineCount': return <>{field('minLines', 'Minimum lines', Number)}{field('maxLines', 'Maximum lines', Number)}</>
    case 'forbiddenPattern': return <>{field('regex', 'Pattern (regular expression)')}{field('reason', 'Shown to writers as')}</>
  }
}

function RuleEditor({rule, onDone}: {rule: Rule; onDone: () => void}) {
  const client = useClient({apiVersion: '2026-10-01'})
  const [value, setValue] = useState<any>(rule.params ?? {})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const impact = useMemo(() => {
    const next = {...rule, params: value}
    const breaks = rule.poems.filter((p) => !check(toLines(p.text ?? ''), next).ok)
    const nowBroken = new Set(rule.poems.filter((p) => !check(toLines(p.text ?? ''), rule).ok).map((p) => p._id))
    return {
      breaks,
      newlyBroken: breaks.filter((p) => !nowBroken.has(p._id)),
      recovered: rule.poems.filter((p) => nowBroken.has(p._id) && !breaks.some((b) => b._id === p._id)),
    }
  }, [rule, value])

  async function commit() {
    setSaving(true)
    setError(null)
    try {
      await client.patch(rule._id).set({params: value}).commit()
      onDone()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card padding={4} radius={2} border tone="primary">
      <Stack gap={4}>
        <Heading size={1}>{rule.title} <Badge>v{rule.version}</Badge></Heading>
        <Text size={1} muted>{describe({...rule, params: value})}</Text>
        <ParamsEditor rule={rule} value={value} onChange={setValue} />
        <Card padding={3} radius={2} tone={impact.newlyBroken.length ? 'critical' : 'positive'}>
          <Stack gap={3}>
            <Text size={1}>
              {impact.breaks.length} of {rule.poems.length} poems would break this rule
              {impact.newlyBroken.length ? `, ${impact.newlyBroken.length} newly` : ''}
              {impact.recovered.length ? `, ${impact.recovered.length} would recover` : ''}.
            </Text>
            {impact.newlyBroken.map((p) => <Text key={p._id} size={1}>✗ {p.title}</Text>)}
            {impact.recovered.map((p) => <Text key={p._id} size={1}>✓ {p.title}</Text>)}
          </Stack>
        </Card>
        {error && <Text size={1} style={{color: 'var(--card-badge-critical-fg-color)'}}>{error}</Text>}
        <Flex gap={2}>
          <Button text={saving ? 'Saving' : 'Commit rule change'} tone="critical" disabled={saving} onClick={commit} />
          <Button text="Cancel" mode="ghost" onClick={onDone} />
        </Flex>
        <Text size={0} muted>
          Committing changes the rule only. The recheck-constraint function re-checks every poem that references it,
          writes verdicts, logs the change, and ticks each poem&apos;s review workflow.
        </Text>
      </Stack>
    </Card>
  )
}

export function RulesBoard() {
  const {data: rules} = useQuery<Rule[]>({query: RULES})
  const [selected, setSelected] = useState<string | null>(null)
  const rule = rules.find((r) => r._id === selected)
  return (
    <Grid gridTemplateColumns={[1, 1, 2]} gap={4}>
      <Stack gap={2}>
        {rules.map((r) => {
          const broken = r.poems.filter((p) => p.status === 'violated').length
          return (
            <Card key={r._id} padding={3} radius={2} border tone={r._id === selected ? 'primary' : 'default'} onClick={() => setSelected(r._id)} style={{cursor: 'pointer'}}>
              <Flex align="center" gap={2}>
                <Box flex={1}>
                  <Stack gap={2}>
                    <Text weight="semibold">{r.title}</Text>
                    <Text size={1} muted>{r.collection} · {describe(r)}</Text>
                  </Stack>
                </Box>
                <Badge>v{r.version}</Badge>
                <Badge tone={broken ? 'critical' : 'positive'}>{r.poems.length - broken}/{r.poems.length} keep it</Badge>
              </Flex>
            </Card>
          )
        })}
      </Stack>
      <Box>{rule ? <RuleEditor key={rule._id + rule.version} rule={rule} onDone={() => setSelected(null)} /> : <Text muted>Choose a rule to see its blast radius.</Text>}</Box>
    </Grid>
  )
}
