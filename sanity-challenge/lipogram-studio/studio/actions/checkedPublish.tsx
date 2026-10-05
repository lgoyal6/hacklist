// Publish that refuses a poem breaking any of its constraints, and says why.
// The same refusal is enforced again server-side by the re-check function,
// which marks a published poem violated; this action is the friendly half.
import {check, toLines, type Constraint} from '@lipogram/checker'
import {useEffect, useState} from 'react'
import {type DocumentActionComponent, type DocumentActionProps, useClient} from 'sanity'

export function withConstraintCheck(original: DocumentActionComponent): DocumentActionComponent {
  const Checked: DocumentActionComponent = (props: DocumentActionProps) => {
    const client = useClient({apiVersion: '2026-10-01'})
    const doc: any = props.draft ?? props.published
    const ids: string[] = (doc?.constraints ?? []).map((r: any) => r._ref)
    const [constraints, setConstraints] = useState<Constraint[] | null>(null)
    useEffect(() => {
      let alive = true
      client.fetch(`*[_id in $ids]{_id, title, kind, params}`, {ids}).then((c) => alive && setConstraints(c))
      return () => {
        alive = false
      }
    }, [client, ids.join(',')])

    const base = original(props)
    if (!base) return null
    if (constraints === null) return {...base, disabled: true, title: 'Checking constraints'}
    const lines = toLines(doc?.text ?? '')
    const broken = constraints
      .map((c) => ({c, v: check(lines, c)}))
      .filter((r) => !r.v.ok)
    if (!broken.length) return base
    const first = broken[0]
    const f = first.v.failures[0]
    return {
      ...base,
      disabled: true,
      title:
        `Breaks ${broken.length} constraint${broken.length > 1 ? 's' : ''}. ` +
        `${first.c.title}: ${f.line >= 0 ? `line ${f.line + 1} ` : ''}${f.message}`,
    }
  }
  Checked.action = original.action
  Checked.displayName = 'CheckedPublish'
  return Checked
}
