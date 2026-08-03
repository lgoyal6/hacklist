# Hacklist SF prototype

## Scope

The first city is the San Francisco Bay Area, using a 55-mile radius so events
in Oakland, Berkeley, the Peninsula and the South Bay can be included without
pretending they are all inside San Francisco proper.

## Discovery model

The crawler starts with public Luma city/category pages and known calendars,
then expands through event pages, presenting calendars, organizers and
co-hosts. It reads the Schema.org event lists exposed by calendar pages and
follows direct off-Luma event links, so an externally hosted hackathon curated
on Luma is still eligible. Known collections are seeds, not authoritative
inventories.

Candidate generation is deliberately broad. Publication requires page-level
evidence of building plus a competitive or submission format. This is how names
such as "Pizza Agent Challenge" can qualify while ordinary pitch nights and
meetups are excluded.

Curated hackathon boards elsewhere on the web (`externalIndexUrls`) are treated
as inventories rather than as pages to classify: their Luma links are followed
even when the event name uses a word our vocabulary does not know, but each
linked event is still classified on its own page. These boards are
client-rendered, so they get a longer settle window than Luma pages.

Known gap: events a board hosts on its *own* pages rather than linking to Luma
are currently missed. Crawling those generically cost roughly 25 seconds per
page and pushed the sweep past its time budget in exchange for a single extra
event, so the right fix is a small per-board extractor that reads the listings
straight from the board's rendered index, not a slower generic crawl.

Every sweep is bounded by both a page budget and `maxSweepMinutes`. A sweep that
runs out of time stops and publishes what it has, recording
`stoppedOnTimeBudget` and the unvisited queue length, because a partial refresh
beats a scheduler-killed run that publishes nothing.

Measured cost is about a second per page: 117 pages takes roughly two minutes.
The budgets (320 pages, 15 minutes) therefore sit far above what a sweep
actually needs, and the CI job allows 30 minutes so even a full-length sweep
still reaches the deploy step. Should the seed lists ever outgrow the budget,
the per-run caps rotate rather than truncate, so coverage completes across runs
instead of silently losing the tail.

A title naming a non-hackathon format — conference, summit, meet-up — only
publishes when the title also names a hackathon format, which keeps
"AI Infra Summit Hackathon" while rejecting "MITAI Conference". Events that
look local and build-shaped but fail a format check are written to
`data/review-queue.json` instead of being dropped, so tightening a rule never
silently loses an event.

### Personalized and authenticated passes

`scripts/discover-personalized.mjs` runs locally against a dedicated,
gitignored Chrome profile to collect the events Luma recommends to the signed-in
user, writing public event URLs to `data/personalized-seeds.json` for the
anonymous crawler to classify. The authenticated session is deliberately kept
off CI. Nothing bypasses CAPTCHAs or touches Luma's internal endpoints.

## Ranking

- 40% hackathon confidence: building, teams, submissions, judges, demos, prizes.
- 25% builder value: technical depth, mentors, sponsors and credible tracks.
- 20% accessibility: registration state, price, travel radius and friction.
- 15% freshness: date, recent verification and active registration.

The prototype keeps classification confidence separate from relevance. A real
hackathon can be low relevance when it is far away, closed or already past.

## Pipeline

`npm run discover:sf` runs two stages:

1. `scripts/discover-sf.mjs` sweeps public Luma and directly linked external
   event pages with Lightpanda + Playwright, extracts page text plus structured
   event metadata, and writes raw candidates to `data/discovery-output.json`.
2. `scripts/normalize-events.mjs` parses each candidate's page evidence into a
   structured record — start/end datetimes (timezone-aware, with
   weekday-checked year inference), venue, city, area bucket, organizer,
   registration status, prize text, tags and attendance — then scores it with
   the weights below and writes `data/events.json`.

The normalizer also snapshots every sweep to `data/history/` and diffs against
the previous snapshot, writing added/updated/removed events to
`data/changes.json`.

The site (`app/page.tsx`) and the ICS feed (`app/calendar.ics/route.ts`) are
both generated from `data/events.json`, so a sweep plus rebuild refreshes the
board and the subscribable calendar together. Events whose dates cannot be
parsed stay on the board marked "TBC" but are excluded from the ICS feed.

## Refresh

The GitHub Actions workflow fires at every UTC hour that can correspond to
8am/8pm Pacific and a gate job keeps only the runs where it actually is, so
the schedule is exact across daylight-saving transitions. Each run sweeps,
normalizes, commits refreshed data, and (when `CLOUDFLARE_API_TOKEN` is set as
a repository secret) redeploys the site and ICS feed with `vinext deploy`.

## Publishing to a Luma calendar

Two paths exist, and the free one is the default:

- **Free (`scripts/luma-sync-ui.mjs`)** drives Luma's supported Add Event admin
  UI from the local signed-in profile, pasting an event URL exactly as a human
  would. Works on a free calendar. The flow is three steps: Add Event → Add
  Existing Luma Event → paste the URL, stage it, confirm.

  Truth about what is on the calendar comes from reading the event rows' own
  links while scrolling in small steps, because the list is virtualized and
  reading it after one long scroll sees only the last screenful. Page text and
  HTML are deliberately not searched for slugs — hydration payloads and the
  modal's "Suggested Events" mention slugs that are not on the calendar.

  `data/luma-ledger.json` is reconciled against the calendar in both directions
  on every run, so an event that is present but unrecorded gets adopted and a
  record whose event is missing becomes pending again. That makes the sync
  idempotent and self-healing rather than dependent on a trustworthy ledger.

  External (non-Luma) events need Luma's separate Add External Event form, which
  asks for name, date, timezone and location rather than a URL, so they are
  reported for manual entry instead of being half-filled by guesswork.
- **Paid (`scripts/sync-luma-calendar.mjs`)** uses the official API, which needs
  Luma Plus. Fully unattended, so it can run in CI.

When `LUMA_API_KEY` is set (a calendar-scoped key from a Luma Plus calendar),
each run also submits newly discovered events to that Luma calendar via
`POST /v1/calendars/events/add`, so the list is followable on Luma itself.
`data/luma-sync.json` tracks which events have already been submitted.

## Next city

San Diego should reuse the same classifier with a new city boundary, seed set
and place vocabulary. Ranking weights remain stable so cities can be compared.
