// DoraHacks' hackathon hub.
//
// Why this exists alongside Devpost, lablab and ETHGlobal: DoraHacks runs its
// own hackathons end to end, entrants submit BUIDLs on dorahacks.io, and none
// of it reaches Devpost. The online board had none of them, and that is 16 open
// online hackathons including a $200,000 one, which would be the largest prize
// on the board by a factor of three.
//
// It is also the best-stated source here. The hub's own JSON answers every
// question this project otherwise has to infer from rendered text: venue_form
// says "Virtual" or "IRL", timeline_start and timeline_end are real unix
// timestamps rather than a date range with no clock, bonus_price and
// bonus_token state the pool and its currency, and hackers_count is the crowd
// figure the ranker reads. Nothing here is parsed out of a sentence.
//
// No key. The hub endpoint is what the site's own listing page calls on load,
// anonymously, which is how it was found: the HTML is a Nuxt shell with no
// event data in it at all, so reading the page would have needed a browser and
// reading its API needs a fetch.
//
// Never exits non-zero for a source problem: a discovery source that can fail
// the whole sweep is a discovery source that gets removed from the sweep.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPatterns, scoreCandidate } from "./lib/candidate-score.mjs";
import { createPacer, DEFAULT_UA } from "./lib/page-http.mjs";
import { safeFetch } from "./lib/safe-fetch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/dorahacks-candidates.json");

const HUB = "https://dorahacks.io/api/v1/hub/hackathons";
const LISTING = "https://dorahacks.io/hackathon";
const PAGE_SIZE = 50;
// The hub is ordered by its own weight, not by date, and the open events sit at
// the front: on the day this was written pages 1 through 8 held 16, 0, 0, 1, 0,
// 0, 0, 0 open online hackathons out of 830 events. So this reads a few pages
// and stops once the open ones have clearly run out, rather than paging the
// whole archive to find the one straggler on page four.
const MAX_PAGES = Number(process.env.DORAHACKS_MAX_PAGES ?? 6);
const QUIET_PAGES = Number(process.env.DORAHACKS_QUIET_PAGES ?? 3);
const TIMEOUT_MS = Number(process.env.DORAHACKS_TIMEOUT_MS ?? 20_000);

// Currencies that are dollars. rank.mjs reads the prize as a dollar figure, so
// a pool denominated in ADA or INR has to arrive as no prize rather than as a
// number that means something else. Every open online event today is in USD;
// the archive holds $S, CAD, INR and ADA, so this will matter eventually.
const DOLLARS = new Set(["USD", "USDT", "USDC"]);

const patterns = buildPatterns(config);
const pace = createPacer(400);
const problems = [];

async function page(number) {
  try {
    await pace();
    const response = await safeFetch(`${HUB}?page=${number}&page_size=${PAGE_SIZE}`, {
      headers: { "user-agent": DEFAULT_UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.results) ? body.results : [];
  } catch (error) {
    problems.push(`page ${number}: ${String(error).slice(0, 160)}`);
    return null;
  }
}

const now = Date.now();
const rows = new Map();
const skipped = { ended: 0, irl: 0, undated: 0, duplicateLanguage: 0 };

let quiet = 0;
for (let number = 1; number <= MAX_PAGES && quiet < QUIET_PAGES; number += 1) {
  const results = await page(number);
  if (results === null) break;
  if (!results.length) break;

  let openHere = 0;
  for (const row of results) {
    if (!row?.id || rows.has(row.id)) continue;
    rows.set(row.id, row);
    const end = Number(row.timeline_end) * 1000;
    if (Number.isFinite(end) && end > now && String(row.venue_form).toLowerCase() === "virtual") {
      openHere += 1;
    }
  }
  quiet = openHere ? 0 : quiet + 1;
}

// One hackathon, three listings. WEEX AI Wars II is published in English,
// Japanese and Chinese as three records with three slugs, and all three would
// reach the board as three separate $200,000 events. They are the same
// organiser, the same closing timestamp and the same pool, which is a stated
// match rather than a guess at similar titles, so the first one the hub ranks
// is the one that is kept.
const identity = (row) =>
  `${row.owner?.id ?? "?"}:${row.timeline_end ?? "?"}:${row.bonus_price ?? "?"}`;

const kept = new Set();
const candidates = [];

for (const row of rows.values()) {
  const start = Number(row.timeline_start) * 1000;
  const end = Number(row.timeline_end) * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    skipped.undated += 1;
    continue;
  }
  if (end <= now) {
    skipped.ended += 1;
    continue;
  }
  // The stated venue, not a guess from the title. DoraHacks runs real in-person
  // hackathons too and they are not this board's business unless they happen
  // somewhere it serves, which none of them do.
  if (String(row.venue_form).toLowerCase() !== "virtual") {
    skipped.irl += 1;
    continue;
  }
  const key = identity(row);
  if (kept.has(key)) {
    skipped.duplicateLanguage += 1;
    continue;
  }
  kept.add(key);

  const url = `${LISTING}/${row.uname}/`;
  const title = String(row.title ?? "").trim();
  const prize = DOLLARS.has(String(row.bonus_token).toUpperCase()) ? Number(row.bonus_price) || 0 : 0;
  const going = Number(row.hackers_count) || null;

  const evidence = [
    row.owner?.name ? `${row.owner.name} on DoraHacks` : "DoraHacks",
    title,
    "Virtual hackathon",
    prize ? `Prizes $${prize.toLocaleString("en-US")}` : "Prize pool not stated in dollars",
    going ? `${going} hackers` : null,
    row.tags || row.ecosystem || null,
  ]
    .filter(Boolean)
    .join("\n");

  const scored = scoreCandidate(title, evidence, patterns);
  candidates.push({
    url,
    title,
    category: "hackathon",
    discoveredVia: LISTING,
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url,
      name: title,
      description: null,
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
      // Real timestamps, not a date range someone typed, so unlike Devpost and
      // lablab this source states the hour a hackathon actually closes.
      timeSource: "dorahacks-api",
      organizers: [row.owner?.name || "DoraHacks"].filter(Boolean),
      location: { name: "Online", city: null, region: null, online: true },
      offerAvailability: "InStock",
      going,
      prize: prize ? `$${prize.toLocaleString("en-US")}` : null,
    },
  });
}

candidates.sort((a, b) => b.relevance - a.relevance);

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: HUB,
      seen: rows.size,
      candidates: candidates.length,
      online: candidates.length,
      skipped,
      problems,
      note:
        "DoraHacks' own hub API, read anonymously, which is what the site's " +
        "listing page calls on load. Everything is a stated field: venue_form " +
        "decides online rather than a title, timeline_end is a real timestamp " +
        "rather than a date with no clock, and bonus_price is only carried " +
        "through as a prize when bonus_token is a dollar, because rank.mjs " +
        "reads the figure as dollars and a pool in ADA is not one. One event " +
        "published in several languages is three records with one organiser, " +
        "closing time and pool, and only the first is kept. The visibility " +
        "field is deliberately not filtered on: every row here comes from the " +
        "public hub feed and what its values mean is unverified.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `DoraHacks discovery: ${candidates.length} candidate(s) from ${rows.size} seen ` +
    `(${skipped.ended} ended, ${skipped.irl} in person, ${skipped.undated} undated, ` +
    `${skipped.duplicateLanguage} duplicate language editions)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
