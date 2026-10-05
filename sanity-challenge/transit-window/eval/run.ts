// Three-arm evaluation. Same model, same questions, same answer format.
//
//   A  transit-window   Sanity Context (GROQ + Knowledge Base) + the planner tools
//   B  keyword          BM25 search over the same documents serialized as text,
//                       plus a calculator that propagates any ephemeris it finds.
//                       The only thing B lacks is structure: it must decide from
//                       text which solution to use.
//   C  no-tools         the model alone.
//
//   npx tsx eval/run.ts [--arms A,B,C] [--split dev|held-out|all] [--limit N]
//
// Ground truth comes from eval/questions.json (astropy, independent of lib/).
// Results go to eval/results.json, which /proof renders.

import Anthropic from '@anthropic-ai/sdk'
import {readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {MODEL, runAgent} from '../lib/agent'
import {transitsBetween} from '../lib/ephemeris'
import {loadCatalog, plannerPlanetsFromCatalog} from '../lib/local'
import {bjdTdbToJdUtc, dateToJd, jdToDate} from '../lib/time'

const root = resolve(import.meta.dirname, '..')
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const arms = arg('arms', 'A,B,C').split(',')
const split = arg('split', 'all')
const limit = Number(arg('limit', '1000'))

const {questions} = JSON.parse(readFileSync(resolve(root, 'eval/questions.json'), 'utf8'))
const selected = questions.filter((q: any) => split === 'all' || q.split === split).slice(0, limit)
const catalog = loadCatalog(resolve(root, 'data/catalog.json'))
const planets = plannerPlanetsFromCatalog(catalog)

const FORMAT = `
Finish with one line that starts with ANSWER: followed by JSON:
- timing question: {"midUtc": "YYYY-MM-DDTHH:MMZ"}
- observability question: {"planets": ["Name", ...]} using names without spaces, e.g. "WASP-12b"
- trust question: {"chosenOrigin": "exoclock" | "archive", "defaultOffsetMin": number (NASA default minus trusted solution, minutes)}
- trend question: {"answer": "shorter" | "longer" | "constant" | "disputed"}`

// ---------- arm B: BM25 over serialized documents ----------

function corpus(): {id: string; text: string}[] {
  const docs: {id: string; text: string}[] = []
  for (const p of catalog.planets) {
    if (!p.exoclock) continue
    docs.push({
      id: `planet:${p.name}`,
      text: `Planet ${p.name}, host star ${p.host}, RA ${p.raDeg.toFixed(5)} deg, Dec ${p.decDeg.toFixed(5)} deg, V ${p.vmag}, depth ${p.depthMmag} mmag, duration ${p.durationH} hours.`,
    })
    for (const c of p.candidates) {
      docs.push({
        id: `eph:${c.id}`,
        text:
          `${p.name} transit ephemeris from ${c.citation}${c.publishedYear ? ` (${c.publishedYear})` : ''}` +
          `${c.isArchiveDefault ? ', NASA Exoplanet Archive default solution' : ''}${c.origin === 'exoclock' ? ', ExoClock catalogue' : ''}: ` +
          `T0 = ${c.t0} (${c.timeSystem}) +/- ${c.t0Err}, period = ${c.period} +/- ${c.periodErr} days.`,
      })
    }
  }
  for (const f of readdirSync(resolve(root, 'kb/papers'))) {
    docs.push({id: `paper:${f}`, text: readFileSync(resolve(root, 'kb/papers', f), 'utf8')})
  }
  return docs
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9.\-]+/g) ?? []

function bm25(docs: {id: string; text: string}[]) {
  const toks = docs.map((d) => tokenize(d.text))
  const avg = toks.reduce((n, t) => n + t.length, 0) / toks.length
  const df = new Map<string, number>()
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  const k1 = 1.2, b = 0.75, N = docs.length
  return (query: string, k = 8) => {
    const q = tokenize(query)
    return toks
      .map((t, i) => {
        let s = 0
        for (const w of q) {
          const f = t.filter((x) => x === w).length
          if (!f) continue
          const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)))
        }
        return {i, s}
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => docs[x.i])
  }
}

const KEYWORD_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search',
    description: 'Keyword (BM25) search over planet records, every published transit ephemeris, and paper abstracts. Returns the top 8 documents.',
    input_schema: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
  },
  {
    name: 'propagate',
    description:
      'Given an ephemeris in BJD_TDB (T0, period) and the star coordinates, return the first transit midtime after a UTC time, in UTC. ' +
      'Convert other time systems yourself before calling.',
    input_schema: {
      type: 'object',
      properties: {t0BjdTdb: {type: 'number'}, periodDays: {type: 'number'}, raDeg: {type: 'number'}, decDeg: {type: 'number'}, afterUtc: {type: 'string'}},
      required: ['t0BjdTdb', 'periodDays', 'raDeg', 'decDeg', 'afterUtc'],
    },
  },
]

