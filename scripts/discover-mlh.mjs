// Major League Hacking's season calendar.
//
// Why this exists alongside Devpost: Devpost's in-person feed is 95 hackathons
// worldwide and almost all of them are Indian and Australian university events.
// One San Diego, one Santa Clara. It cannot carry a US metro. MLH is the
// opposite shape -- 65 upcoming events, 48 of them in the US -- because it is
// the organiser network behind most American student hackathons.
//
// It is also the only source that sees months ahead. Student hackathons are
// announced a semester early: this pass found SF Hacks dated February 2027 in
// August 2026, which no calendar-based source had, because organisers open a
// Luma page weeks out and MLH lists them as soon as the season is planned.
//
// The data is better than Devpost's too. Devpost publishes dates without clock
// times; MLH gives real ISO timestamps and a structured venueAddress with city,
// state and country, so the locality decision is made on stated fields rather
// than parsed out of a location string.
//
// No key, no browser. The season page embeds every event in one
// application/json block, so this is a fetch and a walk.
//
// Never exits non-zero for a source problem.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPatterns,
  localCitySet,
  namesHackathonFormat,
  resolveCity,
  scoreCandidate,
} from "./lib/candidate-score.mjs";
import { mlhSchedule } from "./lib/event-dates.mjs";
import { createPacer, DEFAULT_UA } from "./lib/page-http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/mlh-candidates.json");
const patterns = buildPatterns(config);
const localCities = localCitySet(config);
const pace = createPacer(500);

// MLH seasons run roughly August to May and are named for the calendar year they
// end in, so in any given month the live season is this year's or next year's.
// Reading both spans the boundary without needing to know where it falls: the
// 2026 page in August 2026 held 253 events and not one of them was upcoming.
const YEARS = (() => {
  const year = new Date().getUTCFullYear();
  return [year, year + 1];
})();

const JSON_BLOCK =
  /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;

/** Every event object in the page's embedded state, however it is nested. */
function eventsFromHtml(html) {
  const events = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    // The shape that identifies an event record rather than any other object in
    // the page's state.
    if (value.formatType && value.startsAt && value.name) events.push(value);
    Object.values(value).forEach(walk);
  };
  for (const [, block] of html.matchAll(JSON_BLOCK)) {
    try {
      walk(JSON.parse(block));
    } catch {
      // Not the block we want; the page has only one but that may change.
    }
  }
  return events;
}

const problems = [];
const seen = new Map();
for (const year of YEARS) {
  const url = `https://www.mlh.com/seasons/${year}/events`;
  try {
    await pace();
    const response = await fetch(url, {
      headers: { "user-agent": DEFAULT_UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const event of eventsFromHtml(await response.text())) {
      if (event.id && !seen.has(event.id)) seen.set(event.id, event);
    }
  } catch (error) {
    problems.push({ season: year, error: String(error).slice(0, 160) });
  }
}

const now = Date.now();
const candidates = [];
const skipped = { past: 0, online: 0, notLocal: 0, notHackathon: 0, unplaceable: [] };

for (const event of seen.values()) {
  const startMs = Date.parse(event.startsAt ?? "");
  const endMs = Date.parse(event.endsAt ?? event.startsAt ?? "");
  if (!Number.isFinite(startMs)) continue;
  if (Number.isFinite(endMs) && endMs < now) {
    skipped.past += 1;
    continue;
  }
  // MLH's own word for a venue-less event. An online hackathon is not this
  // board's business even when everything else about it fits.
  if (event.formatType && event.formatType !== "physical") {
    skipped.online += 1;
    continue;
  }
  const venue = event.venueAddress ?? {};
  const stated = [venue.city, venue.state, venue.country, event.location]
    .filter(Boolean)
    .join(", ");
  const city = resolveCity(stated, config, localCities, patterns);
  if (!city) {
    // Recorded rather than dropped silently: Devpost's equivalent list is what
    // revealed that a real Bay Area hackathon was being lost for want of the
    // words "san ramon".
    if (/^(CA|California)$/i.test(String(venue.state ?? ""))) {
      skipped.unplaceable.push({ name: event.name, location: stated.slice(0, 80) });
    } else {
      skipped.notLocal += 1;
    }
    continue;
  }

  // MLH's timestamps are day markers as often as they are start times; see
  // mlhSchedule for what tells them apart and why it matters.
  const schedule = mlhSchedule(event.startsAt, event.endsAt, config.timezone);
  if (!schedule) continue;

  // MLH lists design jams and career fairs beside hackathons, so its own
  // membership is not evidence of format; the name is judged as anywhere else.
  const evidence = [
    event.name,
    stated,
    event.dateRange,
    "hackathon",
    event.websiteUrl,
  ]
    .filter(Boolean)
    .join("\n");
  // MLH is a hackathon league, and that listing is the context its names lack.
  // "DiamondHacks", "BroncoHacks", "Hacktech", "FullyHacks" are all hackathons
  // whose names the shared vocabulary cannot parse: `\bhacks?\b` needs a word
  // boundary that a compound name does not have. Measured across the 2026 and
  // 2027 seasons: 174 of the 333 names MLH lists contain "hack" and fail
  // namesHackathonFormat, and every one of them is a hackathon. The things MLH
  // lists that are not -- design jams, career fairs -- do not carry "hack" in
  // the name, so this stays a narrow widening rather than trusting membership.
  if (!namesHackathonFormat(event.name, patterns) && !/hack/i.test(event.name)) {
    skipped.notHackathon += 1;
    continue;
  }
  const scored = scoreCandidate(event.name, evidence, patterns);
  const url = event.websiteUrl || `https://www.mlh.com/events/${event.slug}`;
  candidates.push({
    url,
    title: String(event.name).trim(),
    category: "hackathon",
    discoveredVia: "https://www.mlh.com/seasons",
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url,
      name: event.name,
      description: null,
      startDate: new Date(schedule.startMs).toISOString(),
      endDate: Number.isFinite(schedule.endMs)
        ? new Date(schedule.endMs).toISOString()
        : null,
      timeSource: schedule.dateOnly ? "mlh-date" : "mlh",
      organizers: ["Major League Hacking"],
      location: {
        name: event.location ?? null,
        city,
        region: venue.state ?? null,
      },
      offerAvailability: null,
      going: null,
    },
  });
}

candidates.sort((a, b) => b.relevance - a.relevance);

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: "https://www.mlh.com/seasons",
      seasons: YEARS,
      eventsSeen: seen.size,
      skipped,
      problems,
      note:
        "Major League Hacking's season calendar, read anonymously from the JSON " +
        "the season page embeds. Real timestamps and a structured venueAddress, " +
        "so locality is decided on stated fields. Sees further ahead than any " +
        "calendar source because student hackathons are announced a semester out.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `MLH discovery: ${candidates.length} candidate(s) from ${seen.size} event(s) ` +
    `across seasons ${YEARS.join(", ")} ` +
    `(${skipped.past} past, ${skipped.online} online, ${skipped.notLocal} not local, ` +
    `${skipped.notHackathon} not a hackathon, ${skipped.unplaceable.length} unplaceable)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
