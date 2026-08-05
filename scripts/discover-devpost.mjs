// Devpost — the largest hackathon registry the pipeline was not reading.
//
// `devpost.com/api/hackathons` is public and keyless: it takes status and
// challenge-type filters, paginates, and answers 200 to an anonymous caller from
// any IP. Nothing here is scraped out of HTML.
//
// Coverage is narrower than the volume suggests, and honestly so: of ~80
// upcoming in-person hackathons worldwide, only a handful are Bay Area, and
// Devpost's location field is free text an organizer typed — sometimes a city
// ("San Francisco, CA, USA"), sometimes a region ("Bay Area"), sometimes just a
// venue ("AWS Builder Loft"). Venue-only strings cannot be placed without
// guessing, so they are skipped and recorded rather than published to the wrong
// city. `skipped.unplaceable` in the output is the list to check if something is
// missing.
//
// Devpost publishes submission-period *dates* and no clock times, so every event
// here is date-only. That is passed through as local midnight to end-of-day,
// which trips the normalizer's "time we do not believe" guard and publishes the
// date without a time — which is the truth.
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
import { parseDevpostDates } from "./lib/event-dates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/devpost-candidates.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = Number(process.env.DEVPOST_TIMEOUT_MS ?? 20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patterns = buildPatterns(config);
const localCities = localCitySet(config);
// "Bay Area" is not a city, so it is not in placeTerms, but an organizer typing
// it means exactly this board's catchment.
const REGION_ALIAS = /\b(bay area|silicon valley|sf bay)\b/i;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Strip the markup Devpost embeds in prize_amount. */
function cleanPrize(raw) {
  const text = String(raw ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  if (!text || /^\$?(?:CAD\s*)?0$/i.test(text)) return null;
  return text;
}

/**
 * Place a Devpost location string, or return null when it names only a venue.
 * Returning null is the honest answer: publishing a guess would put an event in
 * the wrong city.
 */
function placeLocation(raw) {
  const text = String(raw ?? "");
  const city = resolveCity(text, config, localCities, patterns);
  if (city) return { city, venue: null };
  if (REGION_ALIAS.test(text)) return { city: null, venue: null, region: true };
  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const timezone = config.timezone;
const problems = [];
const seen = new Map();

/** Walk one Devpost query's pages. */
async function pull(label, baseUrl, maxPages) {
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await getJson(`${baseUrl}&page=${page}`);
    } catch (firstError) {
      // One retry: a single timeout should not silently truncate a feed.
      await sleep(1_500);
      try {
        data = await getJson(`${baseUrl}&page=${page}`);
      } catch (error) {
        problems.push({
          stage: label,
          page,
          error: `${String(firstError).slice(0, 70)} then ${String(error).slice(0, 70)}`,
        });
        return;
      }
    }
    const hackathons = data.hackathons ?? [];
    if (!hackathons.length) return;
    for (const hackathon of hackathons) {
      if (hackathon.url && !seen.has(hackathon.url)) seen.set(hackathon.url, hackathon);
    }
    const total = data.meta?.total_count ?? 0;
    if (page * hackathons.length >= total) return;
    await sleep(Number(process.env.DEVPOST_DELAY_MS ?? 400));
  }
}

const OPEN = "status[]=upcoming&status[]=open";
const queries = [
  // Every open in-person hackathon worldwide, filtered to the Bay below. This is
  // the feed that matters; it is small enough to walk end to end.
  ["in-person", `https://devpost.com/api/hackathons?${OPEN}&challenge_type[]=in-person&order_by=recently-added`, 12],
  // Belt and braces for anything an organizer tagged oddly.
  ["search-sf", `https://devpost.com/api/hackathons?${OPEN}&search=san+francisco`, 3],
  ["search-bay", `https://devpost.com/api/hackathons?${OPEN}&search=bay+area`, 3],
];
for (const [label, url, maxPages] of queries) {
  const before = seen.size;
  await pull(label, url, maxPages);
  console.log(`  ${label}: ${seen.size - before} new (${seen.size} total seen)`);
}

