# Sanity Challenge build plan

Two entries, two repos, two DEV posts.

| | Path One | Path Two |
|---|---|---|
| Name | Transit Window | Lipogram Studio |
| One line | An agent that tells you which exoplanet transits you can actually see tonight, and which timing source to trust | A poetry studio where writing rules are documents; tighten one and every poem that now breaks it turns red, live |
| Judged on | Context + structured content, technical quality, Knowledge Base use, usability | Honest build writeup, functionality, schema, creativity (+ App SDK, Workflows bonus) |
| Repo | `transit-window` | `lipogram-studio` |

What every top entry had, and what both of these must have:
1. Proof, not adjectives: numbers anyone can rerun.
2. Code decides, the model explains.
3. Real Sanity features, used for what they are for. Nothing called a workflow that is only a status field.
4. A hosted demo a judge can open without logging in.
5. A writeup that admits what broke.

---

## 0. Setup you have to do (nothing below the line works without it)

1. Create a free account at sanity.io and one organization.
2. Organization Labs page (sanity.io/manage/org/labs): turn on Context and Knowledge Bases.
3. Two projects (or one project, two datasets; two projects is cleaner for judges):
   - `transit-window`, dataset `production`, public read.
   - `lipogram-studio`, dataset `production` (public read) and dataset `workflows`.
4. Tokens:
   - Project write token for each project (Editor).
   - Organization token with Context Viewer (Manage > API > Tokens, organization level). A project token is refused by Context MCP.
5. An Anthropic API key for the agent.
6. A Vercel account (free) for both frontends.
7. Put these in the environment's secrets, never in chat:
   `SANITY_TRANSIT_PROJECT_ID`, `SANITY_TRANSIT_WRITE_TOKEN`, `SANITY_LIPOGRAM_PROJECT_ID`, `SANITY_LIPOGRAM_WRITE_TOKEN`, `SANITY_ORG_ID`, `SANITY_ORGANIZATION_TOKEN`, `ANTHROPIC_API_KEY`.
8. Two empty public GitHub repos, or let me create them.

Steps only you can click (the Dashboard has no API for them): creating the two Context MCP endpoints, creating the Knowledge Base, adding its sources, pressing Build, and resolving issues. I will give exact values to paste.

---

## 1. Path One: Transit Window

### 1.1 The claim, already verified

- NASA Exoplanet Archive default ephemerides vs ExoClock's current ones, propagated to tonight: 646 planets matched, median gap 5.9 min, 256 off by 10+ min, 178 by 20+ min. Composite table (what most tools read): 333 of 772 off by 10+ min.
- Stricter cut: 45 of 340 differ by 10+ min AND by more than 3 sigma of the default's own stated error. This is the headline that survives an astronomer reading the comments.
- Examples: KELT-9b 18.8 min early, HAT-P-37b 18.4 min late, WASP-43b 8.2 min. WASP-4b, HD 189733b and WASP-33b have no T0 in their default row at all, so a naive query returns nothing.
- Caveats to state up front: TTV systems (TOI-216, K2-19) are excluded because a linear ephemeris is meaningless for them; mixed time systems (HJD-UTC vs BJD_TDB) are normalized before comparing.

Pitch for non-astronomers: "Four in ten planets in NASA's own database will cross their star at a different time than the database says. Show up at the wrong time and you miss it. This agent knows which source to trust, and shows its work."

### 1.2 User experience

1. Open the site. It asks for location (browser geolocation or a city) and telescope (aperture preset: phone-free 8 in, 12 in, 16 in, or "just show me").
2. It lists tonight's observable transits: start, mid, end in local time, altitude curve, depth, and a badge: "NASA default is 18.8 min off, using ExoClock (measured 2026-07)".
3. Click a planet: its timing history (every published ephemeris as a dot on a timeline, the drift line, which one won and why), and the sources.
4. Chat box: "Which transit tonight is best for a 8 inch scope from San Diego?" "Why don't you trust the NASA number for HAT-P-37b?" "Has WASP-12b's orbit changed?" The agent answers using Context tools, and every number in the answer is rendered from data, not typed by the model.
5. "Proof" page: the three-way eval table, rerunnable.

### 1.3 Architecture

