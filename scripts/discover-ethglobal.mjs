// ETHGlobal's own events page.
//
// Why this exists alongside Devpost and lablab: ETHGlobal runs its hackathons
// on ethglobal.com and submits on ethglobal.com, so none of them reach Devpost,
// and the online board had none of them. ETHOnline 2026 is open as this is
// written, closes on the 16th, and was invisible here.
//
// The reason it is worth a source of its own despite a small catalogue is the
// quality of what the listing states. Every card carries a type pill: "Async
// Hackathon", "IRL Hackathon", "Co-Working" or "Conference". That is a stated
// field for both questions this project has to answer about an event, is it a
// hackathon and can anyone enter from anywhere, and neither has to be inferred
// from a title or a location string. Devpost answers the second one with a
// rendered globe icon; most sources do not answer it at all.
//
// Only the "Async Hackathon" cards are taken. ETHGlobal's IRL hackathons are
// real hackathons, but they are in Tokyo, Mumbai and Bangkok rather than
// anywhere this board serves, and a co-working day or a conference is not a
// hackathon in any region.
//
// The prize has to come from a second page, the way lablab's does. The listing
// states no money at all and the event page itself answers 500 to an anonymous
// request, but /prizes renders fine and states both the sponsor totals and how
// many of them there are. rank.mjs treats a missing prize as 0 rather than
// guessing, so reading only the listing would sink an $80,000 event to the
// bottom of a board it belongs near the top of.
//
// One fetch for the listing plus one per open online hackathon, paced. Never
// exits non-zero for a source problem: a discovery source that can fail the
// whole sweep is a discovery source that gets removed from the sweep.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPatterns, scoreCandidate } from "./lib/candidate-score.mjs";
import { safeFetch } from "./lib/safe-fetch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/ethglobal-candidates.json");

