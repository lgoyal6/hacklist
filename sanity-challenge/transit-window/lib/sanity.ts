// Data access for the app. Reads the public Sanity dataset when configured;
// falls back to the committed fixtures (same shapes) so the app runs offline
// and keeps working if the dataset is unreachable.
import {createClient} from '@sanity/client'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {planetDetailQuery, plannerPlanetsQuery} from './queries'
import type {PlannerPlanet} from './tonight'

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production'

export const sanity = projectId
  ? createClient({projectId, dataset, apiVersion: '2026-10-01', useCdn: true, perspective: 'published'})
  : null

export const dataSourceLabel = sanity ? `Sanity dataset ${projectId}/${dataset}` : 'local fixture (no Sanity project configured)'

const dataDir = resolve(process.cwd(), 'data')

export async function getPlannerPlanets(): Promise<PlannerPlanet[]> {
  if (sanity) {
    try {
      return await sanity.fetch<PlannerPlanet[]>(plannerPlanetsQuery, {}, {next: {revalidate: 3600}} as any)
    } catch (error) {
      console.error('Sanity fetch failed, using fixture', error)
    }
  }
  return JSON.parse(await readFile(resolve(dataDir, 'planner-fixture.json'), 'utf8'))
}

export async function getPlanetDetail(slug: string): Promise<any | null> {
  if (sanity) {
    try {
      return await sanity.fetch(planetDetailQuery, {slug}, {next: {revalidate: 3600}} as any)
    } catch (error) {
      console.error('Sanity fetch failed, using fixture', error)
    }
  }
  if (!/^[a-z0-9_-]+$/.test(slug)) return null
  try {
    return JSON.parse(await readFile(resolve(dataDir, 'planet-details', `${slug}.json`), 'utf8'))
  } catch {
    return null
  }
}