```
Next.js app (Vercel)
  /            tonight's list (server computes with ephemeris engine)
  /planet/[n]  timing history + sources
  /ask         chat, Vercel AI SDK + Claude, tools:
                 Context MCP (GROQ endpoint)      -> structured data
                 Context MCP (KB endpoint)        -> prose, conflicts
                 compute_transits (local tool)    -> deterministic engine
  /proof       eval results

packages/ephemeris  pure TypeScript: propagate T0+nP with uncertainty,
                    BJD_TDB -> UTC (barycentric light time via astronomy-engine),
                    altitude, twilight, observability
scripts/ingest      NASA TAP + ExoClock -> Sanity documents
scripts/eval        3-arm eval, writes results JSON shown on /proof
studio/             Sanity Studio (schema, deployed, needed for Context GROQ mode)
```

Why two endpoints: an endpoint that has a dataset source serves GROQ tools and silently ignores Knowledge Base sources. So one endpoint for the dataset, one for the Knowledge Base, and the agent routes between them.

### 1.4 Schema (the part that makes keyword search fail)

```
star         name, ra, dec, vmag, teff, aliases[]
planet       name, aliases[], star -> star, period summary, depth_mmag,
             duration_h, ttvFlag, currentEphemeris -> ephemeris (set by code),
             selection { rule, reason, deltaVsDefaultMin, sigma }
ephemeris    planet -> planet, t0 (number), t0System (BJD_TDB|HJD_UTC|BJD_UTC),
             t0Err, period, periodErr, epochDate, source -> source,
             origin (archive-default|archive-alt|exoclock), isArchiveDefault
source       kind (paper|catalog|archive-row), citation, bibcode, url,
             published, authors
observation  (optional, stretch) ExoClock O-C points: planet ->, time, ocMin
```

The selection rule (code, not model): prefer the ephemeris whose propagated uncertainty to tonight is smallest, among those consistent with the most recent measured timings; break ties by recency; never trust a T0 older than N years if a newer one exists with comparable errors. Store the rule name and the reason on the planet document, so the agent reads it and the page can show it.

Questions keyword search gets wrong, by construction:
- "When does HAT-P-37b transit tonight?" Keyword search returns the 2012 discovery paper's T0. Wrong by 18 min.
- "Which planets are observable after 10 pm from La Jolla deeper than 10 mmag?" Needs coordinates, a clock, and arithmetic. Text search cannot do it at all.
- "Is WASP-12b's period changing?" Needs the dated ephemeris list, not a page.

### 1.5 Knowledge Base (Sanity Context, beta, 150 docs)

Purpose: "Helps amateur and student observers decide which published timing for a transiting exoplanet to trust, and why sources disagree."

Sources (target ~120 docs):
- File source: abstracts and key sections (as Markdown) of ExoClock I, II, III; Ivshina and Winn 2022; WASP-12b orbital decay papers (Yee 2020, Maciejewski 2016/2018, Turner 2021); KELT-9b and HAT-P-37b timing papers; discovery papers for the 15 most-drifted bright targets.
- Website source: ExoClock project pages (methods, planet pages for the demo targets).
- Dataset source: the `planet` and `ephemeris` documents themselves (`*[_type=="planet" && name in [...]]{...}`), so the KB can raise conflicts between the archive default and ExoClock directly.

Expected real issues: "T0 for HAT-P-37b is X (Bakos 2012) vs Y (ExoClock III)"; "WASP-12b period constant vs decaying". Triage every issue, record real vs false positive with counts (the leaders reported "6 of 14 real"), and resolve the real ones with instructions such as "prefer ExoClock III over discovery-paper ephemerides when the latter predates 2018". Screenshot all of it.

What the agent uses the KB for: the "why" (why the source disagrees, what decay means, what to watch for). What it uses GROQ for: every number.

### 1.6 Agent design

- Model: Claude via Vercel AI SDK, tools from both MCP endpoints plus one local tool, `compute_transits(location, date, filters)`, which runs the deterministic engine over GROQ results.
- System prompt: numbers only from tool results; when stating a time, cite the ephemeris id and its source; when sources conflict, say which won and the stored reason; read the KB for explanations.
- Output contract: the model returns structured JSON (answer text + list of referenced ephemeris ids + transit rows). The UI renders the numbers from the referenced documents, so a hallucinated number cannot reach the screen. A validator rejects any number in the text that is not in the referenced rows.
- Initial context inlined into the system prompt to save a tool call.

