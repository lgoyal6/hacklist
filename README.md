# Hacklist SF

Public hackathons in the SF Bay Area and San Diego - including externally hosted
events linked from Luma calendars - discovered automatically, ranked by signal,
and published as a subscribable calendar per region.

> The project is `hacklist`; it covers three boards, Hacklist SF, Hacklist San
> Diego and Hacklist Online. Two identifiers deliberately keep the older
> `hacklist-sf` spelling and should not be "fixed":
>
> - the **deployed Worker hostname** below, because the published `calendar.ics`
>   feeds hang off it and a subscribed calendar that starts 404ing does not warn
>   anyone, it just stops updating;
> - the **ICS UID namespace** in `app/calendar.ics/route.ts`, because a changed
>   UID makes every client treat every event as new and duplicate the lot.

- **Site:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev
- **Bay Area feed:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev/calendar.ics
  (add this URL to Google/Apple/Outlook Calendar to subscribe)
- **San Diego feed:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev/calendar.ics?region=san-diego

## How it works

Seven sources feed one classifier. None of them costs anything, and none needs an
API key.

**Direct APIs - keyless, structured, and they work from any IP.** These are the
reliable core.

1. `scripts/discover-luma-api.mjs` reads Luma's public discover feed
   (`api.lu.ma/discover/get-paginated-events`) twice over: once with no place
   asked for, which returns whatever metro Luma geolocates the caller to - around
   900 upcoming Bay Area events in 19 requests and ten seconds from a residential
   address here - and once per region by `discover_place_api_id`, which returns
   that place's own discover slice from any address (86 for San Francisco, 6 for
   San Diego). It also hands back exact times, guest counts and registration state
   for events the other passes found by reading a page, and reports which
   calendars it saw hosting a hackathon so the crawl can seed itself.

   The parameter name is worth knowing about. This pass spent its whole life
   sending `place_api_id`, which the endpoint accepts and ignores: it answers with
   the caller's geolocated place instead. From here that still looked like San
   Francisco, so nothing appeared broken, and from a datacenter it was the
   datacenter's city - which is what "the feed is geolocated" was really
   describing. Measured directly: asking for San Diego with `place_api_id`
   returns San Francisco events, and with `discover_place_api_id` returns San
   Diego ones.
2. `scripts/discover-yc.mjs` reads Y Combinator's own events site, which hosts a
   steady stream of Bay Area hackathons that never appear on Luma.
3. `scripts/discover-devpost.mjs` reads Devpost's public hackathon API.

**Crawl - reaches what no feed indexes.**

4. `scripts/discover-sf.mjs` sweeps public Luma surfaces with a headless browser
   (Lightpanda + Playwright), starting from the seeds in `config/discovery.json`
   plus whatever calendars the API pass discovered, and expanding through event,
   organizer and co-host links. It reads Schema.org event lists embedded in
   public calendar pages and follows direct external event links. Raw candidates
   land in `data/discovery-output.json`.

**Best-effort - extras that depend on a residential IP.**

5. `scripts/discover-search.mjs` asks a search engine for events no calendar
   links to.
6. `scripts/discover-linkedin.mjs` reads public LinkedIn posts and articles for
   hackathons announced to a network rather than published to a calendar.
7. `scripts/discover-personalized.mjs` collects the events Luma recommends a
   signed-in account (local only; see below).

**Then:** `scripts/normalize-events.mjs` parses each candidate into a structured
record (dates, venue, city, status, prizes, tags), decides which region it
belongs to, scores it (40% hackathon confidence, 25% builder value, 20%
accessibility, 15% freshness) and writes `data/events.json`. Every sweep is snapshotted to `data/history/` and diffed into
`data/changes.json`. The site (`app/board.tsx`) and the ICS feed
(`app/calendar.ics/route.ts`) are generated from `data/events.json`.

Why the Luma API and the Luma crawl both run, rather than the API replacing the
crawl: they find different things, measured rather than assumed. The API surfaced
4 hackathons the crawl had missed; the crawl had 8 the API's feed never returned,
because they live on organizer calendars the feed does not surface. Dropping
either would cost coverage.

### The sweep, end to end

