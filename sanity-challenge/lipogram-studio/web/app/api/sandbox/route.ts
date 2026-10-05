import {createClient} from '@sanity/client'
import {recheckConstraint} from '@lipogram/engine'
import {NextResponse} from 'next/server'

import {live, projectId, dataset, query} from '../../../lib/data'
import {memoryLake, resetMemoryLake} from '../../../lib/memory-lake'
import {validateParams} from '../../../lib/sandbox'

const hits = new Map<string, number[]>()
function limited(ip: string) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > 10
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  if (limited(ip)) return NextResponse.json({error: 'Slow down: ten changes a minute.'}, {status: 429})
  const body = await req.json().catch(() => null)

  if (body?.reset === true && !live) {
    resetMemoryLake()
    return NextResponse.json({ok: true, reset: true})
  }

  const id = String(body?.constraintId ?? '')
  const c = await query<{_id: string; kind: string; params: unknown; sandbox: boolean} | null>(
    `*[_type == "constraint" && _id == $id][0]{_id, kind, params, "sandbox": collection->sandbox}`,
    {id},
  )
  if (!c || !c.sandbox) return NextResponse.json({error: 'Only sandbox rules can be changed from the site.'}, {status: 403})
  const v = validateParams(c.kind, body?.params)
  if (!v.ok) return NextResponse.json({error: v.error}, {status: 400})

  if (live) {
    const token = process.env.SANITY_SANDBOX_TOKEN
    if (!token) return NextResponse.json({error: 'Sandbox writes are not configured on this deployment.'}, {status: 503})
    const client = createClient({projectId, dataset, apiVersion: '2026-10-01', token, useCdn: false})
    // Only the params change here. The recheck-constraint Sanity Function
    // picks the change up and writes the verdicts; the page watches for them.
    await client.patch(c._id).set({params: v.params}).commit()
    return NextResponse.json({ok: true, mode: 'function'})
  }

  // Offline: patch the in-memory lake and run the engine the Function runs.
  await memoryLake.transaction().patch(memoryLake.patch(c._id).set({params: v.params})).commit()
  const result = await recheckConstraint(memoryLake, c._id, {by: 'sandbox', source: 'public-sandbox', fromParams: c.params})
  return NextResponse.json({ok: true, mode: 'offline', ...result})
}