### 1.7 Evaluation (the proof page)

- Question set: 40 questions in four kinds: tonight's midtime for a named planet (20), filtered observability lists (8), "which source should I trust and why" (8), trend questions like decay (4). 10 held out, written before the system was tuned.
- Ground truth: computed by an independent path (Python + astropy from ExoClock data), not by the TypeScript engine. Midtime counts as correct within 2 min.
- Arms: (A) Transit Window agent, (B) same model with BM25 keyword search over the same documents serialized as text, (C) same model, no tools.
- Report accuracy per kind, mean absolute timing error, and every failure with a sentence on why. `npm run eval` reruns it. Results JSON committed and rendered on /proof.

### 1.8 Correctness work (biggest risk)

- BJD_TDB to UTC: barycentric light time up to about 8 min, the same size as the effect being sold. Implement with astronomy-engine and test against astropy for 50 planets and 10 dates: max error under 10 s.
- HJD_UTC and BJD_UTC rows: convert before comparison; tests for each.
- TDB minus UTC: 69.184 s plus a periodic term under 2 ms; constant is fine.
- Altitude and twilight: test against astropy for the same set.
- The aggregate statistic (45 of 340) recomputed from scratch by a script in the repo, with the exact filter written next to the number.

### 1.9 Frontend

Next.js App Router, Tailwind, deployed on Vercel. Pages: tonight, planet detail with a timing chart (published T0s as dots with error bars vs epoch, drift line), ask, proof, about (sources, licenses). No login. Location remembered in localStorage.

### 1.10 Writeup outline (DEV post)

Hook with the number. Demo GIF. What I built. How I used Sanity: schema diagram, the two endpoints, KB screenshots with issue triage counts, the selection rule. Proof table. What broke (the time-system bug, the Cloudflare block on TAP, the KB issues that were false positives). Limits (TTV systems excluded, ExoClock coverage only 776 planets). Project id and public dataset URL. Agent session.

---

## 2. Path Two: Lipogram Studio

### 2.1 What it is

A writing studio where constraints are content. Each constraint (no letter e, every line reuses a word from the line above, exactly 17 syllables, alphabet acrostic, no word repeated, a banned word list) is its own document with parameters. Each poem references the constraints it claims to follow. Change one constraint, and every poem that references it is re-checked; the ones that now fail flip to violated, live, with the offending line highlighted.

Second mode, same engine, said outright in the writeup: "Brand style rules". The same constraint documents become "never write 'utilize'", "headlines under 60 characters", "no exclamation marks". This is the part a Sanity customer recognizes.

### 2.2 Verified constraints on what Sanity can do (from the docs check)

- App SDK apps run in the Sanity Dashboard for logged-in project members, not for anonymous visitors. So the App SDK app is the editors' Constraint Console. The public site uses next-sanity live queries.
- Workflows engine is a library you drive; guards are advisory (Content Lake does not enforce them yet). Real enforcement goes in the Function and in transactions, and the writeup says so.
- Functions: document-triggered on change; scheduled ones run at most daily on the free plan. The demo needs no schedule.
- Recursion limit 16: the re-validation Function must write verdicts in a way that does not retrigger itself (verdicts are separate documents, and the trigger filter excludes them).

### 2.3 Schema

```
constraint   title, kind (lipogram|reuseWord|syllables|acrostic|noRepeat|
             bannedWords|maxLength|custom-regex), params (per kind),
             severity, description, version (number, bumped on change)
poem         title, author, lines[] (string), constraints[] -> constraint,
             collection -> collection, publishedAt
verdict      poem -> poem, constraint -> constraint, constraintVersion,
             ok (bool), failures[] { line, start, end, message },
             checkedAt, checkedBy (function|studio|cli)
collection   title, mode (poetry|brand), description
changeEvent  constraint ->, fromParams, toParams, at, poemsFlipped (count),
             flipped[] -> poem       (the cascade log, drives the replay)
```

Why this schema carries the idea: constraints are shared and referenced, so one edit has a blast radius that GROQ can compute (`*[_type=="poem" && references($id)]`). Verdicts are their own documents keyed to a constraint version, so you can ask "which poems were valid under version 3 but not version 4", which is the replay. The checker is pure TypeScript shared by the Studio input, the Function and the CLI, so all three agree.

