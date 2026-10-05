import {NextResponse} from 'next/server'

import {COLLECTION, query} from '../../../../lib/data'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, {params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  return NextResponse.json(await query(COLLECTION, {slug}), {headers: {'cache-control': 'no-store'}})
}
