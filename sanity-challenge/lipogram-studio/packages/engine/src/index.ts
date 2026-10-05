// Re-checking against the Content Lake: shared by the Sanity Function, the seed
// script and the public sandbox route, so all three write identical verdicts.
//
// Writes are designed not to retrigger the function: verdicts are their own
// documents, a constraint's version bump touches only `version`, and a poem's
// status patch touches only `status`. The function's GROQ filter only fires on
// changes to a constraint's params or a poem's text/constraints.

import {check, toLines, type Constraint, type Failure} from '@lipogram/checker'

/** The slice of @sanity/client this module uses, so tests can pass a fake. */
export interface LakeClient {
  fetch<T = any>(query: string, params?: Record<string, unknown>): Promise<T>
  /** A patch builder; passed whole into a transaction, which every client accepts. */
  patch(id: string): {set(attrs: Record<string, unknown>): any}
  transaction(): {
    createOrReplace(doc: Record<string, unknown>): any
    create(doc: Record<string, unknown>): any
    patch(patch: any): any
    commit(options?: Record<string, unknown>): Promise<unknown>
  }
}

export type CheckedBy = 'function' | 'seed' | 'console' | 'sandbox'

export const verdictId = (poemId: string, constraintId: string) =>
  `verdict-${poemId.replace(/^drafts\./, '')}-${constraintId.replace(/^drafts\./, '')}`

interface PoemRow {
  _id: string
  hasDraft?: boolean
  title: string
  text: string | null
  constraints: (Constraint & {_id: string; version?: number})[]
  previous: {constraintId: string; ok: boolean}[]
}

const POEM_PROJECTION = `{
  _id, title, text,
  "hasDraft": defined(*[_id == "drafts." + ^._id][0]._id),
  "constraints": constraints[]->{_id, title, kind, params, version},
  "previous": *[_type == "verdict" && poem._ref == ^._id]{"constraintId": constraint._ref, ok}
}`

function verdictDoc(poemId: string, c: {_id: string; version?: number}, ok: boolean, failures: Failure[], by: CheckedBy, at: string) {
  return {
    _id: verdictId(poemId, c._id),
    _type: 'verdict',
    poem: {_type: 'reference', _ref: poemId, _weak: true},
    constraint: {_type: 'reference', _ref: c._id, _weak: true},
    constraintVersion: c.version ?? 1,
    ok,
    failures: failures.slice(0, 50).map((f, i) => ({_key: `f${i}`, ...f})),
    checkedAt: at,
    checkedBy: by,
  }
}

export interface RecheckResult {
  poemsChecked: number
  broke: string[]
  fixed: string[]
}

/** Re-check one poem against all its constraints; write verdicts and status. */
export async function recheckPoem(client: LakeClient, poemId: string, by: CheckedBy, now = new Date().toISOString()): Promise<RecheckResult> {
  const poem = await client.fetch<PoemRow | null>(`*[_id == $id][0]${POEM_PROJECTION}`, {id: poemId})
  if (!poem) return {poemsChecked: 0, broke: [], fixed: []}
  return writePoems(client, [poem], () => true, by, now)
}

async function writePoems(
  client: LakeClient,
  poems: PoemRow[],
  include: (constraintId: string) => boolean,
  by: CheckedBy,
  now: string,
): Promise<RecheckResult> {
  const tx = client.transaction()
  const broke: string[] = []
  const fixed: string[] = []
  for (const poem of poems) {
    const lines = toLines(poem.text ?? '')
    const prevOk = new Map(poem.previous.map((v) => [v.constraintId, v.ok]))
    let allOk = true
    for (const c of (poem.constraints ?? []).filter(Boolean)) {
      const v = check(lines, c)
      if (!v.ok) allOk = false
      if (!include(c._id)) continue
      tx.createOrReplace(verdictDoc(poem._id, c, v.ok, v.failures, by, now))
    }
    const wasOk = (poem.constraints ?? []).filter(Boolean).every((c) => prevOk.get(c._id) !== false)
    if (wasOk && !allOk) broke.push(poem._id)
    if (!wasOk && allOk) fixed.push(poem._id)
    const status = allOk ? 'valid' : 'violated'
    tx.patch(client.patch(poem._id).set({status}))
    // Workflow conditions read the draft when one exists, so the draft must
    // carry the same status or a published poem's review would never see it
    // break. (Found by the workflow test bench, not in production.)
    if (poem.hasDraft) tx.patch(client.patch(`drafts.${poem._id}`).set({status}))
  }
  if (poems.length) await tx.commit({visibility: 'async'})
  return {poemsChecked: poems.length, broke, fixed}
}

