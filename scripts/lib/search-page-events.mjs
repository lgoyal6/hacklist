// Hackathon candidates from a ticketing site's own search page.
//
// Eventbrite and Meetup both server-render their search results as schema.org
// Events, with a full postal address and a description, which is better
// structured data than the Luma crawl gets off a rendered page. So a source for
// either is a fetch, a filter and a score, and both share all three.
//
// Why they are worth having at all: measure-region-density found hackathons on
// these two that the pipeline had never seen, three in New York and three in
// Seattle, and they matter most where Luma is thin. Los Angeles and San Diego
// between them showed zero hackathons across 64 Luma events, and Eventbrite and
// Meetup found four.
//
// The catch is recurrence. Both sites are full of standing meetups whose names
// pass any format test: "Flushing Tech Bi-Weekly Hackathon", "Open Hack Night",
// "Project Hack Night & Social". Every one is a real event and none of them is
// what this board is for, so a name that says it repeats is recorded as adjacent
// rather than published as a hackathon.
import {
  namesHackathonFormat,
  namesUnservedRegion,
  resolveCity,
  scoreCandidate,
} from "./candidate-score.mjs";
import { readFile } from "node:fs/promises";

import { localToUtc } from "./event-dates.mjs";
import {
  DEFAULT_UA,
  structuredEventsFromHtml,
  unlockerFromEnv,
  unlockerHtml,
} from "./page-http.mjs";
import { safeFetch } from "./safe-fetch.mjs";

/** A name that says the event happens again and again. */
const RECURRING =
  /\b(weekly|bi[-\s]?weekly|monthly|every\s+(?:mon|tue|wed|thu|fri|sat|sun)|open\s+house|office\s+hours)\b/i;

/** Online-only events are not this board's business, whatever they are called. */
const ONLINE_ONLY = /OnlineEventAttendanceMode/i;

/**
 * A date with no time in it, however it is dressed up.
 *
 * Eventbrite's search listing publishes every start as midnight UTC, which is a
 * date and not an instant. Read as an instant it lands on the previous evening
 * in Pacific, and DeveloperWeek 2027 went onto the board as January 24 for a
 * hackathon that starts on the 25th. Devpost stores the same thing as midnight
 * Eastern and cost the same mistake earlier, so it is worth naming rather than
 * patching twice.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/;

/**
 * The instant a stated start actually refers to.
 *
 * A date-only value is anchored to midnight in the board's own zone, so the
 * calendar day survives and the normalizer's own check sees an hour it does not
 * believe and prints the day alone.
 */
function instantFor(raw, timeZone, { endOfDay = false } = {}) {
  const text = String(raw ?? "");
  if (DATE_ONLY.test(text)) {
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    // A one-day event arrives with the same date at both ends, so anchoring both
    // to midnight makes the range empty and the normalizer, which requires an end
    // after its start, reads it as having no schedule at all and refuses to
    // publish it. A date-only end means the end of that day.
    return {
      ms: endOfDay
        ? localToUtc(year, month, day, 23, 59, timeZone)
        : localToUtc(year, month, day, 0, 0, timeZone),
      dateOnly: true,
    };
  }
  const ms = Date.parse(text);
  return { ms: Number.isFinite(ms) ? ms : Number.NaN, dateOnly: false };
}

/**
 * Statuses that mean "not from this address" rather than "no such page".
 *
 * Eventbrite answered every query from the CI runner with a 405 from the day
 * this pass was added, so it contributed nothing for its whole life while
 * reporting four problems a run that nobody read. A datacenter address is the
 * whole reason, the same as Luma's 429s, and the same unlocker is the answer.
 */
const REFUSED = new Set([403, 405, 429]);

/**
 * The search page's HTML: read directly, and through the unlocker when the
 * direct read is refused and one is configured. The unlocker is metered, so it
 * is only ever the second attempt.
 */
