import {notFound} from 'next/navigation'

import {CollectionView, type CollectionData} from '../../../components/CollectionView'
import {COLLECTION, query} from '../../../lib/data'

export const dynamic = 'force-dynamic'

export default async function CollectionPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const data = await query<CollectionData | null>(COLLECTION, {slug})
  if (!data) notFound()
  return <CollectionView initial={data} />
}