### 2.4 Features, each doing real work

1. Custom Studio input (`lines` field): highlights violations as you type, using the shared checker.
2. Document action "Publish": refuses when a referenced constraint fails, says which line.
3. Sanity Function, document-triggered on `constraint` changes: finds referencing poems, re-checks them, writes verdicts and one `changeEvent`. Idempotent, retrigger-safe.
4. Workflows engine (`@sanity/workflow-engine`), definition `poem-review`: draft, constraint-check (system activity; the check effect runs the checker), review (human approve), published, and a violated stage that a poem returns to when a constraint change breaks it, then back to draft. The constraint Function fires the action that moves broken poems into violated. This is a process modeled as data, which is what the sponsor asked for.
5. App SDK app, Constraint Console (in the Dashboard): a live board of constraints, each with its blast radius; a slider to tighten a parameter with a "preview flips" count before committing; a live cascade view as verdicts arrive; uses the Workflows App SDK adapter to show and move poem instances.
6. Public site (Next.js): gallery of poems with live status; a "tighten the rule" demo button on a sandbox collection, rate-limited, so a judge without a login can trigger a cascade and watch poems turn red; a replay of every past cascade from `changeEvent`s.

### 2.5 Content

- 40 to 60 poems: a mix of written-for-this, public-domain (some famous lipograms and acrostics, credited), and AI-drafted ones that are labeled as such. Several deliberately sit on the edge of a constraint so tightening flips them.
- 10 constraints across kinds.
- Brand mode: one fake brand (clearly fictional) with 15 short blog posts and 8 style rules.

### 2.6 Writeup outline

This path is judged mostly on the process. Keep a `BUILD_LOG.md` from minute one: every prompt that mattered (verbatim), what the model got wrong, what I got wrong, how each was checked. Sections: what it is, demo, schema and why, each Sanity feature and what it actually enforces (advisory guards called out), friction log, what is still rough, project id and public dataset, agent session.

---

## 3. Order of work

Everything not needing credentials first, so nothing waits on setup.

Phase A, no credentials (starting now)
1. Transit: ingest script (TAP + ExoClock, normalize time systems), ephemeris engine in TS, astropy cross-check tests, selection rule, aggregate statistic script.
2. Transit: Studio schema, NDJSON export ready for `sanity dataset import`.
3. Transit: KB source pack (Markdown files of paper abstracts and sections, with citations).
4. Transit: eval question set and independent ground truth.
5. Lipogram: shared checker library with tests for every constraint kind.
6. Lipogram: schema, seed content, Studio custom input and document action.
7. Both: Next.js frontends against local fixture data.
8. `BUILD_LOG.md` in both repos from the start.

Phase B, with credentials
1. Import datasets, deploy schemas and Studios.
2. Create Context endpoints (GROQ + KB), build the KB, triage and resolve issues, screenshots.
3. Wire the agent, run the eval, publish /proof.
4. Lipogram: deploy the Function, deploy the workflow definition, build and deploy the App SDK console, wire the public site.
5. Deploy both to Vercel; smoke-test as a logged-out judge.

Phase C, submission
1. Record demo videos as soon as each works.
2. Write both posts, fill the templates, include project ids and public dataset URLs, upload agent sessions after scrubbing secrets, publish.

## 4. Acceptance checks before publishing

- Transit: timing engine within 10 s of astropy on the test set; eval reruns with one command; every number on screen traceable to a document; KB issues shown with real/false counts; site works logged out on a phone.
- Lipogram: tightening a constraint flips the expected poems within a few seconds, verified by a script; the Function never retriggers itself; the workflow instance visibly moves to violated and back; the App SDK console runs in the Dashboard; the public cascade button works logged out.
- Both posts: no claim without a link, a number or a screenshot behind it.

## 5. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Knowledge Bases not enabled or the build fails | Keep GROQ mode as the core; say so honestly in the post (one top entry did) |
| Time-system bug | The astropy cross-check test blocks deploy |
| Workflows early-access breakage | Pin exact versions; if blocked, the Function plus transactions still enforce, and the post says what failed |
| App SDK console cannot be deployed | Run it as a Studio tool, say so |
| NASA TAP blocks requests | Already worked around (user agent, one planet per query or full pull); cache the pull in the repo |
| Model invents a number | Output contract + validator; numbers rendered from documents |