const now = Date.now();
const candidates = [];
const skipped = { notLocal: 0, unplaceable: [], past: 0, undated: 0, inviteOnly: 0 };

for (const hackathon of seen.values()) {
  const locationText = hackathon.displayed_location?.location ?? "";
  const placed = placeLocation(locationText);
  if (!placed) {
    // Only worth reporting when the thing is plausibly local-ish noise; a
    // hackathon in Indore is simply not local.
    if (!/\b(usa|united states|,\s*ca\b|california)\b/i.test(locationText)) {
      skipped.notLocal += 1;
    } else {
      skipped.unplaceable.push({ title: hackathon.title, location: locationText });
    }
    continue;
  }
  if (hackathon.invite_only) {
    skipped.inviteOnly += 1;
    continue;
  }
  const dates = parseDevpostDates(hackathon.submission_period_dates, timezone);
  if (!dates) {
    skipped.undated += 1;
    continue;
  }
  if (dates.endUtc < now) {
    skipped.past += 1;
    continue;
  }

  // A region-only location ("Bay Area") is left without a city rather than
  // promoted to San Francisco. The board renders a missing city by omitting it,
  // and areaForCity() already falls back to "Bay Area" — which is all the
  // organizer actually told us.
  const city = placed.city;
  const prize = cleanPrize(hackathon.prize_amount);
  const organizer = hackathon.organization_name || "Unknown organizer";
  const themes = (hackathon.themes ?? [])
    .map((theme) => theme.name ?? theme)
    .filter(Boolean);
  const evidence = [
    "Hosted By",
    organizer,
    hackathon.title,
    city ? `${city}, CA` : "Bay Area",
    locationText,
    prize ? `Prizes ${prize}` : null,
    typeof hackathon.registrations_count === "number"
      ? `${hackathon.registrations_count} Going`
      : null,
    hackathon.open_state === "open" ? "Registration Open" : "Registration Upcoming",
    themes.length ? `Themes: ${themes.join(", ")}` : null,
    "Submission period",
    String(hackathon.submission_period_dates ?? ""),
  ]
    .filter(Boolean)
    .join("\n");

  const scored = scoreCandidate(hackathon.title, evidence, patterns);
  candidates.push({
    url: hackathon.url.replace(/\/$/, ""),
    title: String(hackathon.title ?? "").trim(),
    category: "hackathon",
    discoveredVia: "https://devpost.com/api/hackathons",
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url: hackathon.url.replace(/\/$/, ""),
      name: String(hackathon.title ?? "").trim(),
      description: null,
      startDate: new Date(dates.startUtc).toISOString(),
      endDate: new Date(dates.endUtc).toISOString(),
      // Devpost publishes no clock time; the normalizer suppresses the midnight
      // placeholder rather than printing a time nobody stated.
      timeSource: "devpost-date-only",
      organizers: [organizer],
      location: { name: city ? locationText : null, city, region: "CA" },
      offerAvailability: hackathon.open_state === "open" ? "InStock" : null,
      going: hackathon.registrations_count ?? null,
    },
  });
}

candidates.sort((a, b) => b.relevance - a.relevance);

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: "https://devpost.com/api/hackathons",
      seen: seen.size,
      candidates: candidates.length,
      skipped: {
        ...skipped,
        unplaceable: skipped.unplaceable.slice(0, 25),
        unplaceableCount: skipped.unplaceable.length,
      },
      problems,
      note:
        "Devpost's public hackathon API, read anonymously. Dates only — Devpost " +
        "publishes no clock times, so the normalizer prints the date and omits " +
        "the time. Locations that name only a venue are skipped rather than " +
        "assigned to a guessed city; see skipped.unplaceable.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Devpost discovery: ${candidates.length} candidate(s) from ${seen.size} seen ` +
    `(${skipped.notLocal} not local, ${skipped.unplaceable.length} unplaceable, ` +
    `${skipped.past} past, ${skipped.undated} undated)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
