// Reads for the public site: the public dataset when configured, otherwise the
// in-memory lake over the seed. Same GROQ either way.
import {createClient} from '@sanity/client'

import {memoryFetch} from './memory-lake'

export const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
export const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production'
export const live = Boolean(projectId)

const publicClient = projectId ? createClient({projectId, dataset, apiVersion: '2026-10-01', useCdn: false, perspective: 'published'}) : null

export async function query<T = any>(groq: string, params: Record<string, unknown> = {}): Promise<T> {
  if (publicClient) return publicClient.fetch<T>(groq, params, {cache: 'no-store'} as any)
  return memoryFetch<T>(groq, params)
}

export const COLLECTIONS = `*[_type == "collection"] | order(sandbox asc, title asc){
  _id, title, "slug": slug.current, mode, sandbox, description,
  "pieces": count(*[_type == "poem" && collection._ref == ^._id]),
  "violated": count(*[_type == "poem" && collection._ref == ^._id && status == "violated"])
}`

export const COLLECTION = `*[_type == "collection" && slug.current == $slug][0]{
  _id, title, "slug": slug.current, mode, sandbox, description,
  "constraints": *[_type == "constraint" && collection._ref == ^._id] | order(title asc){
    _id, title, kind, params, description, version,
    "used": count(*[_type == "poem" && references(^._id)])
  },
  "poems": *[_type == "poem" && collection._ref == ^._id] | order(title asc){
    _id, title, author, provenance, text, status,
    "constraints": constraints[]->{_id, title, kind, params, version},
    "verdicts": *[_type == "verdict" && poem._ref == ^._id]{"constraint": constraint._ref, ok, constraintVersion, failures}
  },
  "events": *[_type == "changeEvent" && constraint->collection._ref == ^._id] | order(at desc)[0...12]{
    _id, at, source, fromVersion, toVersion, fromParams, toParams, poemsChecked,
    "constraint": constraint->title,
    "broke": broke[]->title, "fixed": fixed[]->title
  }
}`

export const POEM = `*[_type == "poem" && _id == $id][0]{
  _id, title, author, provenance, text, status,
  "collection": collection->{title, "slug": slug.current, mode},
  "constraints": constraints[]->{_id, title, kind, params, version, description},
  "verdicts": *[_type == "verdict" && poem._ref == ^._id]{"constraint": constraint._ref, ok, constraintVersion, failures, checkedAt, checkedBy}
}`
