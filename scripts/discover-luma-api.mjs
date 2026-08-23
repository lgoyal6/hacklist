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
// takes a place id and a cursor and answers 200 to an anonymous caller.
//
// It does NOT work from a datacenter, which is why this runs on the local
// schedule rather than in CI. The feed is IP-geolocated: asked for the SF place
// from a residential Bay Area address it returns ~900 upcoming events, and from a
// GitHub Actions runner it returns two — with a 200 and no error, so nothing
// looks wrong. That silently overwrote a good pull once and cost the board seven
// hackathons, hence the floor check before writing.
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

import { createPacer, fetchPage } from "./lib/page-http.mjs";
import {
  buildPatterns,
  localCitySet,
  namesUnservedRegion,
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
// Luma answers a rate limit with a 200 and no content, so pace the page reads.
const paceLuma = createPacer(Number(process.env.LUMA_HTTP_INTERVAL_MS ?? 250));
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
const claimedByPass = new Set();
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

  // A calendar hosting anything that says "hack" is a calendar worth crawling,
  // even when the title alone cannot carry it to publication. The feed gives no
  // page text, so "HackwithSF" scores as a non-event here -- but the crawl reads
  // the page, and it only reads pages on calendars it knows about. Seeding on
  // the looser signal is free: a seed is a place to look, not a claim.
  if (!isPast && record.calendarSlug && /hack/i.test(record.title)) {
    calendarSeeds.add(record.calendarSlug);
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

// ---------------------------------------------------------------------------
// Seeded calendars, read over plain HTTP
// ---------------------------------------------------------------------------
// The crawl's only way to enumerate a Luma calendar is to render its page, and
// Lightpanda cannot render all of them: luma.com/IterateHacks times out and then
// wedges the browser outright, so its hackathon was invisible to every pass
// while the calendar sat in the seed list being "crawled". extractPage swallows
// a timeout by design -- a slow page is not a dead page -- which makes that
// failure completely silent: no candidate, no error, nothing to notice.
//
// Luma answers the same questions over keyless HTTP, so this asks. /url maps a
// calendar slug to its api_id, /calendar/get-items lists what is on it, and an
// event page's own JSON-LD carries the description the title cannot supply. No
// browser is involved, so a rendering failure cannot hide an event.
/** Luma calendar slugs worth enumerating: the configured seeds plus the feed's. */
function calendarSlugsToRead() {
  const slugs = new Set(calendarSeeds);
  for (const seed of config.seedUrls ?? []) {
    let parsed;
    try {
      parsed = new URL(seed);
    } catch {
      continue;
    }
    if (!["luma.com", "lu.ma"].includes(parsed.hostname)) continue;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    // A single path segment is a calendar or an event; /calendar/<id> is neither
    // a slug this endpoint takes nor something /url resolves.
    if (path && !path.includes("/")) slugs.add(path);
  }
  return [...slugs];
}

// The bar a page has to clear to be published, the same one the sweep uses.
const CONFIDENCE_BAR = 54;

/**
 * Build a candidate by reading a Luma event page, or say why not.
 *
 * Shared by the calendar pass and the retention pass so an event is judged on
 * the same terms however it was reached, and against the same text the sweep
 * would have scored.
 */
async function candidateFromEventPage(
  url,
  { discoveredVia, organizers = [], going = null, allowUnplacedCity = false },
) {
  let page;
  try {
    await paceLuma();
    page = await fetchPage(url, { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, why: String(error).slice(0, 120) };
  }
  const structured = page.structuredEvents[0] ?? null;
  if (!structured) return { ok: false, why: "no event markup on the page" };
  const location = structured.location ?? { name: null, city: null, region: null };
  // Same locality rule as everywhere else, and for the same reason: a
  // description that name-drops the Bay Area is not an address.
  if (namesUnservedRegion(location, config)) {
    return { ok: false, why: `region ${location.region}` };
  }
  const city = resolveCity(
    `${location.city ?? ""}, ${location.name ?? ""}, ${location.region ?? ""}`,
    config,
    localCities,
    patterns,
  );
  // A first sighting has to name a place it recognises. A re-check does not:
  // "Online Event" and "TBD - South Bay" resolve to no city, and refusing them
  // here would mean retention quietly protected everything except the online
  // hackathons and the ones whose venue is not announced yet. The region check
  // above still applies, so this cannot carry an event that has moved away.
  if (!city && !allowUnplacedCity) {
    return { ok: false, why: "no city could be resolved" };
  }
  const endMs = Date.parse(structured.endDate || structured.startDate || "");
  if (Number.isFinite(endMs) && endMs < Date.now()) {
    return { ok: false, why: "already ended" };
  }

  const evidence = [
    structured.name,
    location.name,
    city ? `${city}, CA` : null,
    page.bodyText || structured.description || null,
  ]
    .filter(Boolean)
    .join("\n");
  const scored = scoreCandidate(structured.name, evidence, patterns);
  if (scored.confidence < CONFIDENCE_BAR) {
    return { ok: false, why: `confidence ${scored.confidence}` };
  }
  return {
    ok: true,
    candidate: {
      url,
      title: String(structured.name).trim(),
      category: "hackathon",
      discoveredVia,
      confidence: scored.confidence,
      relevance: scored.relevance,
      signals: scored.signals,
      evidence: evidence.slice(0, 8_000),
      checkedAt: new Date().toISOString(),
      heldBecause: null,
      structuredEvent: {
        url,
        name: structured.name,
        description: structured.description ?? null,
        startDate: structured.startDate ?? null,
        endDate: structured.endDate ?? null,
        timeSource: "luma-page",
        organizers,
        location,
        offerAvailability: structured.offerAvailability ?? null,
        going,
      },
    },
  };
}

const calendarPass = { calendarsRead: 0, itemsSeen: 0, pagesRead: 0, added: 0, problems: [] };
for (const slug of calendarSlugsToRead().slice(
  0,
  config.lumaCalendarsPerRun ?? 24,
)) {
  let items = [];
  try {
    const resolved = await getJson("/url", { url: slug });
    const calendarId = resolved?.data?.calendar?.api_id ?? resolved?.data?.api_id;
    if (resolved?.kind !== "calendar" || !calendarId) continue;
    const listing = await getJson("/calendar/get-items", {
      calendar_api_id: calendarId,
      pagination_limit: 50,
      period: "future",
    });
    items = listing?.entries ?? [];
    calendarPass.calendarsRead += 1;
  } catch (error) {
    calendarPass.problems.push({ slug, error: String(error).slice(0, 120) });
    continue;
  }

  for (const entry of items) {
    const event = entry.event ?? {};
    if (!event.url || !event.name) continue;
    calendarPass.itemsSeen += 1;
    const url = `https://luma.com/${event.url}`;
    if (byUrl.has(url) || sweptUrls.has(url) || claimedByPass.has(url)) continue;
    // The same loose signal the crawl uses to decide a page is worth reading:
    // a name that says "hack" cannot be dismissed from its title alone.
    if (!patterns.candidate.test(event.name) && !/hack/i.test(event.name)) continue;
    const endMs = Date.parse(event.end_at || event.start_at || "");
    if (Number.isFinite(endMs) && endMs < now) continue;

    const built = await candidateFromEventPage(url, {
      discoveredVia: `${API}/calendar/get-items`,
      organizers: entry.calendar?.name ? [entry.calendar.name] : [],
      going: typeof entry.guest_count === "number" ? entry.guest_count : null,
    });
    calendarPass.pagesRead += 1;
    if (!built.ok) {
      if (!/confidence|no city|region /.test(built.why)) {
        calendarPass.problems.push({ url, error: built.why });
      }
      continue;
    }
    claimedByPass.add(url);
    calendarPass.added += 1;
    candidates.push(built.candidate);
  }
}
console.log(
  `  Calendar pass: ${calendarPass.calendarsRead} calendar(s), ` +
    `${calendarPass.itemsSeen} listed, ${calendarPass.pagesRead} page(s) read, ` +
    `${calendarPass.added} candidate(s) the feed and sweep both missed.`,
);

// ---------------------------------------------------------------------------
// Retention: the board is its own frontier
// ---------------------------------------------------------------------------
// The board is rebuilt from nothing every run, so an event stays on it only if
// some source finds it again. Luma's browse surfaces are infinite-scroll lists
// that server-render no events at all, so one visit sees one slice of them.
// ROAST MY PR and WeAreDevelopers Day were both published on one sweep, both
// still live and upcoming in San Francisco, and both gone from the next, because
// that run's scroll did not list them. Budget was not the problem: the sweep had
// drained its queue with pages to spare.
//
// So anything the board already published, still in the future, gets its page
// read again here and stays if it still checks out. Keyless, no browser, no page
// budget. An event now leaves the board when it has ended, moved, or stopped
// looking like a hackathon, rather than because a list scrolled differently.
//
// Deliberately only Luma events. The other sources are APIs that are re-read in
// full every run, so they do not flicker; re-reading them here would be cost
// without a cause.
const retention = { upcoming: 0, checked: 0, carried: 0, released: [] };
try {
  const board = JSON.parse(
    await readFile(resolve(root, "data/events.json"), "utf8"),
  );
  const upcoming = (board.events ?? []).filter((event) => {
    if (event.platform !== "luma") return false;
    const end = Date.parse(event.end ?? event.start ?? "");
    return Number.isFinite(end) && end >= now;
  });
  retention.upcoming = upcoming.length;
  // Skip only what has actually been emitted, not merely what the feed saw.
  // byUrl holds every event in the discover feed, and the feed drops anything
  // whose title misses the vocabulary -- which is precisely the class that needs
  // retaining. Both events this pass was written for, ROAST MY PR and
  // WeAreDevelopers Day, are in the feed and discarded by it on their names.
  const emitted = new Set(candidates.map((candidate) => candidate.url));
  for (const event of upcoming.slice(0, config.retentionPerRun ?? 80)) {
    if (emitted.has(event.url) || claimedByPass.has(event.url)) continue;
    retention.checked += 1;
    const built = await candidateFromEventPage(event.url, {
      discoveredVia: event.discoveredVia ?? `${API}/url`,
      organizers: event.organizer ? [event.organizer] : [],
      going: typeof event.going === "number" ? event.going : null,
      allowUnplacedCity: true,
    });
    if (!built.ok) {
      retention.released.push({ title: event.title.slice(0, 48), why: built.why });
      continue;
    }
    claimedByPass.add(event.url);
    retention.carried += 1;
    candidates.push(built.candidate);
  }
} catch {
  // No previous board yet; nothing to retain.
}
console.log(
  `  Retention: ${retention.carried} of ${retention.checked} previously ` +
    `published event(s) carried forward (${retention.upcoming} upcoming on the ` +
    `last board, ${retention.released.length} released).`,
);
for (const gone of retention.released.slice(0, 6)) {
  console.log(`    released "${gone.title}" — ${gone.why}`);
}

candidates.sort((a, b) => b.relevance - a.relevance);
const fresh = candidates.filter((candidate) => !sweptUrls.has(candidate.url));

// Luma's discover feed is IP-geolocated to the place you ask about, so this pass
// only works from a Bay Area address. Run from a datacenter it returns a couple
// of events and no error at all — which once overwrote a 897-event pull with 2
// and cost the board seven hackathons before anyone noticed. So a collapse never
// replaces a good file: the previous one stands and this exits non-zero.
let previousUnique = 0;
let previous = null;
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
  previousUnique = previous.uniqueEvents ?? 0;
} catch {
  // first run
}
const floor = Math.max(
  config.lumaApiMinEvents ?? 100,
  Math.ceil(previousUnique * 0.5),
);
const feedCollapsed = previousUnique > 0 && byUrl.size < floor;
if (feedCollapsed) {
  // The feed is geolocated: from outside the Bay Area it answers 200 with almost
  // nothing, so its own numbers are kept from the previous pull rather than
  // overwritten. But the calendar and retention passes above are not geolocated,
  // and exiting here threw their work away: CI reused a file frozen at the last
  // local run, so retention never ran where it was needed most, and CI's own
  // crawl contributed 8 candidates against 46 locally while the board survived
  // only on carried-over state.
  //
  // So the feed's fields are preserved and this run's fresh calendar and
  // retention candidates are merged in beside them.
  const kept = (previous?.candidates ?? []).filter(
    (candidate) => !claimedByPass.has(candidate.url),
  );
  candidates.push(...kept);
  candidates.sort((a, b) => b.relevance - a.relevance);
  console.warn(
    `Feed pulled ${byUrl.size} event(s) against ${previousUnique} last time ` +
      `(floor ${floor}), which is what a datacenter address sees. Keeping the ` +
      `feed's own numbers from the previous pull and merging this run's ` +
      `${claimedByPass.size} calendar and retention candidate(s) into it.`,
  );
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: `${API}/discover/get-paginated-events`,
      placeId: PLACE_ID,
      feedCollapsed,
      entriesPulled: feedCollapsed
        ? previous?.entriesPulled ?? pulled.entries.length
        : pulled.entries.length,
      requests: pulled.requests,
      uniqueEvents: feedCollapsed ? previousUnique : byUrl.size,
      hackathonCandidates: candidates.length,
      calendarPass,
      retention,
      notAlreadySwept: fresh.length,
      skipped,
      problems,
      note:
        "Luma's public discover feed, read anonymously. Same candidate shape as " +
        "the sweep, merged by scripts/normalize-events.mjs. `enrichment` carries " +
        "exact times, guest counts and registration state for events the sweep " +
        "found by reading a page; `calendarSeeds` are calendars seen hosting a " +
        "hackathon, crawled by the next sweep.",
      // Both are feed-derived, so a collapsed pull keeps the previous ones: the
      // crawl's seed list must not shrink because a datacenter asked.
      calendarSeeds: feedCollapsed
        ? previous?.calendarSeeds ?? [...calendarSeeds].sort()
        : [...calendarSeeds].sort(),
      enrichment: feedCollapsed ? previous?.enrichment ?? enrichment : enrichment,
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
