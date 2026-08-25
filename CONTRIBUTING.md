# Contributing to Hacklist SF

Thanks for looking. Hacklist is a scraper feeding a calendar people subscribe to, so the
interesting failure is not a crash but a board that quietly stops being true.

## The contract you must not break

**A bad sweep must never replace a good board.** Every discovery pass is deliberately
built to exit 0 whatever happens, because a partial sweep beats no sweep. That design
means the guards downstream are the only thing between a dead source and an empty
calendar, and all three of them are load-bearing:

- `scripts/normalize-events.mjs` refuses to publish a collapse: fewer events than
  `max(minPublishedEvents, ceil(previousCount * collapseRatio))` leaves `data/events.json`
  untouched and exits non-zero, so the board keeps its last good data and the run goes red.
- `npm run test:artifact` runs between the data commit and the deploy, so nothing is
  promoted until the rendered board and the ICS feed are checked. Do not move slow or
  flaky tests into it; a flaky Chrome must never be able to withhold a correct board.
- `npm run check:sources` runs *after* the deploy, on purpose. It turns a run red when a
  source is broken rather than merely quiet, and it must never gate publishing.

Two rules about CI that are not negotiable:

- **The local passes never run in CI.** Personalized discovery and the Luma UI sync need
  a signed-in Luma session, which lives in a gitignored `.local-browser-profile/` and is
  never placed in GitHub Actions. `scripts/local-passes.sh` is where they belong.
- **No CI job may spend money.** LinkedIn's paid per-call fallback runs through the
  `zero` CLI, deliberately not installed on the runner. Keep metered paths unreachable
  from Actions by construction, not by a flag someone can flip.

Discovery reads only public event pages: no CAPTCHA bypass, no attendee information, a
page budget per sweep. The LinkedIn pass stores no login or cookie and keeps nothing about
people; the paid attendee, liker and commenter APIs exist and are not used.

## Getting oriented

| Path | What lives there |
|---|---|
| `config/discovery.json` | Seeds, region and area maps, and the sweep budgets: `maxPagesPerSweep`, `maxSweepMinutes`, `collapseRatio`, `minPublishedEvents`. |
| `scripts/discover-*.mjs` | One file per source. Each writes its own `data/*-candidates.json` and never exits non-zero for a source problem. |
| `scripts/normalize-events.mjs` | Merges every candidate file, dedupes by URL, parses, scores, and writes `data/events.json`. |
| `scripts/check-sources.mjs` | The health check, with `scripts/lib/source-health.mjs` deciding blocked versus misconfigured. |
| `scripts/local-passes.sh` | The signed-in, machine-local passes and their schedule. |
| `app/page.tsx`, `app/calendar.ics/route.ts` | The site and the ICS feed, both generated from `data/events.json`. |
| `tests/` | `node --test` suites. `test:artifact` is the deploy gate. |
| `.github/workflows/discover.yml` | The twice-daily sweep, commented with why each step sits where it does. `PROTOTYPE.md` has the product spec. |

## Building and testing

Node 22.13 or newer (see `engines` in `package.json`).

```bash
npm install
npm run dev                # local worker
npm run test:artifact      # the deploy gate: rendered board, ICS feed, dates, dedupe
npm test                   # everything, including the browser-driven form test
npm run check:sources      # are all the sources still working?
npm run discover:luma-api  # a single pass, keyless, safe to run anywhere
```

`npm run discover:sf` runs every pass then normalizes; it crawls real sites, so prefer
individual passes while iterating.

## What makes a good PR here

- One concern per PR.
- A new discovery pass follows the existing shape: exit 0 on any source problem, record
  the problem rather than throwing, write `data/<source>-candidates.json` with a
  `candidates` array, and add it to `normalize-events.mjs` and the `discover:sf` chain.
- Every source needs a health check in `check-sources.mjs`. A pass that cannot fail is
  a pass that can go silent, and the health check is the only thing that notices.
- Changes to date parsing, dedupe or the ICS feed need a test in `test:artifact`. Those
  are the areas that have shipped something wrong before.
- Comments here explain why a thing is shaped as it is, often citing the outage that
  caused it. Preserve them, and add one when you fix something subtle.

## Good first areas

- **A source nobody reads yet.** The pipeline is built for exactly this: a new
  `scripts/discover-<name>.mjs` plus one line in the normalizer's candidate list. Job
  boards, university CS calendars and company developer-events pages all carry Bay Area
  hackathons that no calendar we follow links to.
- **MLH, Eventbrite and Meetup have no health check.** All three feed
  `normalize-events.mjs`, but `check-sources.mjs` never reads their files, so they can go
  quiet without turning a run red. That is the exact failure mode the check exists for.
- **The README's list of seven sources predates them.** All three run in `discover:sf`
  and are missing from the "How it works" list.
- **A second region.** `config/discovery.json` has a `regions` block with only
  `bay-area` in it, and `npm run measure:regions` already answers whether a metro earns
  one.

## Conduct

Be decent. Disagree about the code, not about the person.
