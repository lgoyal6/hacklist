# Handoff: finish and submit two DEV x Sanity Challenge entries

You are taking over two nearly finished hackathon projects. Your job is to deploy them against real Sanity infrastructure, verify every claim, write two honest DEV posts, and publish both before the deadline. Read this whole file before running anything.

## 0. Hard facts

- **Deadline: Sunday, October 4, 2026, 11:59 PM PDT** (Monday, October 5, 06:59 UTC). A post published after that does not count. Check the clock now (`TZ=America/Los_Angeles date`) and budget accordingly. If less than 3 hours remain, follow the triage plan in section 9 exactly.
- Challenge page: https://dev.to/challenges/sanity-2026-09-16. Two paths, one post per path, tag `#sanitychallenge`. **Every post must include a Sanity project ID or a public dataset URL**, or it may be treated as incomplete.
- Path One ("Ship an Agent That Queries Real Content", 3 winners) judges: meaningful use of Sanity Context and structured content, technical implementation, use of Knowledge Bases, usability. The sponsor's bar: "an agent that only works because the content was structured; if a keyword search would have gotten you the same answer, aim higher."
- Path Two ("Vibe-Code Something Strange", 2 winners) judges: quality and honesty of the build writeup, functionality, schema thoughtfulness, creativity. Bonus for the App SDK and Workflows. "A rough app with an honest writeup beats a polished one with three sentences."
- The owner is Laksh Goyal (GitHub `lgoyal6`, email lgoyal@ucsd.edu). He must supply every credential and click every Sanity Dashboard step listed in section 3. You cannot create Sanity accounts, enable Labs features, or create organization tokens yourself. Ask for them in one message, early, with the exact list in section 3.
- Writing style for anything published under Laksh's name: plain language, no em dashes, no bold for emphasis, no filler. Never invent a number. Never claim a feature works unless you watched it work against the real service.

## 1. Where the code is

Repository `lgoyal6/hacklist`, branch `claude/wonderful-lamport-qgx04u`, folder `sanity-challenge/`:

```
sanity-challenge/
  HANDOFF.md            this file
  BUILD_PLAN.md         the original plan (architecture, schemas, eval design, writeup outlines)
  transit-window/       Path One project (plain copy of HEAD)
  lipogram-studio/      Path Two project (plain copy of HEAD)
  bundles/
    transit-window.bundle    full git history (8 commits)
    lipogram-studio.bundle   full git history (9 commits)
```

Each project should become its own **public** GitHub repo, because judges need a code link. Restore history from the bundles, not the plain copies:

```sh
git clone --branch claude/wonderful-lamport-qgx04u https://github.com/lgoyal6/hacklist.git
mkdir work && cd work
git clone ../hacklist/sanity-challenge/bundles/transit-window.bundle transit-window
git clone ../hacklist/sanity-challenge/bundles/lipogram-studio.bundle lipogram-studio
# then, with Laksh's permission, create github.com/lgoyal6/transit-window and github.com/lgoyal6/lipogram-studio (public)
cd transit-window && git remote set-url origin https://github.com/lgoyal6/transit-window.git && git push -u origin main
cd ../lipogram-studio && git remote set-url origin https://github.com/lgoyal6/lipogram-studio.git && git push -u origin main
```

Before pushing, grep both repos for secrets (`grep -rEn "sk-ant|skp|token\s*[:=]\s*['\"][A-Za-z0-9]{20,}" --exclude-dir=node_modules`). No secret is committed today; keep it that way. Commit as `Laksh Goyal <lgoyal@ucsd.edu>`.

Runtime: Node 22 (Sanity Functions run on Node 24; use 24 for `sanity functions` commands if available). Python 3.11 with `astropy`, `numpy` is needed only to regenerate Transit Window's eval answer key and astropy test fixture (both are already committed).

Both repos must pass before you change anything: `npm install && npm test` (Transit Window: 24 tests; Lipogram Studio: 23 tests) and `npx tsc -p .` clean. If either fails on a fresh clone, fix that first.

## 2. What each project is, and its state

### 2a. Transit Window (Path One)

