import {NextResponse} from 'next/server'

import {runAgent} from '../../../lib/agent'
import {getPlannerPlanets} from '../../../lib/sanity'

export const maxDuration = 120

// A public demo with a paid model behind it: cap per-IP use in memory. Good
// enough for one serverless instance; the post says so.
const hits = new Map<string, number[]>()
function limited(ip: string) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > 12
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({error: 'The agent is not configured on this deployment.'}, {status: 503})
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  if (limited(ip)) return NextResponse.json({error: 'Too many questions from here; try again in a few minutes.'}, {status: 429})

  const body = await req.json().catch(() => null)
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages?.length || messages.length > 20) return NextResponse.json({error: 'Send 1 to 20 messages.'}, {status: 400})
  const clean = messages
    .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m: any) => ({role: m.role, content: m.content.slice(0, 4000)}))

  try {
    const result = await runAgent(clean, {
      groqUrl: process.env.SANITY_CONTEXT_GROQ_URL,
      kbUrl: process.env.SANITY_CONTEXT_KB_URL,
      orgToken: process.env.SANITY_ORGANIZATION_TOKEN,
      loadPlanets: getPlannerPlanets,
    })
    return NextResponse.json({
      answer: result.answer,
      tools: result.toolTrace.map((t) => t.name),
      checked: result.checked,
      servedBy: result.servedBy,
    })
  } catch (error) {
    console.error(error)
    return NextResponse.json({error: 'The agent failed on this question.'}, {status: 500})
  }
}
