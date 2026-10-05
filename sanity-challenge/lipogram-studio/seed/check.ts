// Run every seed piece through the real checker; print anything broken.
import {check, toLines} from '@lipogram/checker'
import {constraints, poems} from './content'

const byKey = new Map(constraints.map((c) => [c.key, c]))
let broken = 0
for (const p of poems) {
  for (const k of p.constraints) {
    const c = byKey.get(k)!
    const v = check(toLines(p.text), {kind: c.kind as any, params: c.params as any})
    if (!v.ok) {
      broken++
      console.log(`✗ ${p.key} / ${k}: ${v.failures.slice(0, 4).map((f) => `L${f.line + 1} ${f.message}`).join('; ')}`)
    }
  }
}
console.log(`${poems.length} pieces, ${broken} broken`)
