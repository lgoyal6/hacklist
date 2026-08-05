// Luma's public discovery API — the same events the sweep crawls, as structured
// JSON instead of rendered HTML.
//
// Why this exists alongside the headless sweep rather than replacing it: they
// find different things, measured rather than assumed. On the run that added
// this script the API's SF metro feed returned 891 upcoming events in 19
// requests and 49 seconds, of which 15 were hackathon-shaped and 4 were not on
// the board at all. Going the other way, 8 of the board's 27 Luma events never
// appeared in the feed — they live on organizer calendars the feed does not
// surface, which is exactly what crawling outward from seed calendars is for.
// Dropping either source would cost coverage, so both run.
//
// No key, no session, no browser. `api.lu.ma/discover/get-paginated-events`
// takes a place id and a cursor and answers 200 to an anonymous caller — which
// also means it works from a datacenter IP, unlike every search engine this
// pipeline has tried.
//
// Three outputs, all in data/luma-api.json:
//   * candidates      — hackathon-shaped events, in the sweep's candidate shape
//   * enrichment      — exact times, guest counts and registration state for
//                       events the sweep already found, so the normalizer can
//                       stop guessing them out of page text
//   * calendarSeeds   — calendars seen hosting a hackathon, fed back into the
//                       sweep's seed list so the crawl reaches further next run
//
// Never exits non-zero for a source problem.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPatterns,
  localCitySet,
  resolveCity,
  scoreCandidate,
} from "./lib/candidate-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/luma-api.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const API = "https://api.lu.ma";
// The SF discover place aggregates the whole metro, not just the city.
const PLACE_ID = config.lumaPlaceId ?? "discplace-BDj7GNbGlsF7Cka";
const FETCH_TIMEOUT_MS = Number(process.env.LUMA_API_TIMEOUT_MS ?? 20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patterns = buildPatterns(config);
const localCities = localCitySet(config);

async function getJson(path, params) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Walk the cursor until the feed runs out or the cap is hit. */
async function pullFeed(max) {
  const entries = [];
  let cursor = null;
  let requests = 0;
  while (entries.length < max) {
    const params = {
      place_api_id: PLACE_ID,
      pagination_limit: Math.min(50, max - entries.length),
    };
    if (cursor) params.pagination_cursor = cursor;
    const data = await getJson("/discover/get-paginated-events", params);
    requests += 1;
    const page = data.entries ?? [];
    if (!page.length) break;
    entries.push(...page);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    await sleep(Number(process.env.LUMA_API_DELAY_MS ?? 300));
  }
  return { entries, requests };
}

/**
 * Luma reports a registration state directly, which is strictly better than the
 * sweep's reading of the words on the page. Mapped onto the board's vocabulary.
 */
function statusFor(entry) {
  const availability = entry.registration_availability;
  if (entry.waitlist_active || availability === "waitlist") return "Waitlist";
  if (availability === "open") return "Open";
  if (availability === "closed" || availability === "sold_out") return "Closed";
  return null;
}

/** Flat evidence lines, so the normalizer's text parsers have something to read. */
function buildEvidence(entry, city, organizer) {
  const event = entry.event;
  const geo = event.geo_address_info ?? {};
  const status = statusFor(entry);
  return [
    "Hosted By",
    organizer,
    event.name,
    city ? `${city}, CA` : null,
    geo.sublocality || null,
    event.location_type === "online" ? "Online" : null,
    typeof entry.guest_count === "number" ? `${entry.guest_count} Going` : null,
    status ? `Registration ${status}` : null,
    event.geo_address_visibility === "guests-only"
      ? "Register to See Address"
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function normalize(entry) {
  const event = entry.event ?? {};
  if (!event.url || !event.name) return null;
  const startUtc = Date.parse(event.start_at ?? "");
  const endUtc = Date.parse(event.end_at ?? "");
  if (!Number.isFinite(startUtc)) return null;
  const geo = event.geo_address_info ?? {};
  const city = resolveCity(
    `${geo.city ?? ""}, ${geo.city_state ?? ""}, ${geo.region ?? ""}`,
    config,
    localCities,
    patterns,
  );
  const organizer = entry.calendar?.name || "Unknown organizer";
  return {
    url: `https://luma.com/${event.url}`,
    apiId: event.api_id,
    title: event.name.trim(),
    startDate: new Date(startUtc).toISOString(),
    endDate: Number.isFinite(endUtc) ? new Date(endUtc).toISOString() : null,
    timezone: event.timezone ?? config.timezone,
    city,
    sublocality: geo.sublocality ?? null,
    locationType: event.location_type ?? null,
    organizer,
    calendarSlug: entry.calendar?.slug ?? null,
    going: typeof entry.guest_count === "number" ? entry.guest_count : null,
    status: statusFor(entry),
    entry,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const problems = [];
let pulled = { entries: [], requests: 0 };
const startedAt = Date.now();
try {
  pulled = await pullFeed(config.lumaApiMaxEvents ?? 1_200);
} catch (error) {
  problems.push({ stage: "feed", error: String(error).slice(0, 160) });
}
const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

// Dedupe: the feed can repeat an event across cursor pages.
const byUrl = new Map();
for (const entry of pulled.entries) {
  const record = normalize(entry);
  if (record && !byUrl.has(record.url)) byUrl.set(record.url, record);
}
console.log(
  `Luma API: ${pulled.entries.length} entries in ${pulled.requests} request(s), ` +
    `${byUrl.size} unique, ${elapsedSeconds}s.`,
);

// Which URLs the sweep already has. Enrichment is written only for these plus
// the hackathon-shaped ones, so this file stays a few KB rather than a dump of
// every party in the Bay Area.
const sweptUrls = new Set();
try {
  const discovery = JSON.parse(
    await readFile(resolve(root, "data/discovery-output.json"), "utf8"),
  );
  for (const candidate of discovery.candidates ?? []) sweptUrls.add(candidate.url);
} catch {
  // Optional; the sweep may not have run yet.
}

const now = Date.now();
const candidates = [];
const enrichment = {};
const calendarSeeds = new Set();
const skipped = { past: 0, nonLocal: 0, notHackathon: 0 };

for (const record of byUrl.values()) {
  const isHackathon = patterns.candidate.test(record.title);
  const endMs = Date.parse(record.endDate ?? record.startDate);
  const isPast = Number.isFinite(endMs) && endMs < now;

  // Enrichment is worth writing even for an event the sweep classified as
  // adjacent, so anything the sweep is already tracking gets a record.
  if (sweptUrls.has(record.url) || (isHackathon && !isPast)) {
    enrichment[record.url] = {
      startDate: record.startDate,
      endDate: record.endDate,
      timezone: record.timezone,
      city: record.city,
      venue: record.sublocality,
      organizer: record.organizer,
      going: record.going,
      status: record.status,
      locationType: record.locationType,
    };
  }

  if (!isHackathon) {
    skipped.notHackathon += 1;
    continue;
  }
  if (isPast) {
    skipped.past += 1;
    continue;
  }
  // A hackathon on a calendar we do not seed is a calendar worth crawling.
  if (record.calendarSlug) calendarSeeds.add(record.calendarSlug);
  if (!record.city && record.locationType !== "online") {
    skipped.nonLocal += 1;
    continue;
  }

  const evidence = buildEvidence(record.entry, record.city, record.organizer);
  const scored = scoreCandidate(record.title, evidence, patterns);
  candidates.push({
    url: record.url,
    title: record.title,
    category: "hackathon",
    discoveredVia: `${API}/discover/get-paginated-events`,
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url: record.url,
      name: record.title,
      description: null,
      startDate: record.startDate,
      endDate: record.endDate,
      timeSource: "luma-api",
      organizers: [record.organizer],
      location: {
        name: record.sublocality,
        city: record.city,
        region: "CA",
      },
      offerAvailability:
        record.status === "Open"
          ? "InStock"
          : record.status === "Closed"
            ? "SoldOut"
            : null,
      going: record.going,
    },
  });
}

candidates.sort((a, b) => b.relevance - a.relevance);
const fresh = candidates.filter((candidate) => !sweptUrls.has(candidate.url));

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: `${API}/discover/get-paginated-events`,
      placeId: PLACE_ID,
      entriesPulled: pulled.entries.length,
      requests: pulled.requests,
      uniqueEvents: byUrl.size,
      hackathonCandidates: candidates.length,
      notAlreadySwept: fresh.length,
      skipped,
      problems,
      note:
        "Luma's public discover feed, read anonymously. Same candidate shape as " +
        "the sweep, merged by scripts/normalize-events.mjs. `enrichment` carries " +
        "exact times, guest counts and registration state for events the sweep " +
        "found by reading a page; `calendarSeeds` are calendars seen hosting a " +
        "hackathon, crawled by the next sweep.",
      calendarSeeds: [...calendarSeeds].sort(),
      enrichment,
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `  ${candidates.length} hackathon candidate(s) (${fresh.length} the sweep did not have), ` +
    `${Object.keys(enrichment).length} enriched, ${calendarSeeds.size} calendar seed(s)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
