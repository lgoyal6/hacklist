// The Transit Window agent.
//
// Claude reads two Sanity Context MCP endpoints and calls two local tools:
//   data__*   GROQ mode over the dataset (planets, ephemerides, sources)
//   kb__*     Knowledge Base mode (papers, ExoClock pages, conflicts resolved)
//   predict_transit, plan_night   the deterministic engine in lib/, so the
//             model never does time arithmetic itself.
//
// Two endpoints, not one: an endpoint with a dataset source serves GROQ tools
// and ignores its Knowledge Base sources.
//
// After the loop, every number in the answer is checked against the text of
// the tool results it saw. An answer that states a number nothing returned is
// flagged in the UI and counted as a failure in the eval.

import Anthropic from '@anthropic-ai/sdk'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {nearestTransit, transitsBetween} from './ephemeris'
import {visibility} from './observe'
import type {PlannerPlanet} from './tonight'
import {nightWindow, planNight} from './tonight'
import {bjdTdbToJdUtc, dateToJd, jdToDate} from './time'

export const MODEL = 'claude-opus-5-5'

export interface AgentConfig {
  groqUrl?: string
  kbUrl?: string
  orgToken?: string
  /** Planner data; the app passes Sanity GROQ results, the eval may pass a fixture. */
  loadPlanets: () => Promise<PlannerPlanet[]>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTurns?: number
}

export interface AgentResult {
  answer: string
  toolTrace: {name: string; input: unknown; ok: boolean}[]
  checked: {ok: boolean; unsupported: string[]}
  stopReason: string | null
  servedBy: string
}

const SYSTEM = `You answer questions from amateur astronomers about exoplanet transits.

Where facts come from:
- data__ tools query a Sanity dataset with GROQ. Documents: planet (name, slug, depthMmag, durationHours, ttv, chosenEphemeris reference, selection {rule, reason, corroboration, driftWarning, residualMin, defaultOffsetMin, defaultVerdict}), ephemeris (planet and source references, origin, isArchiveDefault, t0BjdTdb, periodDays, errors, timeSystemAsPublished, usable, assessment {verdict, offsetMin, sigmaMin, tension}), source (citation, url, year), star (name, raDeg, decDeg, vmag). Planet names are written without spaces, e.g. "HAT-P-37b".
- kb__ tools read a Knowledge Base built from papers and the ExoClock project: use it for why sources disagree, orbital decay, time systems and methods.
- predict_transit and plan_night compute times. Never compute a transit time yourself; call these.

Rules:
- Every number you state must come from a tool result in this conversation. Quote times exactly as the tools return them, in UTC, to the minute.
- Which timing solution to trust was decided by code and is stored on the planet (selection.rule and selection.reason). Report that decision and its reason; do not substitute your own.
- When the NASA Exoplanet Archive default disagrees, say by how much (selection.defaultOffsetMin or the tool's defaultOffsetMin) and whether its own stated error covers the gap.
- If a tool returns nothing useful, say what you could not find. Do not fill gaps from memory.
- Be brief: a direct answer first, then the evidence.`

const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'predict_transit',
    description:
      'Next transit of one planet after a UTC time, using the stored chosen ephemeris, with ingress/mid/egress in UTC, ' +
      'its propagated 1-sigma, and what the NASA archive default solution would predict for the same transit. ' +
      'Optionally reports altitude and Sun altitude for an observing site.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planet: {type: 'string', description: 'Planet name as stored, e.g. "HAT-P-37b"'},
        afterUtc: {type: 'string', description: 'ISO 8601 UTC time, e.g. "2026-10-06T00:00:00Z"'},
        latitude: {type: ['number', 'null']},
        longitude: {type: ['number', 'null']},
      },
      required: ['planet', 'afterUtc', 'latitude', 'longitude'],
    },
  },
  {
    name: 'plan_night',
    description:
      'All transits fully observable from a site on the night starting on a local date: whole transit plus 30 minutes ' +
      'either side, target above minAltitudeDeg, Sun below -12 degrees. Optional filters on depth, host V magnitude ' +
      'and telescope aperture. Only planets the ExoClock project monitors.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: {type: 'number'},
        longitude: {type: 'number'},
        localDate: {type: 'string', description: 'YYYY-MM-DD, the evening the night starts'},
        windowStartUtc: {type: ['string', 'null'], description: 'Override the night window start (ISO UTC); null to compute astronomical dusk'},
        windowEndUtc: {type: ['string', 'null'], description: 'Override the night window end (ISO UTC); null to compute astronomical dawn'},
        minDepthMmag: {type: ['number', 'null']},
        maxVmag: {type: ['number', 'null']},
        apertureInches: {type: ['number', 'null']},
        minAltitudeDeg: {type: ['number', 'null']},
      },
      required: ['latitude', 'longitude', 'localDate', 'windowStartUtc', 'windowEndUtc', 'minDepthMmag', 'maxVmag', 'apertureInches', 'minAltitudeDeg'],
    },
  },
]