An agent and site that tell an amateur astronomer which exoplanet transits they can see tonight, and which published timing ("ephemeris") to trust. The structure is the point: every published timing solution is a Sanity document referencing its planet and source; code (not the model) picks one; the agent explains the pick using Sanity Context.

Verified findings (recompute with `npm run stats`; they come from `data/findings.json`):
- Population: 498 planets in both the NASA Exoplanet Archive and ExoClock, where the selection rule trusts ExoClock, excluding TTV systems, with a usable NASA default.
- NASA's default ephemeris is off by 10+ minutes for 175 of 498 (35%), 20+ minutes for 109, median 5.2 minutes. 33 are off by 10+ minutes AND by more than 3 sigma of their own stated error ("confidently wrong").
- **XO-3b**: the archive's default row (Rusznak et al.) has T0 = 2457424.98786. The paper itself (arXiv:2412.04438, fitted-parameter table, "Time of conjunction - 2457417: 0.98762") gives 2457417.98762. That is 7.00024 days, not a whole number of 3.19-day orbits, so predictions from the NASA default are about 888 minutes (15 hours) off. This is a real error in NASA's database and the headline example. Quote it exactly; do not exaggerate it.
- Timing engine (TypeScript, astronomy-engine) agrees with astropy to 0.027 s on BJD_TDB to UTC for 50 planets, 0.025 s on HJD_UTC to BJD_TDB, altitudes within 0.006 degrees. The "observable tonight" planner matches astropy's answer exactly for 6 nights (`tests/tonight.test.ts`).
- Pitch the number as "about 1 in 3", not "4 in 10".

Layout:
- `lib/time.ts` time systems; `lib/ephemeris.ts` propagation; `lib/observe.ts` altitude/twilight; `lib/select.ts` the selection rule (corroboration: a solution needs at least one other agreeing solution; ExoClock preferred when its tonight-sigma is within 2x of the best; else smallest propagated sigma; unknown time systems never used); `lib/tonight.ts` planner; `lib/queries.ts` GROQ; `lib/local.ts` offline fixtures; `lib/sanity.ts` data access with fixture fallback; `lib/agent.ts` the agent.
- `scripts/ingest.ts` (NASA TAP + ExoClock -> `data/catalog.json`, gitignored, ~19 MB), `scripts/export-sanity.ts` (-> `data/sanity.ndjson`, 7,482 docs, plus committed fixtures `data/planner-fixture.json`, `data/planet-details/*.json`), `scripts/stats.ts`, `scripts/oracle.py` (astropy fixture), `scripts/kb_pack.py` (writes `kb/papers/*.md`, 21 files, already committed).
- `eval/questions.json` (45 questions: 28 midtime, 6 observable, 9 trust, 2 trend; 10 held out; truth from astropy over ExoClock), `eval/build_questions.py`, `eval/run.ts` (three arms: A agent via Sanity Context, B BM25 keyword search plus a propagation calculator over the same documents, C model alone).
- `app/` Next.js 16 site: `/` tonight list, `/planet/[slug]` timing history chart, `/ask` chat, `/proof` findings and eval table, `/about`. Works offline from committed fixtures.
- `studio/` Sanity Studio v6 (schema: star, planet, ephemeris, source).
- `SETUP.md` exact dashboard values; `BUILD_LOG.md` honest log; `README.md`.

Not yet done: nothing has touched a real Sanity project; the Knowledge Base and Context endpoints do not exist; the agent has never run against real MCP endpoints or a real API key; the eval has never run; nothing is deployed.