```mermaid
flowchart TD
  subgraph direct["direct APIs, keyless, work from any IP"]
    L["discover-luma-api.mjs<br/>~900 events in 19 requests"]
    Y["discover-yc.mjs"]
    D["discover-devpost.mjs"]
  end
  subgraph crawl["crawl, reaches what no feed indexes"]
    SF["discover-sf.mjs<br/>Lightpanda + Playwright<br/>Schema.org event lists"]
  end
  subgraph best["best-effort, needs a residential IP"]
    SE["discover-search.mjs"]
    LI["discover-linkedin.mjs"]
    PE["discover-personalized.mjs<br/>local only"]
  end
  L -.->|"seeds calendars it saw"| SF
  L & Y & D & SF & SE & LI & PE --> RAW[("data/discovery-output.json")]
  RAW --> NORM["normalize-events.mjs<br/>parse dates, venue, city,<br/>status, prizes, tags"]
  NORM --> SCORE["score: 40% hackathon confidence,<br/>25% builder value,<br/>20% accessibility, 15% freshness"]
  SCORE --> EV[("data/events.json")]
  EV --> SNAP[("data/history/ snapshot")]
  SNAP --> DIFF[("data/changes.json")]
  EV --> SITE["app/board.tsx"]
  EV --> ICS["app/calendar.ics/route.ts"]

  style EV fill:#1f6feb,color:#fff
```

The API pass and the crawl both run because they find different things, measured
rather than assumed: the API surfaced 4 hackathons the crawl missed, the crawl had
8 the feed never returned.

## Running it, and deploying it

The site and the ICS feed are one Cloudflare Worker, configured in
`wrangler.jsonc` with `ASSETS` and `IMAGES` bindings.

```bash
npm install          # Node 22.13 or newer, per `engines` in package.json
npm run dev          # local worker on http://localhost:3000
npm run build
npm run deploy       # vinext deploy, to Cloudflare
```

Only the last line needs a Cloudflare account. `npm run dev` serves the real
board and both ICS feeds on the first request, because `data/events.json` is
committed: `curl localhost:3000/calendar.ics` returns a subscribable calendar
without running a single discovery pass, and
`curl 'localhost:3000/calendar.ics?region=san-diego'` returns the other region.
That is the same split described below - the site never depends on a scraper
being up - and it is why a clone is worth looking at before you decide whether
to run the sweep.

The discovery passes are separate from the deploy: they write `data/events.json`,
which is committed, and the Worker serves whatever is in it. That split is why the
site never depends on a scraper being up, and why the best-effort passes can be
skipped in CI without breaking the build. See **Automation** below for the schedule
and **Local passes** for what must never run in CI.

## Provenance, deletion and retention

### Where a listed event came from

`discoveredVia` names the page a candidate was found on. That answers "which
site", not "which version of which file", and two sweeps a week apart produce
the same value from different data. So `data/events.json` carries two more
things:

- `meta.inputs` lists every input file the run read, each with the sha256 of its
  exact bytes. That names the revisions the board was built from.
- every event carries `provenance.inputs`, the subset of those revisions it came
  from, and `provenance.contentSha256`, a hash of the candidate fields the event
  is derived from.

`provenance.inputs` is a list because the deduplicator merges the same event
found on Luma with the same event found on Devpost, and the result comes from
both files.

The content hash covers `url`, `title`, `category`, `discoveredVia`,
`confidence`, `relevance` and `evidence`, in a fixed order. Fields nothing is
derived from are excluded, so an unrelated edit upstream does not read as a
changed record; absent and empty hash differently.

### Deleting or redacting an event

```bash
node scripts/redact-event.mjs --url https://luma.com/abc123 --reason "duplicate"
node scripts/redact-event.mjs --url https://... --redact organizer --reason "..."
```

A delete drops the event; a redact keeps the row and blanks the named fields. A
reason is required.

The record has to leave four places, and removing it from `data/events.json`
only covers two of them:

| surface | what it is | how it is cleared |
| --- | --- | --- |
| index | the rendered board | rebuilt from `data/events.json` |
| export | the `/calendar.ics` feed subscribers hold | rebuilt from `data/events.json` |
| cache | `data/luma-ledger.json`, which records the event as pushed to the public Luma calendar | the entry is deleted, so reconciliation can see the event again |
| next sweep | the sweep runs twice a day and finds the same page | a tombstone in `data/tombstones.json`, applied on every publish |

