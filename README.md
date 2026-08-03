# Hacklist SF

Every public Luma hackathon in the SF Bay Area — discovered automatically,
ranked by signal, and published as a subscribable calendar.

- **Site:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev
- **Calendar feed:** https://hacklist-sf.modern-renaissance-artifacts.workers.dev/calendar.ics
  (add this URL to Google/Apple/Outlook Calendar to subscribe)

## How it works

1. `scripts/discover-sf.mjs` sweeps Luma with a headless browser
   (Lightpanda + Playwright), starting from seed pages in
   `config/discovery.json` and expanding through event, organizer and
   co-host links. Raw candidates land in `data/discovery-output.json`.
2. `scripts/normalize-events.mjs` parses each candidate's page evidence into
   a structured record (dates, venue, city, status, prizes, tags), scores it
   (40% hackathon confidence, 25% builder value, 20% accessibility,
   15% freshness) and writes `data/events.json`. Every sweep is snapshotted
   to `data/history/` and diffed into `data/changes.json`.
3. The site (`app/page.tsx`) and the ICS feed (`app/calendar.ics/route.ts`)
   are both generated from `data/events.json`.

See `PROTOTYPE.md` for the full product spec.

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
