# Hacklist SF

Public hackathons in the SF Bay Area — including externally hosted events
linked from Luma calendars — discovered automatically, ranked by signal, and
published as a subscribable calendar.

- **Site:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev
- **Calendar feed:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev/calendar.ics
  (add this URL to Google/Apple/Outlook Calendar to subscribe)

## How it works

1. `scripts/discover-sf.mjs` sweeps public Luma surfaces with a headless browser
   (Lightpanda + Playwright), starting from seed pages in
   `config/discovery.json` and expanding through event, organizer and co-host
   links. It also reads Schema.org event lists embedded in public calendar
   pages, follows direct external event links, and preserves their structured
   dates and locations. Raw candidates land in `data/discovery-output.json`.
2. `scripts/normalize-events.mjs` parses each candidate's page evidence into
   a structured record (dates, venue, city, status, prizes, tags), scores it
   (40% hackathon confidence, 25% builder value, 20% accessibility,
   15% freshness) and writes `data/events.json`. Every sweep is snapshotted
   to `data/history/` and diffed into `data/changes.json`.
3. The site (`app/page.tsx`) and the ICS feed (`app/calendar.ics/route.ts`)
   are both generated from `data/events.json`.

See `PROTOTYPE.md` for the full product spec.

## Local passes (never run in CI)

Two steps need a signed-in Luma session, so they run on your machine against a
dedicated Chrome profile in `.local-browser-profile/` (gitignored). The session
never leaves this machine and is never placed in GitHub Actions.

```bash
bash scripts/install-luma-schedule.sh   # run both passes twice daily (installed)
bash scripts/local-passes.sh            # or run them now, by hand

npm run discover:personalized           # just the personalized pass
npm run luma:queue                      # what's pending for the Luma calendar
npm run luma:sync -- --name "HackList SF"
```

`scripts/local-passes.sh` is what the schedule runs: personalized discovery
(which commits and pushes its seeds so the next GitHub sweep crawls them),
then the calendar sync. Neither step can abort the other, and the log lands in
`logs/local-passes.log`.

The first run opens Chrome and waits for you to sign in by hand; later runs
reuse the profile. Personalized discovery writes only public event URLs to
`data/personalized-seeds.json`, which the anonymous crawler then classifies
like any other find — being recommended is not evidence of anything. It also
stores each card's title, which the sweep uses to visit hackathon-looking
events before general ones, so a feed of 141 mostly-unrelated events cannot
crowd out the ones worth having.

`luma:sync` drives Luma's supported **Add Event** admin UI (paste an event URL)
on a free calendar, so no Luma Plus subscription is required. It processes the
whole pending batch, marks an event synced only after seeing it on the
calendar, and stops without losing queue state if it hits a CAPTCHA, a
sign-out, or a UI it does not recognize. `data/luma-ledger.json` tracks what
has been added; `npm run luma:queue` prints a paste-by-hand fallback list.

## Search discovery

Everything else reaches events by crawling outward from calendars we already
know, so a hackathon nobody curates stays invisible. `npm run discover:search`
asks a search engine instead and writes event URLs to
`data/search-seeds.json`, which the crawler then visits and classifies like any
other find — a search hit is not evidence.

**No API key is required.** Firing the whole query list at once is what got the
keyless endpoint blocked, so each run takes only `searchQueriesPerRun` queries
and rotates which ones, advancing every 12 hours to match the schedule. The full
list is therefore covered every few runs with no throttling.

Set any one of `SERPER_API_KEY`, `TAVILY_API_KEY` or `BRAVE_API_KEY` to run more
queries per sweep and skip the rate limit entirely. Serper and Tavily have free
tiers that take no credit card; Brave now bills new accounts. Search never
blocks the sweep: a run with no search results still publishes.

Note that search engines mostly index the archive, so many hits are events that
have already happened. Those are rejected by the past-event filter, and stale
seeds are pruned after `searchSeedRetentionDays` so they stop costing crawl
budget.

## Automation

`.github/workflows/discover.yml` runs the whole loop at exactly 8am and 8pm
Pacific (DST-aware): sweep → normalize → commit data → deploy.

Repository secrets:

- `CLOUDFLARE_API_TOKEN` — enables the deploy step (Workers Scripts: Edit
  permission). Without it, runs still refresh the committed data.
- `LUMA_API_KEY` (optional) — calendar-scoped key from a Luma Plus calendar;
  enables `scripts/sync-luma-calendar.mjs`, which submits each discovered
  event to that Luma calendar so people can follow Hacklist SF on Luma too.

## Commands

```bash
npm run dev          # local development
npm run discover:sf  # sweep + normalize (refreshes data/)
npm run normalize    # re-normalize existing discovery output only
npm test             # build + data/board/ICS tests
npx vinext deploy    # manual deploy to Cloudflare Workers
```

## Guardrails

Discovery only reads public event pages. It does not bypass CAPTCHAs, does
not collect attendee information, and rate-limits itself to a small page
budget per sweep.