Without the tombstone the record is back within twelve hours. The tombstone
stores the content hash of what was removed, which identifies the record for a
later audit and does not reconstruct it. If `data/tombstones.json` cannot be
read the publish stops, because publishing without it would restore everything
ever deleted.

`scripts/verify-deletion.mjs` proves all four, by building the site before and
after a real deletion and fetching both routes from the built Worker.

The Luma calendar itself is a third-party surface this repository cannot write
to on deletion; clearing the ledger entry is what makes the discrepancy visible
rather than settled.

### Retention and backups

There is no backup automation in this repository, and nothing here restores from
one. What exists is version history:

- `data/history/` holds one snapshot per sweep, committed to git. Snapshots are
  never rewritten, including by a deletion: they are the record of what the
  board said at a past time.
- git history holds every past revision of `data/events.json` and of the
  candidate files.

So a deletion removes a record from everything the site serves and from the next
sweep, and it does not remove it from the snapshots or from git history. Both
are public. A deletion that has to reach them is a history rewrite and this
tooling does not do it.

## Reliability

Every discovery pass is built never to fail - a throttled search or a dead
endpoint writes an empty file and exits 0, because a partial sweep beats no
sweep. That design has two failure modes, and both are now covered.

**It can publish nothing.** A network outage mid-run once left every source with
zero results and the normalizer replaced the whole board with an empty list,
reporting success. It now refuses: a collapse to below `collapseRatio` of the
last good sweep (or below `minPublishedEvents`) leaves `data/events.json`
untouched and exits non-zero. The board keeps serving the last good data and the
run goes red.

**It can go quiet without telling anyone.** `npm run check:sources` reads what
each pass wrote and fails when the shape of the output says a source is broken
rather than merely quiet - an empty Luma feed, a YC index with no events, a sweep
that visited almost no pages, a board below its floor, or any pass whose output
has gone stale. It runs last in CI, *after* the deploy, so a broken source never
blocks the board from updating; it just turns the run red. Sources that depend on
a residential IP warn instead of failing, because they are expected to come back
empty from a datacenter.

Tests come in two kinds, and only one of them gates a deploy.

`npm run test:artifact` asks whether the thing about to be published is correct  - 
the rendered board, the ICS feed, the date arithmetic most likely to publish
something wrong (Devpost's date-only ranges, Y Combinator's placeholder
timestamps), the duplicate-collapsing rules and the calendar sync's decisions. 70
tests, three seconds, and CI runs it between the commit and the deploy.

`npm run test:browser` drives the real Add-External-Event form filler against a
local fixture that reproduces the behaviours which actually broke: a date field
that mis-parses its own display format, out-of-year dates shown differently, a
picker overlay that swallows clicks, an Escape key that closes the whole dialog,
and time fields Luma refills server-side. It needs Chrome and takes a minute and a
half, and it runs *after* the deploy - a flaky browser must not be able to
withhold a correct board.

See `PROTOTYPE.md` for the full product spec.

## Is another metro worth a region?

`npm run measure:regions` counts hackathons starting in the next 60 days across
seven metros, asking Luma, Eventbrite, Meetup, Devpost and MLH separately and
then deduping. Read-only, keyless, and it writes nothing.

It reports per source on purpose. The first attempt at this question asked only
Luma, which is an SF company whose home market adopted it first, so it flattered
San Francisco and said little about anywhere else. Splitting by source is what
tells you whether a metro's count is real or is one platform's popularity in one
city: New York's six are spread across four sources, while Seattle's three are
all recurring hack nights on Meetup.

It counts titles rather than pages, so it is an upper bound. The board's own
classifier reads the page and rejects most of what this admits: "Weekly
Write-a-thon" matches the `-a-thon` shape and is not a hackathon. Treat the
numbers as a ranking, not an inventory, and read the named results underneath.

As of August 2026, per 60 days and quality-adjusted by hand: Bay Area 8-12,
SoCal 3-4 (which is only visible if Los Angeles and San Diego are counted as one
region), New York 2-3, Austin 2, Seattle and Boston 0.