/**
 * A constraint changed: bump its version, re-check every poem that references
 * it, record which poems flipped as a changeEvent. Returns the blast radius.
 */
export async function recheckConstraint(
  client: LakeClient,
  constraintId: string,
  opts: {by: CheckedBy; source?: string; fromParams?: unknown; now?: string},
): Promise<RecheckResult & {toVersion: number}> {
  const now = opts.now ?? new Date().toISOString()
  const c = await client.fetch<{_id: string; version?: number; params: unknown} | null>(
    `*[_id == $id][0]{_id, version, params}`,
    {id: constraintId},
  )
  if (!c) return {poemsChecked: 0, broke: [], fixed: [], toVersion: 0}
  const fromVersion = c.version ?? 1
  const toVersion = fromVersion + 1
  // Bump first, so verdicts written below carry the new version.
  await client.transaction().patch(client.patch(constraintId).set({version: toVersion})).commit()
  const poems = await client.fetch<PoemRow[]>(
    `*[_type == "poem" && !(_id in path("drafts.**")) && references($id)]${POEM_PROJECTION}`,
    {id: constraintId},
  )
  const result = await writePoems(client, poems, (id) => id === constraintId, opts.by, now)
  await client
    .transaction()
    // Deterministic id: a retried function invocation rewrites the same event
    // instead of logging the change twice.
    .createOrReplace({
      _id: `changeEvent-${constraintId.replace(/^drafts\./, '')}-v${toVersion}`,
      _type: 'changeEvent',
      constraint: {_type: 'reference', _ref: constraintId, _weak: true},
      fromVersion,
      toVersion,
      fromParams: opts.fromParams === undefined ? null : JSON.stringify(opts.fromParams),
      toParams: JSON.stringify(c.params ?? {}),
      at: now,
      source: opts.source ?? opts.by,
      poemsChecked: result.poemsChecked,
      broke: result.broke.map((id, i) => ({_key: `b${i}`, _type: 'reference', _ref: id, _weak: true})),
      fixed: result.fixed.map((id, i) => ({_key: `f${i}`, _type: 'reference', _ref: id, _weak: true})),
    })
    .commit()
  return {...result, toVersion}
}

/** Global document reference for a document in a dataset, as Workflows wants it. */
export const gdr = (projectId: string, dataset: string, id: string) => `dataset:${projectId}:${dataset}:${id}`

/** The slice of the workflow engine this module drives. */
export interface WorkflowTicker {
  instancesForDocument(args: {document: string}): Promise<{_id: string; currentStage?: string}[]>
  tick(args: {instanceId: string}): Promise<{instance: {currentStage?: string}}>
}

/**
 * After statuses change, re-evaluate every workflow instance watching those
 * poems. Transitions read the status; nothing else will tell the engine.
 */
export async function tickPoemWorkflows(
  engine: WorkflowTicker,
  where: {projectId: string; dataset: string},
  poemIds: string[],
): Promise<{instanceId: string; stage?: string}[]> {
  const moved: {instanceId: string; stage?: string}[] = []
  for (const id of poemIds) {
    const instances = await engine.instancesForDocument({document: gdr(where.projectId, where.dataset, id)})
    for (const inst of instances) {
      const r = await engine.tick({instanceId: inst._id})
      if (r.instance.currentStage !== inst.currentStage) moved.push({instanceId: inst._id, stage: r.instance.currentStage})
    }
  }
  return moved
}