async function pageHtml(url, { timeoutMs, unlocker, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": DEFAULT_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.ok) return response.text();
  if (!(unlocker && REFUSED.has(response.status))) {
    throw new Error(`HTTP ${response.status}`);
  }
  try {
    return await unlockerHtml(url, { ...unlocker, timeoutMs, fetchImpl });
  } catch (error) {
    throw new Error(`HTTP ${response.status}, then ${String(error.message ?? error)}`);
  }
}

export async function searchPageCandidates({
  url,
  source,
  config,
  localCities,
  patterns,
  windowDays = 180,
  timeoutMs = 25_000,
  unlocker = unlockerFromEnv(),
  fetchImpl = safeFetch,
}) {
  const timeZone = config.timezone ?? "America/Los_Angeles";
  const html = await pageHtml(url, { timeoutMs, unlocker, fetchImpl });

  const now = Date.now();
  const horizon = now + windowDays * 864e5;
  const candidates = [];
  const skipped = { past: 0, online: 0, notLocal: 0, notHackathon: 0, recurring: 0 };

  for (const event of structuredEventsFromHtml(html)) {
    if (!event.name || !event.startDate) continue;
    const start = instantFor(event.startDate, timeZone);
    const startMs = start.ms;
    if (!Number.isFinite(startMs) || startMs < now || startMs > horizon) {
      skipped.past += 1;
      continue;
    }
    if (ONLINE_ONLY.test(String(event.attendanceMode ?? ""))) {
      skipped.online += 1;
      continue;
    }
    if (namesUnservedRegion(event.location, config)) {
      skipped.notLocal += 1;
      continue;
    }
    const city = resolveCity(
      `${event.location?.city ?? ""}, ${event.location?.name ?? ""}, ${event.location?.region ?? ""}`,
      config,
      localCities,
      patterns,
    );
    if (!city) {
      skipped.notLocal += 1;
      continue;
    }

    const evidence = [
      event.name,
      event.location?.name,
      `${city}, CA`,
      event.description,
    ]
      .filter(Boolean)
      .join("\n");
    // A name that says hackathon still has to look like one, because these sites
    // list far more events than Luma and the description is all the evidence
    // there is.
    if (!namesHackathonFormat(event.name, patterns)) {
      skipped.notHackathon += 1;
      continue;
    }
    const scored = scoreCandidate(event.name, evidence, patterns);
    const recurring = RECURRING.test(event.name);
    if (recurring) skipped.recurring += 1;

    candidates.push({
      url: event.url ?? url,
      title: String(event.name).trim(),
      category: recurring ? "adjacent" : "hackathon",
      heldBecause: recurring ? "name says it repeats" : null,
      discoveredVia: source,
      confidence: scored.confidence,
      relevance: scored.relevance,
      signals: scored.signals,
      evidence: evidence.slice(0, 8_000),
      checkedAt: new Date().toISOString(),
      structuredEvent: {
        url: event.url ?? url,
        name: event.name,
        description: event.description ?? null,
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(
          instantFor(event.endDate ?? event.startDate, timeZone, {
            endOfDay: true,
          }).ms,
        ).toISOString(),
        timeSource: source,
        organizers: event.organizers ?? [],
        location: { ...event.location, city },
        offerAvailability: event.offerAvailability ?? null,
        going: null,
      },
    });
  }
  return { candidates, skipped };
}

/**
 * The previous run's still-upcoming candidates, for a run where every query
 * failed.
 *
 * The unlocker is only configured on the deep sweeps, so a shallow sweep that
 * is refused everywhere would otherwise overwrite what the last deep sweep
 * found with nothing, and the board would lose those events until the next
 * one. A run that read anything at all is trusted as it stands.
 */
export async function carriedCandidates(outputPath, now = Date.now()) {
  try {
    const previous = JSON.parse(await readFile(outputPath, "utf8"));
    return (previous.candidates ?? []).filter(
      (candidate) => Date.parse(candidate.structuredEvent?.startDate ?? "") > now,
    );
  } catch {
    return [];
  }
}