San Diego is the second region anyway, added deliberately rather than because the
measurement asked for it. Worth saying plainly what that means: a San Diego board
is thin. Its Luma discover place lists six upcoming events in total, none of them
hackathons, and the metro's own count is only respectable when Los Angeles is
counted with it. What San Diego has is a real hackathon scene that no calendar
aggregates, which is the same gap the Bay Area board was built for - it is just
smaller, and its board will look it until North County and the university
calendars are seeded properly.

## Regions

A region is the answer to "which board does this event belong on". It is data,
in the `regions` block of `config/discovery.json`, and it declares:

- `label` and `coreArea` - what the site calls the region, and which of its areas
  counts as "in the city".
- `areas` - the cities it serves, grouped. These are the *only* place the board
  names a city: the crawl's place-matching regex, the local-city set every source
  filters on, and the area printed on a listing are all derived from them. A
  parallel `placeTerms` list used to hold the same names a second time, which is
  exactly the kind of duplication that starts disagreeing the moment there are
  two of something.
- `areaBonus` - how reachable each area is *within its own region*, worth up to
  8 points of the accessibility score. The Peninsula is close to San Francisco
  and nothing at all to San Diego, so this belongs to the region rather than to a
  table in the scorer that silently means "near SF".
- `lumaPlaceId` - the metro's Luma discover place (`discplace-...`), read off
  `luma.com/<city>`.
- `lumaCalendarName` - the Luma calendar this region's events are mirrored to.

Which region an event lands on is decided by its **city**, never by its state:
the Bay Area and San Diego are both in California, so a state test says nothing
once there is more than one Californian board. An event whose city no region
claims is not published at all; an event with no readable city - an online
hackathon, or one whose venue is not announced yet - goes to `defaultRegion`,
which is where the single-region board put it implicitly.

Each region gets its own ICS feed and its own Luma calendar. `/calendar.ics`
keeps meaning what it meant before San Diego existed - the Bay Area board - so
nobody who already subscribed wakes up with hackathons 500 miles away on their
calendar. Every other region is `?region=<key>`, and an unknown region is a 404
rather than a quiet fallback to the default.

Adding a third region is a config entry, some seed URLs, and a `copy.<key>.*`
entry per language in `app/i18n/` (which has a serviceable default if you skip
it). Two things are not data yet, both because every region so far is Pacific:
the normalizer formats every event in the board's single `timezone`, and the ICS
feed hardcodes a Pacific `VTIMEZONE`. A region outside that would need both, and
a region declaring its own `timezone` is already carried through to the site.

## Languages

The board reads in English and in Spanish. English keeps the bare paths it has
always had (`/`), Spanish is `/es`, and the switcher in the masthead links the
two. A locale nobody serves (`/fr`) falls back to the English board rather than
404ing - a page in the wrong language is read once and corrected in one click,
unlike a feed, which is a standing order and is refused when unknown.

What a language changes is the chrome: headings, filters, empty states, date and
time rendering, plurals, aria labels, page metadata. What it never touches:

- **Event titles and organizer copy.** They are data, not site copy, and pass
  through exactly as written until an authoritative translation exists
  (none does).
- **Time zones.** Every date is rendered from the event's UTC instant in the
  event's own IANA zone, so DST behaves identically in every language.
- **The calendar.** `/calendar.ics` is one shared artifact with no locale
  anywhere in it: the same request returns byte-identical output whatever
  `Accept-Language` asks for, and both boards link the same URL, so switching
  language can never fork a subscription or rewrite an event's identity.
  `tests/i18n-rendered.test.mjs` asserts the byte equivalence and the UIDs;
  the browser suite downloads the feed from both boards and compares bytes.

Adding a locale is one file plus two lines: copy `app/i18n/en.json` to
`app/i18n/<locale>.json` and translate every value (the catalogs are flat
key-to-string maps), then add the locale to `LOCALES` in `app/i18n/index.ts` and
its label pair (`locale.<code>`, `locale.<code>.short`) to every catalog.
Routing, the switcher, metadata alternates and the fallback come along for free.
`tests/i18n-messages.test.mjs` runs inside `test:artifact`, so a key missing
from any catalog - or a placeholder dropped in translation - turns the run red
before anything is promoted.

## Recommender and evaluation

The board's ordering is a chronological list: soonest first, hackathons before
adjacent events, ties left in the order the sweep scored them. This section is
about the attempt to learn a better one, and about the machinery that exists to
stop that attempt from convincing anybody before it has earned it.

