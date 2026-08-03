# Hacklist SF prototype

## Scope

The first city is the San Francisco Bay Area, using a 55-mile radius so events
in Oakland, Berkeley, the Peninsula and the South Bay can be included without
pretending they are all inside San Francisco proper.

## Discovery model

The crawler starts with Luma city/category pages and known calendars, then
expands through event pages, presenting calendars, organizers and co-hosts.
Known collections are seeds, not authoritative inventories.

Candidate generation is deliberately broad. Publication requires page-level
evidence of building plus a competitive or submission format. This is how names
such as "Pizza Agent Challenge" can qualify while ordinary pitch nights and
meetups are excluded.

## Ranking

- 40% hackathon confidence: building, teams, submissions, judges, demos, prizes.
- 25% builder value: technical depth, mentors, sponsors and credible tracks.
- 20% accessibility: registration state, price, travel radius and friction.
- 15% freshness: date, recent verification and active registration.

The prototype keeps classification confidence separate from relevance. A real
hackathon can be low relevance when it is far away, closed or already past.

## Pipeline

`npm run discover:sf` runs two stages:

1. `scripts/discover-sf.mjs` sweeps Luma with Lightpanda + Playwright and
   writes raw candidates to `data/discovery-output.json`.
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

When `LUMA_API_KEY` is set (a calendar-scoped key from a Luma Plus calendar),
each run also submits newly discovered events to that Luma calendar via
`POST /v1/calendars/events/add`, so the list is followable on Luma itself.
`data/luma-sync.json` tracks which events have already been submitted.

## Next city

San Diego should reuse the same classifier with a new city boundary, seed set
and place vocabulary. Ranking weights remain stable so cities can be compared.