function iso(d: Date) {
  return d.toISOString().slice(0, 16) + 'Z'
}

async function runLocalTool(name: string, input: any, planets: PlannerPlanet[]): Promise<unknown> {
  if (name === 'predict_transit') {
    const key = String(input.planet).toLowerCase().replace(/[^a-z0-9]/g, '')
    const p = planets.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key)
    if (!p) return {error: `No planet named ${input.planet} in the dataset (only ExoClock-monitored planets are included).`}
    if (!p.chosen || !p.durationHours) return {error: `${p.name} has no usable timing solution.`}
    const after = new Date(input.afterUtc)
    if (Number.isNaN(after.getTime())) return {error: 'afterUtc is not a valid ISO time'}
    const eph = {t0: p.chosen.t0BjdTdb, t0Err: p.chosen.t0ErrDays ?? NaN, period: p.chosen.periodDays, periodErr: p.chosen.periodErrDays ?? NaN}
    const start = dateToJd(after) - 0.02
    const next = transitsBetween(eph, start, start + eph.period * 2 + 0.1).find(
      (t) => jdToDate(bjdTdbToJdUtc(t.mid, p.raDeg, p.decDeg)) > after,
    )
    if (!next) return {error: 'No transit found in the next two periods.'}
    const mid = jdToDate(bjdTdbToJdUtc(next.mid, p.raDeg, p.decDeg))
    const half = (p.durationHours / 2) * 3_600_000
    let nasaDefault: unknown = 'no usable NASA archive default'
    if (p.archiveDefault?.usable) {
      const d = nearestTransit(
        {t0: p.archiveDefault.t0BjdTdb, t0Err: p.archiveDefault.t0ErrDays ?? NaN, period: p.archiveDefault.periodDays, periodErr: p.archiveDefault.periodErrDays ?? NaN},
        next.mid,
      )
      nasaDefault = {
        citation: p.archiveDefault.citation,
        midUtc: iso(jdToDate(bjdTdbToJdUtc(d.mid, p.raDeg, p.decDeg))),
        offsetMin: Number(((d.mid - next.mid) * 1440).toFixed(1)),
        ownSigmaMin: Number.isFinite(d.sigmaMin) ? Number(d.sigmaMin.toFixed(1)) : null,
      }
    }
    let site: unknown = null
    if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
      const v = visibility({latitude: input.latitude, longitude: input.longitude, elevationM: 0}, {name: p.name, raDeg: p.raDeg, decDeg: p.decDeg, durationH: p.durationHours}, next.mid)
      site = {
        minAltitudeDeg: Number(v.minAltDeg.toFixed(1)),
        midAltitudeDeg: Number(v.midAltDeg.toFixed(1)),
        maxSunAltitudeDeg: Number(v.maxSunAltDeg.toFixed(1)),
        fullyObservable: v.fullyObservable,
      }
    }
    return {
      planet: p.name,
      source: p.chosen.citation,
      ingressUtc: iso(new Date(mid.getTime() - half)),
      midUtc: iso(mid),
      egressUtc: iso(new Date(mid.getTime() + half)),
      sigmaMin: Number.isFinite(next.sigmaMin) ? Number(next.sigmaMin.toFixed(1)) : null,
      nasaDefault,
      driftWarning: p.driftWarning,
      ttv: p.ttv,
      site,
    }
  }
  if (name === 'plan_night') {
    const site = {latitude: input.latitude, longitude: input.longitude, elevationM: 0}
    const localNoon = new Date(Date.parse(`${input.localDate}T12:00:00Z`) - (input.longitude / 15) * 3_600_000)
    const window =
      input.windowStartUtc && input.windowEndUtc
        ? {darkStart: new Date(input.windowStartUtc), darkEnd: new Date(input.windowEndUtc)}
        : nightWindow(site, localNoon)
    const rows = planNight(planets, site, window, {
      minDepthMmag: input.minDepthMmag ?? undefined,
      maxVmag: input.maxVmag ?? undefined,
      apertureInches: input.apertureInches ?? undefined,
      limits: {minAltDeg: input.minAltitudeDeg ?? 30, maxSunAltDeg: -12, baselineMin: 30},
    })
    return {
      windowUtc: [iso(window.darkStart), iso(window.darkEnd)],
      count: rows.length,
      transits: rows.map((r) => ({
        planet: r.planet,
        ingressUtc: r.ingressUtc.slice(0, 16) + 'Z',
        midUtc: r.midUtc.slice(0, 16) + 'Z',
        egressUtc: r.egressUtc.slice(0, 16) + 'Z',
        sigmaMin: Number.isFinite(r.sigmaMin) ? Number(r.sigmaMin.toFixed(1)) : null,
        minAltitudeDeg: Number(r.minAltDeg.toFixed(0)),
        depthMmag: r.depthMmag,
        vmag: r.vmag,
        nasaDefaultOffsetMin: r.defaultOffsetMin === null ? null : Number(r.defaultOffsetMin.toFixed(1)),
        source: r.source,
        driftWarning: r.driftWarning,
      })),
    }
  }
  return {error: `Unknown tool ${name}`}
}