**There is no result yet.** Nothing has been deployed with logging enabled, so
no reader has ever been logged, and every number in
`results/recommender-report.md` comes from a synthetic fixture. The verdict is
`Implemented result pending` and will stay there until the organic gate below is
met. Implemented, not measured; local, not deployed; synthetic, not organic.

### What is logged, and what is never logged

Eleven fields, listed in `app/telemetry-schema.mjs` as a closed list rather than
a filter, so an unknown key is a 400 naming the key and a key that looks like
personal data is a 400 naming it as personal data:

`type` (impression, click or save), `ts`, `client_id`, `session_id`, `locale`,
`event_id`, `position` (the 0-based rank as shown), `ranking` (which ordering
put it there), `model_version`, `viewport` (`narrow` or `wide`), and `source`.

Never: an IP address, an email, a name, a user-agent, a referrer, or any
identity the server derives. `worker/events-endpoint.mjs` does not read the
request's address or user-agent at all, and never logs the payload, because a
Worker log line would be a second copy of the data with none of the rules. A
browser test sends `CF-Connecting-IP` and a user-agent on every request and
asserts neither reaches the sink, so that claim is about the code rather than
about the fixture.

The client id is sixteen random bytes from `crypto.getRandomValues`, minted in
the browser, kept in `localStorage` with the time it was minted, and **thrown
away after seven days**. A browser that refuses `localStorage` gets no client id,
sends nothing, and reads the board exactly as it did before any of this existed.
The cost of that is real: any per-client analysis can only reach back seven days,
and one long-lived reader looks like several readers.

Rate limiting is by payload and batch size only: at most 50 events and 32KB per
request. There is no per-client counter, no deny list and nothing that can
punish anybody. The id is random and rotates, so a limit keyed on it would be
both trivially evaded and the one piece of per-person state this refuses to keep.

Storage is a Cloudflare Workers Analytics Engine dataset (`hacklist_events`,
binding `EVENTS` in `wrangler.jsonc`). Datasets are created on first write with
no dashboard step, and the Workers Free plan includes 100,000 data points
written and 10,000 read queries a day, so the binding provisions nothing and
cannot start a bill. Rows are kept for three months, which also caps how far any
analysis can reach back.

- <https://developers.cloudflare.com/analytics/analytics-engine/get-started/>
- <https://developers.cloudflare.com/analytics/analytics-engine/pricing/>
- <https://developers.cloudflare.com/analytics/analytics-engine/limits/>

### Ordering, interleaving, cold start and fallback

`app/ranking.mjs` holds one implementation of the board's ordering, and
`app/board.tsx` is its only caller. An ordering that an evaluation script
re-implements is an ordering nobody has actually measured.

- **Production order.** `boardVisible` filters and sorts exactly as the page
  does. `results/recommender-manifest.json` freezes a snapshot of the 69 ordered
  event ids it returns for the committed `data/events.json`, with the sha256 of
  both, and a test in `test:artifact` compares them.
- **Candidate order.** A fifteen-feature L2-regularized logistic regression,
  trained by full-batch gradient descent with no dependencies, predicting a click
  or a save. Every feature is knowable when the list is rendered; engagement
  counts are excluded, because a click total is future information relative to
  the impression that produced it. The artifact is `data/ranker.json`.
- **Interleaving.** With both an artifact and a client id, the board team-drafts
  between the two orderings, seeded by the client id and the date, and every row
  remembers which side picked it. Both orderings are on the same page for the
  same person, so a click is a comparison rather than an anecdote. A drafted list
  is not in date order, so it drops the month headings rather than repeating
  "September" down the page, and it says the order is being tested.
- **Cold start and fallback are the same branch.** No client id, or no valid
  artifact, returns the production ordering. Deleting `data/ranker.json` is a
  complete and sufficient way to turn the candidate off: `app/model.ts` reads it
  through `import.meta.glob`, which resolves at build time and yields nothing
  when the file is absent, so there is no flag that could disagree with reality.
  The server render always takes this branch, because it has no client identity
  and deriving one is exactly what the privacy rules forbid.

### The evaluation

Frozen first, in `results/recommender-manifest.json`, before the evaluator
existed: the ordering under test, the feature list, the model family and its
regularization, the split, the five baselines, the six metrics, the promotion
gate, the organic gate and the four negative controls. The evaluator reads the
thresholds back out of that file at runtime. A gate chosen after seeing the
result is not a gate.