async function runKeyword(question: string): Promise<{answer: string; tools: string[]}> {
  const anthropic = new Anthropic()
  const search = bm25(corpus())
  const convo: Anthropic.Beta.BetaMessageParam[] = [{role: 'user', content: question + '\n' + FORMAT}]
  const tools: string[] = []
  for (let turn = 0; turn < 12; turn++) {
    const r = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: 'You answer questions about exoplanet transits using only the tools provided. Never invent numbers.',
      tools: KEYWORD_TOOLS,
      messages: convo,
      output_config: {effort: 'medium'},
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    convo.push({role: 'assistant', content: r.content})
    const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (r.stop_reason !== 'tool_use' || !uses.length) {
      return {answer: r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n'), tools}
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
      tools.push(u.name)
      const input: any = u.input
      if (u.name === 'search') {
        return {type: 'tool_result', tool_use_id: u.id, content: search(String(input.query)).map((d) => `[${d.id}] ${d.text}`).join('\n\n').slice(0, 30_000)}
      }
      const after = dateToJd(new Date(input.afterUtc))
      const next = transitsBetween({t0: input.t0BjdTdb, t0Err: NaN, period: input.periodDays, periodErr: NaN}, after - 0.02, after + input.periodDays * 2)
        .map((t) => jdToDate(bjdTdbToJdUtc(t.mid, input.raDeg, input.decDeg)))
        .find((d) => d.getTime() > Date.parse(input.afterUtc))
      return {type: 'tool_result', tool_use_id: u.id, content: next ? next.toISOString().slice(0, 16) + 'Z' : 'none'}
    })
    convo.push({role: 'user', content: results})
  }
  return {answer: '', tools}
}

async function runNoTools(question: string): Promise<{answer: string; tools: string[]}> {
  const anthropic = new Anthropic()
  const r = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: 'You answer questions about exoplanet transits.',
    messages: [{role: 'user', content: question + '\n' + FORMAT}],
    output_config: {effort: 'medium'},
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  })
  return {answer: r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n'), tools: []}
}

// ---------- grading ----------

function parseAnswer(text: string): any {
  const line = text.split('\n').reverse().find((l) => l.trim().startsWith('ANSWER:'))
  if (!line) return null
  try {
    return JSON.parse(line.trim().slice('ANSWER:'.length).trim())
  } catch {
    return null
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function grade(q: any, ans: any): {correct: boolean; detail: string} {
  if (!ans) return {correct: false, detail: 'no parseable ANSWER line'}
  if (q.kind === 'midtime') {
    const err = Math.abs(Date.parse(ans.midUtc) - Date.parse(q.truth.midUtc)) / 60_000
    return {correct: err <= q.truth.toleranceMin, detail: Number.isFinite(err) ? `off by ${err.toFixed(1)} min (tolerance ${q.truth.toleranceMin})` : 'unparseable time'}
  }
  if (q.kind === 'observable') {
    const got = new Set((ans.planets ?? []).map(norm))
    const want = new Set(q.truth.planets.map(norm))
    const hit = [...want].filter((p) => got.has(p)).length
    return {correct: hit === want.size && got.size === want.size, detail: `${hit}/${want.size} found, ${got.size - hit} extra`}
  }
  if (q.kind === 'trust') {
    const offErr = Math.abs(Number(ans.defaultOffsetMin) - q.truth.defaultOffsetMin)
    const ok = ans.chosenOrigin === q.truth.chosenOrigin && offErr <= q.truth.toleranceMin
    return {correct: ok, detail: `origin ${ans.chosenOrigin}, offset error ${Number.isFinite(offErr) ? offErr.toFixed(1) : '?'} min`}
  }
  return {correct: String(ans.answer).toLowerCase() === q.truth.answer, detail: `answered ${ans.answer}`}
}

// ---------- run ----------

const ARM_LABEL: Record<string, string> = {A: 'Transit Window (Sanity Context)', B: 'Keyword search + calculator', C: 'Model alone'}
const records: any[] = []
for (const q of selected) {
  for (const arm of arms) {
    const started = Date.now()
    let out: {answer: string; tools: string[]}
    try {
      if (arm === 'A') {
        const r = await runAgent([{role: 'user', content: q.question + '\n' + FORMAT}], {
          groqUrl: process.env.SANITY_CONTEXT_GROQ_URL,
          kbUrl: process.env.SANITY_CONTEXT_KB_URL,
          orgToken: process.env.SANITY_ORGANIZATION_TOKEN,
          loadPlanets: async () => planets,
          effort: 'medium',
        })
        out = {answer: r.answer, tools: r.toolTrace.map((t) => t.name)}
      } else if (arm === 'B') out = await runKeyword(q.question)
      else out = await runNoTools(q.question)
    } catch (error) {
      out = {answer: `ERROR ${String(error)}`, tools: []}
    }
    const g = grade(q, parseAnswer(out.answer))
    records.push({id: q.id, kind: q.kind, split: q.split, arm, ...g, seconds: (Date.now() - started) / 1000, tools: out.tools, answer: out.answer})
    console.log(`${q.id} ${arm} ${g.correct ? 'PASS' : 'fail'}  ${g.detail}`)
  }
}

const kinds = [...new Set(selected.map((q: any) => q.kind))] as string[]
const summary = {
  model: MODEL,
  ranAt: new Date().toISOString(),
  split,
  kinds,
  arms: arms.map((arm) => ({
    name: arm,
    label: ARM_LABEL[arm],
    byKind: Object.fromEntries(
      kinds.map((k) => {
        const rs = records.filter((r) => r.arm === arm && r.kind === k)
        return [k, {correct: rs.filter((r) => r.correct).length, total: rs.length}]
      }),
    ),
    heldOut: (() => {
      const rs = records.filter((r) => r.arm === arm && r.split === 'held-out')
      return {correct: rs.filter((r) => r.correct).length, total: rs.length}
    })(),
  })),
  records,
}
writeFileSync(resolve(root, 'eval/results.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary.arms, null, 1))