interface McpConn {
  prefix: string
  client: Client
  tools: Anthropic.Beta.BetaTool[]
}

async function connectMcp(prefix: string, url: string, token: string): Promise<McpConn> {
  const client = new Client({name: 'transit-window', version: '0.1.0'})
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {Authorization: `Bearer ${token}`}}}),
  )
  const {tools} = await client.listTools()
  return {
    prefix,
    client,
    tools: tools.map((t) => ({
      name: `${prefix}__${t.name}`,
      description: `[${prefix === 'data' ? 'Sanity dataset, GROQ mode' : 'Sanity Knowledge Base'}] ${t.description ?? ''}`,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    })),
  }
}

/** Numbers in prose that must be backed by tool output: decimals, times, and integers of 3+ digits. */
export function extractClaims(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b\d{1,2}:\d{2}\b/g)) out.add(m[0])
  for (const m of text.matchAll(/[-+−]?\d+\.\d+/g)) out.add(m[0].replace('−', '-'))
  for (const m of text.matchAll(/\b\d{3,}\b/g)) out.add(m[0])
  return [...out]
}

export function checkAgainstEvidence(answer: string, evidence: string): {ok: boolean; unsupported: string[]} {
  const unsupported: string[] = []
  for (const claim of extractClaims(answer)) {
    if (evidence.includes(claim)) continue
    const n = Number(claim.replace(/^\+/, ''))
    if (Number.isFinite(n) && claim.includes('.')) {
      // Accept a value rounded from a more precise number in the evidence,
      // or the same magnitude with the sign carried in words ("17.3 minutes early").
      const decimals = claim.split('.')[1].length
      const found = [...evidence.matchAll(/-?\d+\.\d+/g)].some((m) => {
        const v = Number(m[0])
        return Math.abs(Math.abs(v) - Math.abs(n)) <= 0.5 * 10 ** -decimals + 1e-9
      })
      if (found) continue
    }
    if (/^\d{4}$/.test(claim) && Number(claim) >= 1990 && Number(claim) <= 2100) continue // years
    unsupported.push(claim)
  }
  return {ok: unsupported.length === 0, unsupported}
}

export async function runAgent(messages: Anthropic.Beta.BetaMessageParam[], config: AgentConfig): Promise<AgentResult> {
  const anthropic = new Anthropic()
  const conns: McpConn[] = []
  try {
    if (config.groqUrl && config.orgToken) conns.push(await connectMcp('data', config.groqUrl, config.orgToken))
    if (config.kbUrl && config.orgToken) conns.push(await connectMcp('kb', config.kbUrl, config.orgToken))
    const planets = await config.loadPlanets()
    const tools = [...conns.flatMap((c) => c.tools), ...LOCAL_TOOLS]
    const convo = [...messages]
    const trace: AgentResult['toolTrace'] = []
    let evidence = ''
    let stopReason: string | null = null
    let servedBy = MODEL

    for (let turn = 0; turn < (config.maxTurns ?? 12); turn++) {
      const response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools,
        messages: convo,
        output_config: {effort: config.effort ?? 'medium'},
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      stopReason = response.stop_reason
      servedBy = response.model
      convo.push({role: 'assistant', content: response.content})
      if (response.stop_reason === 'refusal') {
        return {answer: 'The model declined to answer this question.', toolTrace: trace, checked: {ok: true, unsupported: []}, stopReason, servedBy}
      }
      if (response.stop_reason === 'pause_turn') continue
      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (response.stop_reason !== 'tool_use' || uses.length === 0) {
        const answer = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
        return {answer, toolTrace: trace, checked: checkAgainstEvidence(answer, evidence), stopReason, servedBy}
      }
      // Run every call from this turn concurrently; answer them in one message.
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          try {
            let text: string
            const conn = conns.find((c) => u.name.startsWith(`${c.prefix}__`))
            if (conn) {
              const r: any = await conn.client.callTool({name: u.name.slice(conn.prefix.length + 2), arguments: u.input as Record<string, unknown>})
              text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
              if (r.isError) throw new Error(text)
            } else {
              text = JSON.stringify(await runLocalTool(u.name, u.input, planets))
            }
            evidence += '\n' + text
            trace.push({name: u.name, input: u.input, ok: true})
            return {type: 'tool_result', tool_use_id: u.id, content: text.slice(0, 60_000)}
          } catch (error) {
            trace.push({name: u.name, input: u.input, ok: false})
            return {type: 'tool_result', tool_use_id: u.id, content: String(error).slice(0, 2000), is_error: true}
          }
        }),
      )
      convo.push({role: 'user', content: results})
    }
    return {answer: 'Stopped after too many tool calls without an answer.', toolTrace: trace, checked: {ok: false, unsupported: []}, stopReason, servedBy}
  } finally {
    await Promise.all(conns.map((c) => c.client.close().catch(() => {})))
  }
}