`npm run recommender:eval` runs a leakage detector, a prequential split (train
on every day strictly before day d, evaluate day d, never both), the baselines,
the metrics with 95 percent bootstrap intervals resampled by client, the
interleaving credit, and the gate. `npm run recommender:controls` runs the four
controls, each of which plants a specific defect that the machinery must notice:

| Control | Must |
| --- | --- |
| `leak-future` | fail the run: a feature reads engagement after the impression |
| `shuffle-labels` | not beat production: the model has nothing to learn |
| `cold-start` | return exactly the frozen production snapshot |
| `missing-artifact` | return exactly the frozen snapshot, deterministically |

### The organic gate

No online result is claimed until all four of these hold, counting only rows
tagged `source: web`. Seeded, synthetic, developer (`localhost` and
`workers.dev`) and replay rows are tagged at the point they are made and never
counted:

| Requirement | Need | Have |
| --- | ---: | ---: |
| organic impressions | 500 | 0 |
| organic interactions | 50 | 0 |
| anonymous clients | 25 | 0 |
| full days | 7 | 0 |

### Commands

```bash
npm run recommender:freeze       # rebuild the manifest from the committed board
npm run recommender:synthesize   # regenerate the seeded synthetic fixture
npm run recommender:train        # rebuild data/ranker.json from a log
npm run recommender:eval         # the evaluation, into results/
npm run recommender:controls     # the four negative controls
npm run recommender:export       # local pass: pull logged events out of Analytics Engine
```

`recommender:export` is a **local pass** and never runs in CI: it needs a
Cloudflare token with Account Analytics: Read, and the local passes stay off the
runner. With no credentials it prints how to make one and exits 0.

## Local passes (never run in CI)

Two steps need a signed-in Luma session, so they run on your machine against a
dedicated Chrome profile in `.local-browser-profile/` (gitignored). The session
never leaves this machine and is never placed in GitHub Actions.

```bash
bash scripts/install-luma-schedule.sh   # run the local passes at 8:30pm (installed)
bash scripts/install-wake-schedule.sh   # let them fire with the lid shut (sudo, once)
bash scripts/local-passes.sh            # or run them now, by hand

npm run discover:personalized           # just the personalized pass
npm run luma:queue                      # what's pending for the Bay Area calendar
npm run luma:queue -- --region san-diego
npm run luma:sync                       # the default region
npm run luma:sync -- --region san-diego
```

`scripts/local-passes.sh` is what the schedule runs, once a day at 8:30pm:
LinkedIn and personalized discovery (which commit and push their seeds so the
next GitHub sweep crawls them), then the calendar sync and the tagging pass once
per region. No step can abort another, and the log lands in
`logs/local-passes.log`.

Once a day rather than twice: the sync is idempotent and the calendar only
changes when the board does, so the second run mostly re-confirmed the first.
Evening because the 8pm sweep finishes just before it - the sync publishes that
sweep, and the seeds it pushes are waiting for the 8am one to crawl.

launchd does not skip a missed run, so a sleeping Mac means the pass lands late
rather than never. `scripts/install-wake-schedule.sh` makes it land on time: it
sets a repeating wake one minute before the run and grants a narrow sudoers rule
so each run can re-arm the next. Worth knowing that a scheduled wake is far more
reliable on power than on battery.

The first run opens Chrome and waits for you to sign in by hand; later runs
reuse the profile. Personalized discovery writes only public event URLs to
`data/personalized-seeds.json`, which the anonymous crawler then classifies
like any other find - being recommended is not evidence of anything. It also
stores each card's title, which the sweep uses to visit hackathon-looking
events before general ones, so a feed of 141 mostly-unrelated events cannot
crowd out the ones worth having.

`luma:sync` drives Luma's supported **Add Event** admin UI (paste an event URL)
on a free calendar, so no Luma Plus subscription is required. It processes the
whole pending batch, marks an event synced only after seeing it on the
calendar, and stops without losing queue state if it hits a CAPTCHA, a
sign-out, or a UI it does not recognize. `data/luma-ledger.json` tracks what
has been added; `npm run luma:queue` prints a paste-by-hand fallback list.