Agent details you must not break:
- Calls Claude through the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`), model `claude-opus-5-5`, `client.beta.messages.create` with `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`, `output_config: {effort: 'medium'}`. Do not add `thinking: {type: 'disabled'}` or `budget_tokens` (400 on this model). Do not use forced `tool_choice` `any`/`tool` (400). Handle `stop_reason === 'refusal'`.
- MCP via `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` with `Authorization: Bearer <organization token>`. Tools are namespaced `data__*` (GROQ endpoint) and `kb__*` (Knowledge Base endpoint). Two endpoints are required because an endpoint with a dataset source serves GROQ tools and silently ignores Knowledge Base sources.
- Local tools `predict_transit` and `plan_night` are declared with `strict: true` and nullable union types (`type: ['number','null']`). If the API rejects the schema, drop `strict: true` rather than changing semantics.
- After the loop, `checkAgainstEvidence` verifies every time, decimal and 3+ digit integer in the answer appears in tool output. Keep it.

### 2b. Lipogram Studio (Path Two)

Writing rules stored as content. A constraint ("no e", "5-7-5", "never write utilize") is a document; poems reference the constraints they keep. Change a constraint and a Sanity Function re-checks every referencing poem, writes a verdict document per poem, logs a `changeEvent` (who broke, who recovered), and ticks each poem's `poem-review` workflow so a published poem moves itself to `violated` and back when the rule loosens. The same engine is a brand style guide (fictional "Northwind Coffee").

Layout:
- `packages/checker` the one rule implementation (lipogram, univocalic, reuseWord, syllables via the `syllable` package, acrostic, noRepeat, bannedWords, maxLineLength, lineCount, forbiddenPattern). 16 tests.
- `packages/engine` `recheckConstraint`, `recheckPoem`, `tickPoemWorkflows`, `verdictId`, `gdr`. Writes status to the published poem AND its draft (workflow conditions read the draft when one exists; found by the bench). Uses patch builders (`client.patch(id).set()` passed into `transaction().patch()`), deterministic changeEvent ids `changeEvent-<constraint>-v<version>`.
- `functions/recheck-constraint`, `functions/recheck-poem`, `functions/shared.ts`, `sanity.blueprint.ts`. Filters: `_type == "constraint" && (delta::operation() == "create" || delta::changedAny(params))` with projection `{_id, "fromParams": before().params}`; `_type == "poem" && (delta::operation() == "create" || delta::changedAny((text, constraints)))`. The functions never write the fields their filters watch (tested), so they cannot loop.
- `workflows/poem-review.ts` stages drafting, checking, review, published, violated. Roles use Sanity's real project role names (`contributor`, `editor`, `administrator`) because the engine matches roles literally. `workflows/*.test.ts` run the real engine in `@sanity/workflow-engine-test` including a full end-to-end loop. `sanity.workflow.ts` deployment `production`, tag `prod`, workflow dataset `<projectId>.workflows`, `expectedMinReaderModel: 10`. `npx sanity-workflows deploy --check` passes.
- `studio/` Studio v6: schema (collection, constraint, poem, verdict, changeEvent), `components/ConstrainedTextInput.tsx` (live highlighting), `actions/checkedPublish.tsx` (refuses broken poems).
- `console/` App SDK app ("Constraint Console") for the Sanity Dashboard: Rules tab (blast radius, preview, commit), Changes tab, Workflow tab (`@sanity/workflow-sdk` `useWorkflowInstances` / `useWorkflowSession`). Root `package.json` has `overrides: {"@sanity/sdk": {"@sanity/mutate": "0.18.2"}}` per the Workflows docs.
- `web/` Next.js 16 public site: `/`, `/c/[slug]` (collection; sandbox controls with preview-before-apply; polls for the function's result), `/p/[id]`, `/how`, `/api/sandbox` (validated, rate-limited, sandbox collections only; live mode only patches params and the Function does the rest; offline mode runs the engine on an in-memory GROQ lake via `groq-js`).
- `seed/content.ts` 3 collections, 15 constraints, 38 pieces (public domain: Gadsby opening 1939, Carroll's ALICE PLEASANCE LIDDELL acrostic 1871, Poe's ELIZABETH acrostic 1829; the rest labelled "AI draft, labelled", author "Studio desk"). `seed/check.ts` validates all against the checker (0 broken). `seed/build-ndjson.ts` -> `seed/seed.ndjson` (138 docs, no dotted ids).
- `scripts/start-workflows.ts` starts a `poem-review` instance per poem and walks valid ones to published. **Unverified**: the `startInstance` `initialFields` shape `{name: 'subject', value: {id, type}}` was written without a live test. Before running it against the real dataset, check the engine's `StartInstanceArgs` type in `node_modules/@sanity/workflow-engine/dist/index.d.ts` and how `subjectField()` in `@sanity/workflow-engine-test` builds the entry, and match that shape.

Verified offline: in a real browser, banning the letter "o" in the pressure chamber flipped 11 of 11 relevant poems in 0.1 s with correct highlighting and change log. Not yet done: no real Sanity project, Functions not deployed, workflow not deployed, console not run in the Dashboard, site not deployed.

## 3. Ask Laksh for these, in one message

Send this list verbatim (fill nothing in yourself). Tell him to put secrets in the environment or a local `.env` file, never in chat or git.

Sanity (sanity.io/manage):
1. Organization id.
2. Labs page of the organization: enable **Context** and **Knowledge Bases**.
3. Project `transit-window`: dataset `production`, visibility public. Project API token with Editor role.
4. Project `lipogram-studio`: datasets `production` (public) and `workflows` (private). Two Editor tokens (one for scripts, one for the website sandbox route). CORS origins: the deployed site URL and `http://localhost:3333`.
5. An **organization** API token with **Context Viewer** (Manage > API > Tokens at organization level; a project token is refused with 403 `contextGrantRequired`).
6. `npx sanity login` on the machine you run from (needed for blueprints, functions, workflows, app deploy).
Other:
7. Anthropic API key (for the Transit Window agent and eval).
8. Vercel account (or token) for deploying both Next.js sites.
9. Permission to create two public GitHub repos under `lgoyal6`.

Then he must click these in the Sanity Dashboard (you prepare the exact values from `transit-window/SETUP.md` sections 3 and 4 and paste them to him): create the Knowledge Base `Transit timing` with the purpose text, upload the 21 files from `kb/papers/`, add the 7 ExoClock website pages, add the dataset source with the GROQ query given in SETUP.md, press Build entries, then create MCP endpoints `transit-window-data` (dataset source, groqFilter `_type in ["planet", "ephemeris", "source", "star"]`, the instructions text in SETUP.md) and `transit-window-kb` (Knowledge Base source). Ask him to screenshot the Issues view before resolving anything, and to tell you for each issue whether it is real; you need the counts for the post.

## 4. Transit Window: deploy and verify, in this order

Environment (`transit-window/.env.example` lists all): `SANITY_STUDIO_PROJECT_ID`, `SANITY_WRITE_TOKEN`, `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET=production`, `SANITY_ORGANIZATION_TOKEN`, `SANITY_CONTEXT_GROQ_URL`, `SANITY_CONTEXT_KB_URL`, `ANTHROPIC_API_KEY`.

1. `npm install && npm test && npx tsc -p .`
2. `npm run ingest -- --refresh` (refetch NASA data; the TAP endpoint needs a non-curl user agent, already set) then `npm run export` then `npm run stats`. If the numbers moved, update every place they appear: `data/findings.json` drives the site, but also `README.md`, `app/page.tsx` text is generated from findings, and your post.
3. Import: `cd studio && npm install && npx sanity dataset import ../data/sanity.ndjson production --replace --token "$SANITY_WRITE_TOKEN"`. Verify: `curl "https://$PID.api.sanity.io/v2026-10-01/data/query/production?query=count(*[_type=='planet'])"` without a token returns 776 (public dataset, no dotted ids).
4. `npx sanity schema deploy` (Context GROQ mode refuses to serve without it: JSON-RPC -32004). Optionally `npx sanity deploy` for a hosted Studio.
5. After Laksh creates the endpoints: list tools on both with the curl in SETUP.md section 4. Expect `initial_context`, `groq_query`, `schema_explorer`, `array_field_reader` on data; `initial_context`, `knowledge_base_read` on kb.
6. Smoke-test the agent locally: `npm run dev`, open `/ask`, ask the four example questions. Each answer must show a tool trace and "every number checked against retrieved data". Fix anything that breaks; likely spots: tool input schema acceptance, MCP tool result shapes, the planet name format ("HAT-P-37b", no spaces).
7. Run the eval: `npm run eval -- --split all` (180 model calls across arms; tell Laksh the rough cost first: a few dollars at Opus 5.5 rates). It writes `eval/results.json`, which `/proof` renders. Report the real numbers whatever they are. If arm A loses somewhere, say where and why in the post. Do not tune on the held-out split; if you change prompts after seeing results, rerun and report both runs.
8. Deploy to Vercel (root of the repo, framework Next.js) with the env vars. `data/` fixtures are committed so the site works even if Sanity is slow. Check on a phone-width viewport and logged out: `/`, `/planet/xo-3b`, `/proof`, `/ask`. The `/api/ask` route has an in-memory rate limit (12 questions per 10 minutes per IP).
9. Record a 60 to 90 second screen capture: the tonight list, XO-3b's page (the off-chart NASA default), one `/ask` answer with the tool trace, the `/proof` table, and the Knowledge Base Issues view in the Dashboard.

## 5. Lipogram Studio: deploy and verify, in this order

Environment: `SANITY_PROJECT_ID`, `SANITY_ORG_ID`, `SANITY_WRITE_TOKEN`, `SANITY_SANDBOX_TOKEN`, `SANITY_STUDIO_PROJECT_ID` (same id), `SANITY_APP_PROJECT_ID` (same id), `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET=production`.

1. `npm install && npm test && npx tsc -p . && npx tsc -p studio && npx tsc -p console`
2. `npx tsx seed/check.ts` (must print 0 broken), `npx tsx seed/build-ndjson.ts`, then from `studio/`: `npx sanity dataset import ../seed/seed.ndjson production --replace`, `npx sanity schema deploy`, `npx sanity deploy` (hosted Studio, studioHost `lipogram-studio`; pick another if taken).
3. Functions: `npx sanity blueprints init . --type ts --stack-name production --project-id $SANITY_PROJECT_ID` if no `.sanity/blueprint.config.json` exists. Keep the existing `sanity.blueprint.ts` (do not let init overwrite it; restore from git if it does). `npx sanity blueprints doctor` must pass. Then `SANITY_PROJECT_ID=... npx sanity blueprints deploy`. The functions import `@lipogram/engine` from the workspace; if the deploy bundler cannot resolve it, read https://www.sanity.io/docs/blueprints/project-layout-and-monorepos.md and either list it in a function-level `package.json` or inline it. Set function env vars `WORKFLOW_TAG=prod`, `WORKFLOW_DATASET=workflows` if the blueprint supports it (see https://www.sanity.io/docs/functions/function-env-vars.md); the defaults in `functions/shared.ts` already match.
4. Workflow: `SANITY_PROJECT_ID=... npx sanity-workflows deploy` (run `--check` first). Then fix and run `scripts/start-workflows.ts` (see the unverified note in 2b). Expected: every valid poem ends in `published`.
5. Verify the full loop for real, and keep the evidence:
   - In the Studio, edit constraint "No e" to letters `ea` and publish. Within seconds: `npx sanity functions logs recheck-constraint` shows "N poems checked, M broke"; affected poems have `status: "violated"`; a `changeEvent-constraint-no-e-v2` document exists; their workflow instances are in `violated`.
   - Set it back to `e`. Poems recover and instances return to `published`.
   - Confirm the function did not retrigger itself (one invocation per publish in the logs).
   - Edit a poem's text in the Studio to break a rule: the input highlights it live, Publish is disabled with the reason; force-publish via the API and confirm `recheck-poem` marks it violated.
   If any step fails, fix it, and write what failed and how you fixed it into `BUILD_LOG.md`. These are the most valuable sentences in the Path Two post.
6. Console: `cd console && SANITY_ORG_ID=... SANITY_APP_PROJECT_ID=... npx sanity dev`, open the printed Dashboard URL (not Safari), check all three tabs, commit a rule change from the Rules tab and watch the Workflow tab move a poem. Then `npx sanity deploy`. If the workflow tab errors, record the error honestly; do not fake it.
7. Website: deploy `web/` to Vercel (root directory `web`; the build needs the monorepo root installed, so set the Vercel root to the repo root with build command `npm run build -w lipogram-web` and output `web/.next`, or configure the root directory `web` with "include files outside root"). Env: `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`, `SANITY_SANDBOX_TOKEN`. Logged out, ban a letter in `/c/chamber` and watch "Waiting for the recheck function" turn into "Rechecked N poems in X s". Note the real latency for the post.
8. Record a 60 to 90 second capture: Studio input highlighting and refused publish, the pressure chamber cascade on the public site, the console Rules preview and Workflow tab moving a poem to violated.

## 6. Known gotchas (already hit; do not rediscover them)

- Sanity document ids containing a dot are not readable without a token. All exports use dashes. Keep it so.
- Free plan: 10,000 documents per dataset (Transit Window uses 7,482); scheduled functions at most daily (nothing here needs a schedule).
- Context MCP: project tokens are refused; GROQ mode needs a deployed schema; dataset + KB on one endpoint ignores the KB.
- Knowledge Bases are beta, 150 documents per KB. The planned KB is about 60 documents.
- NASA TAP returns a Cloudflare HTML page with HTTP 200 for curl's default user agent, and rejects `IN (...)` and `%`. The ingest handles both.
- `@sanity/ui` v4: `Stack`/`TabList` use `gap` not `space`; `Grid` uses `gridTemplateColumns` not `columns`; `Badge` has no `mode`. `sanity build` does not type-check, so always run `tsc`.
- Workflows 0.36.0: actor ids must be account-global (`g...`) in the test bench; roles are matched literally against Sanity project roles; conditions read the draft of the subject when one exists; the in-memory client needs patch builders and explicit `_id`s; guards are advisory today (Content Lake does not enforce them). Keep all `@sanity/workflow-*` packages on the exact same version.
- App SDK apps run inside the Sanity Dashboard for logged-in members, not for anonymous visitors. The public site therefore uses plain queries and polling.
- Sanity Functions recursion: never write a field a function's filter watches.

## 7. The two DEV posts

Use the official prefill templates (open these URLs to start each post; keep every heading):
- Path One: https://dev.to/new?prefill=---%0Atitle%3A%20%0Apublished%3A%20%0Atags%3A%20devchallenge%2C%20sanitychallenge%2C%20sanity%2C%20ai%0A---%0A%0A%2AThis%20is%20a%20submission%20for%20the%20%5BSanity%20Challenge%2C%20Path%20One%3A%20Ship%20an%20Agent%20That%20Queries%20Real%20Content%5D%28https%3A%2F%2Fdev.to%2Fchallenges%2Fsanity-2026-09-16%29%2A%0A%0A%23%23%20What%20I%20Built%0A%0A%23%23%20Demo%0A%0A%23%23%20Code%0A%0A%23%23%20How%20I%20Used%20Sanity%0A%0A%23%23%20Sanity%20Project%20Details%0A%0A%23%23%20Agent%20Session%0A
- Path Two: https://dev.to/new?prefill=---%0Atitle%3A%20%0Apublished%3A%20%0Atags%3A%20devchallenge%2C%20sanitychallenge%2C%20sanity%2C%20ai%0A---%0A%0A%2AThis%20is%20a%20submission%20for%20the%20%5BSanity%20Challenge%2C%20Path%20Two%3A%20Vibe-Code%20Something%20Strange%5D%28https%3A%2F%2Fdev.to%2Fchallenges%2Fsanity-2026-09-16%29%2A%0A%0A%23%23%20What%20I%20Built%0A%0A%23%23%20Demo%0A%0A%23%23%20Code%0A%0A%23%23%20My%20Build%20Process%0A%0A%23%23%20Sanity%20Project%20Details%0A%0A%23%23%20Agent%20Session%0A

Draft both as Markdown files first (`transit-window/POST.md`, `lipogram-studio/POST.md`), show them to Laksh, and let him paste and publish (he owns the DEV account). The judges at the top of the field reward: measured evidence with baselines, real Knowledge Base issues shown and triaged with counts, code deciding while the model explains, a hosted demo, and an honest list of failures. They punish buzzwords, self-graded perfect scores, and features named but not used (a status field called a workflow, a fake App SDK).

Path One post (title suggestion: "NASA's exoplanet archive gives the wrong transit time for 1 in 3 planets. My agent knows which source to trust."):
- What I Built: the problem in two sentences; who it is for; the 175 of 498 number with its population definition; XO-3b.
- Demo: live URL, the video, a screenshot of XO-3b's chart.
- Code: repo link.
- How I Used Sanity: schema (planet, star, ephemeris, source) and why every published solution is its own document; the selection rule and that it is stored on the planet with its reason; the two Context endpoints and why two; which tools the agent used (from real traces); the Knowledge Base sources, purpose, and the real Issues it raised with counts (real vs false positive) and how they were resolved; the numbers check on every answer; the three-arm eval table with real results and every failure explained; limits (TTV systems excluded, ExoClock coverage of 776 planets, Earth-centre times).
- Sanity Project Details: project id and the public dataset URL, e.g. `https://<id>.api.sanity.io/v2026-10-01/data/query/production?query=*[_type=="planet" && name=="XO-3b"]{name, selection, "solutions": *[_type=="ephemeris" && references(^._id)]{isArchiveDefault, t0BjdTdb, "source": source->citation, assessment}}`.
- Agent Session: optional; if uploading a transcript at https://dev.to/agent_sessions/new, scrub keys and make it public.

Path Two post (title suggestion: "I made writing rules into documents. Tighten one and every poem that breaks it turns red."):
- What I Built: constraints as content; the pressure chamber; the style-guide mode and why a Sanity customer would care (banned brand terms, compliance phrasing).
- Demo: live URL, video, screenshots.
- Code: repo link.
- My Build Process: this is the heart of the score. Use `BUILD_LOG.md` plus what happened during deployment. Include: the docs check that changed the plan (App SDK is Dashboard-only, guards are advisory); the syllable counter that failed its own test; the checker catching 4 of the seed drafts ("coffee" in a no-e poem, "caked", "cocoa"/"Gone" in an o-only poem, "ink" under the 4-letter chain minimum); the bench finding that workflow conditions read drafts (a real production bug avoided); `g`-prefixed actor ids contradicting the docs example; the role-name fix; the @sanity/ui v4 renames; the mutate override; every failure from section 5 step 5. Say which parts an AI agent wrote and how they were checked. Show 3 to 5 real prompts if Laksh has them; do not fabricate prompts.
- Sanity Project Details: project id and a public dataset query URL (e.g. all constraints with their usage counts).
- Say plainly what enforces what: the Function and the publish action enforce; the workflow records and moves; guards are advisory.

## 8. Definition of done

- Two public repos with history, tests green, no secrets.
- Transit Window deployed; agent answers against real Context endpoints; eval run and shown on `/proof`; Knowledge Base built with issues triaged.
- Lipogram Studio deployed: Studio, Functions, workflow, console, public site; the tighten/loosen loop verified live with logs.
- Both posts drafted, reviewed by Laksh, published with `#sanitychallenge` before the deadline, each with project id and dataset URL.
- `BUILD_LOG.md` in each repo updated with everything that broke during deployment.

## 9. Triage if time is short

The order below maximizes the chance both entries count. Stop each item at "works and is honest", then move on.

1. (Both, 10 min) Push both repos public. Get the Sanity projects and tokens from Laksh.
2. (Path Two, 30 min) Import seed, deploy schema and Studio, deploy Functions, verify one tighten/loosen cycle from the Studio with function logs. Deploy `web/` to Vercel. Skip the console and workflow deploy if time is under 90 minutes total; say so in the post.
3. (Path One, 30 min) Import data, deploy schema, deploy the site to Vercel (it works without the agent). If Laksh can create the Context GROQ endpoint quickly, wire `/ask` against it; the Knowledge Base build can run in parallel. If the eval cannot run in time, publish the findings, the astropy cross-check, and a smaller hand-run comparison of the agent against keyword search on 5 questions, clearly labelled as such.
4. (Both, 30 min) Write and publish both posts from the outlines above. Publishing a complete, honest post on time beats a better post after the deadline.
5. If time remains after publishing, finish the console, workflow, KB issues and full eval, then update the posts (edits after publishing are allowed; note them as updates).