const ORIGIN = "https://ethglobal.com";
const LISTING = `${ORIGIN}/events`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = Number(process.env.ETHGLOBAL_TIMEOUT_MS ?? 25_000);
const MAX_DETAIL = Number(process.env.ETHGLOBAL_MAX_DETAIL ?? 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patterns = buildPatterns(config);
const problems = [];

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) {
      problems.push(`${url}: HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    problems.push(`${url}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const text = (html) =>
  String(html ?? "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * The badge states a month name and one or two day numbers and no year at all,
 * so the year is the one that puts the event in front of us rather than behind.
 * A card in the Upcoming column is by definition not in the past, so December
 * read in January is this year and January read in December is next.
 *
 * A range whose end day is smaller than its start day has crossed into the next
 * month: ETHGlobal prints one month name for the whole range.
 */
function resolveDates(monthName, startDay, endDay, now) {
  const month = MONTHS.indexOf(String(monthName ?? "").toLowerCase());
  if (month < 0 || !startDay) return null;

  const year = now.getUTCFullYear();
  let startYear = year;
  // Two months of slack, so an event that began a fortnight ago and is still
  // running does not get pushed a whole year forward.
  if (Date.UTC(year, month, startDay) < now.getTime() - 60 * 86_400_000) startYear = year + 1;

  // Midnight to midnight in Pacific, the same convention the lablab source
  // uses, because a card reading "4 — 16" means the event runs through the end
  // of the 16th. Taking the 16th at midnight instead would quietly cut a whole
  // day off the deadline, and the deadline is the input rank.mjs weights most.
  const start = new Date(Date.UTC(startYear, month, startDay, 7));
  const last = endDay || startDay;
  const rollsOver = Boolean(endDay) && endDay < startDay;
  const end = new Date(Date.UTC(startYear, month + (rollsOver ? 1 : 0), last + 1, 6, 59));
  return { start, end };
}

/**
 * Cards are anchors whose class begins "block", inside the Upcoming section.
 * Splitting on the anchor rather than on any inner class name is deliberate:
 * the layout classes differ between the wide cards and the narrow ones, and a
 * Tailwind class is the most likely thing on this page to change.
 */
function parseListing(html, now) {
  const start = html.indexOf(">Upcoming");
  const end = html.indexOf(">Past");
  if (start < 0) {
    problems.push(`${LISTING}: no Upcoming section`);
    return [];
  }
  const section = html.slice(start, end > start ? end : undefined);

  const out = [];
  for (const chunk of section.split(/(?=<a class="block)/).slice(1)) {
    const href = chunk.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;

    const title = text(chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    // Every pill on the card, in order. The type is one of them; a city event
    // also carries a location pill, an online one does not.
    const pills = [...chunk.matchAll(/<span class="inline-flex[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/g)]
      .map((m) => text(m[1]))
      .filter(Boolean);
    const kind = pills.find((p) => /hackathon|co-working|conference|summit/i.test(p)) ?? "";
    const place = pills.find((p) => p !== kind) ?? null;

    const month = chunk.match(/tracking-wider"[^>]*>([A-Za-z]+)</)?.[1];
    const days = [...chunk.matchAll(/<span class="">(\d{1,2})<\/span>/g)].map((m) => Number(m[1]));
    const dates = resolveDates(month, days[0], days[1], now);

    out.push({
      url: href.startsWith("http") ? href : `${ORIGIN}${href}`,
      title,
      kind,
      place,
      dates,
      pills,
    });
  }
  return out;
}

/**
 * The pool, from the sponsor totals at the head of the prizes page.
 *
 * Summing every dollar figure on the page does not work and is not off by a
 * little: the page lists each sponsor's total once at the top and then repeats
 * the sponsor with its internal breakdown, so The Graph's $15,000 is also a
 * $5,000 track split into $2,500, $1,500 and $1,000. ETHOnline 2026 totals
 * $80,000 and the naive sum reads $481,764.
 *
 * The page states how many prizes there are ("11 Prizes"), so that count is the
 * boundary: the first eleven figures after it are the eleven sponsor totals,
 * and the twelfth is where the repeats begin. A page that does not state a
 * count returns null rather than a number nobody checked, because rank.mjs
 * reads this straight into a score and a wrong prize is worse than no prize.
 */
function parsePrizePool(html) {
  const body = text(html);
  const stated = body.match(/(\d+)\s+Prizes\b/);
  if (!stated) return null;
  const count = Number(stated[1]);
  if (!Number.isFinite(count) || count <= 0) return null;

  let total = 0;
  let seen = 0;
  for (const m of body.slice(stated.index + stated[0].length).matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s*([km])?\b/gi)) {
    if (seen >= count) break;
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const scale = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
    total += n * scale;
    seen += 1;
  }
  return seen === count ? total : null;
}

const now = new Date();
const listing = await get(LISTING);
const rows = listing ? parseListing(listing, now) : [];

const skipped = { notAsync: 0, undated: 0, finished: 0 };
const candidates = [];

for (const row of rows) {
  // The stated type, not the title. "Pragma Tokyo" is a conference and reads
  // like one; "MIP-19: Road to Devcon" is a co-working day and does not.
  if (!/async hackathon/i.test(row.kind)) {
    skipped.notAsync += 1;
    continue;
  }
  if (!row.dates) {
    skipped.undated += 1;
    continue;
  }
  if (row.dates.end.getTime() < now.getTime()) {
    skipped.finished += 1;
    continue;
  }
  if (candidates.length >= MAX_DETAIL) break;

  let prize = null;
  // Only the slug-shaped ethglobal.com events have a prizes page. A card that
  // links to Luma is somebody else's event being hosted on this calendar.
  if (row.url.startsWith(`${ORIGIN}/events/`)) {
    await sleep(500);
    const prizes = await get(`${row.url}/prizes`);
    if (prizes) prize = parsePrizePool(prizes);
  }

  const evidence = [
    "ETHGlobal",
    row.title,
    row.kind,
    prize ? `Prizes $${prize.toLocaleString("en-US")}` : "Prize pool not stated",
    row.pills.join(" · "),
  ]
    .filter(Boolean)
    .join("\n");

  const scored = scoreCandidate(row.title, evidence, patterns);
  candidates.push({
    url: row.url,
    title: row.title,
    category: "hackathon",
    discoveredVia: LISTING,
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url: row.url,
      name: row.title,
      description: null,
      startDate: row.dates.start.toISOString(),
      endDate: row.dates.end.toISOString(),
      // A month name and two day numbers, no clock time, so the normalizer
      // suppresses the midnight placeholder rather than inventing one.
      timeSource: "ethglobal-date-only",
      organizers: ["ETHGlobal"],
      location: { name: "Online", city: null, region: null, online: true },
      offerAvailability: "InStock",
      going: null,
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
      source: LISTING,
      seen: rows.length,
      candidates: candidates.length,
      online: candidates.length,
      skipped,
      problems,
      note:
        "ETHGlobal's own events page, read anonymously. Only the cards whose " +
        "stated type is \"Async Hackathon\" are taken: the IRL hackathons are " +
        "real but happen in cities this board does not serve, and co-working " +
        "days and conferences are not hackathons anywhere. The type pill is a " +
        "stated field, so neither the hackathon question nor the online " +
        "question is inferred from a title. The prize is summed from each " +
        "event's /prizes page because the listing states no money and the " +
        "event page itself answers 500 to an anonymous request. Dates carry a " +
        "month and day but no year and no clock time.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `ETHGlobal discovery: ${candidates.length} candidate(s) from ${rows.length} upcoming ` +
    `(${skipped.notAsync} not async hackathons, ${skipped.undated} undated, ` +
    `${skipped.finished} already finished)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