One calendar per region, named by `lumaCalendarName` in the region's config and
found on the signed-in account by that name, so **the calendar has to exist
before the first sync** - create it free at https://luma.com/create/calendar
("HackList San Diego" for the San Diego region). The resolved URL is remembered
per region in the ledger afterwards. A `--region` the config does not know is
refused rather than defaulted, because a typo would otherwise publish one
region's board onto another's public calendar.

## Search discovery

Everything else reaches events by crawling outward from calendars we already
know, so a hackathon nobody curates stays invisible. `npm run discover:search`
asks a search engine instead and writes event URLs to
`data/search-seeds.json`, which the crawler then visits and classifies like any
other find - a search hit is not evidence.

**No API key is required.** Firing the whole query list at once is what got the
keyless endpoint blocked, so each run takes only `searchQueriesPerRun` queries
and rotates which ones, advancing every 12 hours to match the schedule. The full
list is therefore covered every few runs with no throttling.

### Making search work in CI

Search engines block datacenter IPs, and GitHub Actions is a datacenter. That is
why the keyless path returns 403 or an empty page from CI however politely it
asks - it is not a rate limit you can wait out. The direct APIs carry the board
precisely so this does not matter, but if you want the search legs working in CI
too, set one of these (in provider precedence order):

- `BRIGHTDATA_API_KEY` (+ optional `BRIGHTDATA_SERP_ZONE`, default `serp_api`)  - 
  the one that actually solves the datacenter problem, since unblocking is what
  the product is for. Free tier is 5,000 credits/month, no credit card, and both
  search passes together spend a few hundred. **Wired but untested** - there is no
  account behind it here, so treat the first run as the real test; a wrong
  response shape is recorded in `problems` rather than thrown.
- `SERPER_API_KEY` or `TAVILY_API_KEY` - free tiers, no card.
- `BRAVE_API_KEY` - Brave now bills new accounts.

Search never blocks the sweep: a run with no search results still publishes.

Note that search engines mostly index the archive, so many hits are events that
have already happened. Those are rejected by the past-event filter, and stale
seeds are pruned after `searchSeedRetentionDays` so they stop costing crawl
budget.

## LinkedIn discovery

Search discovery can only find an event once a search engine has indexed its
registration page. A lot of Bay Area hackathons are announced first - sometimes
only - as a LinkedIn post, and the registration link sits in the post body or in
the author's own first comment. `npm run discover:linkedin` goes after those and
writes `data/linkedin-seeds.json`, which the crawler visits and classifies like
any other find.

Two stages, and by default neither costs anything:

1. **Search** for LinkedIn pages about Bay Area hackathons, using whichever
   provider is available (`SERPER_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`,
   else keyless DuckDuckGo).
2. **Read** each of those pages over plain HTTPS, free and keyless. LinkedIn
   serves post bodies, article bodies and top comments to an anonymous reader,
   so no login, cookie or session is involved - and none is stored.

A weekly "Bay Area AI events" digest can carry fifty Luma links of which three
are hackathons, so each extracted link keeps the words around it: links whose
context names a hackathon format are marked `promising` and crawled first, and
the cap trims the filler rather than the finds.

There is an optional paid escalation - a per-call LinkedIn search over
[Zero](https://www.zero.xyz) (x402, no signup, ~$0.003 a query) - for when the
free provider comes back empty. **It is off by default** (`linkedinMaxPaidQueriesPerRun: 0`),
because the board is meant to cost nothing, and because that capability answered
502 on roughly a third of calls and charged for them anyway. Turn it on by
raising that config value or setting `LINKEDIN_PAID_QUERIES=n`; `check:sources`
warns if anything was ever spent. Override the provider choice with
`LINKEDIN_SEARCH_PROVIDER=zero|serper|tavily|brave|duckduckgo-html`.

Note that search engines block datacenter IPs, so both this pass and
`discover:search` are expected to return nothing from GitHub Actions and to work
from the local schedule. That is why they are extras rather than load-bearing:
the direct APIs above carry the board.

## Devpost discovery

`npm run discover:devpost` reads `devpost.com/api/hackathons` - public, keyless,
paginated. Coverage is narrower than the volume suggests and honestly so: of ~80
upcoming in-person hackathons worldwide only a handful are Bay Area, and Devpost's
location field is free text an organizer typed. Sometimes it is a city, sometimes
a region ("Bay Area"), sometimes only a venue ("AWS Builder Loft"). Venue-only
strings cannot be placed without guessing, so they are skipped and listed in
`skipped.unplaceable` rather than assigned to a city we made up.

Devpost publishes submission-period dates and no clock times, so its events are
date-only: the span runs local midnight to end-of-day, which trips the "time we
do not believe" guard and prints the date without a time.

## Y Combinator discovery

YC runs a lot of Bay Area hackathons on its own events site and never puts them
on Luma, so the rest of the pipeline was blind to them - the sweep crawls
outward from Luma calendars, and search discovery only accepts Luma permalinks.
That is how Greptile's second Fast Hackathon (at YC, 23 Aug 2026) stayed off the
board while it was open for applications.

`npm run discover:yc` fixes that. `events.ycombinator.com` is a client-rendered
Inertia app - fetching it plainly gets an empty shell, which is why the headless
sweep cannot read it either - but Inertia ships its props in a `data-page`
attribute, so the events arrive as clean structured JSON. No browser, no key, no
third-party scraper. Output is `data/yc-candidates.json` in the same candidate
shape the sweep writes, merged by the normalizer and scored on the same terms.

One wrinkle worth knowing: YC's own `starts_at` is often a placeholder. An
organizer enters a date and the record lands at local midnight with a
three-hour duration while the description says "Sunday August 23rd 12pm-6pm".
So the calendar date is taken from YC and the clock time is recovered from the
description when YC's is not credible; `structuredEvent.timeSource` records
which happened (`yc`, `description`, or `yc-unverified`), and an unverified time
is suppressed by the normalizer rather than published.

## Automation

`.github/workflows/discover.yml` runs the whole loop twice a day, around 8am and
8pm Pacific (DST-aware): all sources → normalize → commit data → deploy → check
source health. Four crons fire as a supply of chances and the job gates on how
long it has been since the last real sweep, because GitHub delivers a scheduled
run late rather than on time; observed starts land 10-90 minutes after the hour.

The health check runs last, deliberately after the deploy: a broken source should
never stop the board from updating, it should just make the run red. A collapse is
handled earlier and differently - the normalizer refuses to publish it at all, so
the commit and deploy steps never run and the live board keeps its last good data.

Repository secrets:

- `CLOUDFLARE_API_TOKEN` - enables the deploy step (Workers Scripts: Edit
  permission). Without it, runs still refresh the committed data.
- `LUMA_API_KEY` (optional) - calendar-scoped key from a Luma Plus calendar;
  enables `scripts/sync-luma-calendar.mjs`, which submits each discovered
  event to that Luma calendar so people can follow Hacklist SF on Luma too.

## Commands

```bash
npm run dev                # local development
npm run discover:sf        # every source, then normalize
npm run discover:luma-api  # just Luma's public discover feed
npm run discover:yc        # just the Y Combinator pass
npm run discover:devpost   # just the Devpost pass
npm run discover:linkedin  # just the LinkedIn pass
npm run luma:sync -- --region san-diego   # mirror one region to its Luma calendar
npm run normalize          # re-normalize existing discovery output only
npm run check:sources      # are all the sources still working?
npm run recommender:eval   # the ordering evaluation (see Recommender and evaluation)
npm run recommender:controls  # the four negative controls, each of which must fail
node scripts/redact-event.mjs --url <url> --reason <text>   # delete or redact one event
node scripts/verify-deletion.mjs   # prove a deletion clears index, export and cache
npm test                   # everything, including the browser-driven form test
npm run test:artifact      # the deploy gate: is the published artifact correct?
npm run test:browser       # drives the Luma form filler against a local fixture
npm run deploy             # build, then deploy to Cloudflare Workers
```

## Guardrails

Discovery only reads public event pages. It does not bypass CAPTCHAs, does
not collect attendee information, and rate-limits itself to a small page
budget per sweep.

The LinkedIn pass holds to the same line. It reads only what LinkedIn serves an
anonymous reader, stores no login or cookie, and keeps nothing about people  - 
what it extracts from a post is event URLs and the words around them. Paid
LinkedIn capabilities that return attendee, liker or commenter lists exist and
are not used.
