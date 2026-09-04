// lablab.ai's hackathon board.
//
// Why this exists alongside Devpost: lablab runs sponsor-funded AI hackathons
// that never appear on Devpost at all, because entrants submit on lablab's own
// platform. Its board carried AMD, AssemblyAI, Alpaca, IBM and a $60,000 Dubai
// event on the day this was written, and the online board had none of them. The
// only reason a single lablab event was ever visible here is that one Luma
// calendar seed happens to point at lablab.ai, which caught one event out of
// roughly ten open.
//
// No filter on prize or sponsor. The instinct was to keep only the flagships,
// but the count kills that: lablab has run 134 events lifetime and only about
// ten are open at any moment, so there is no flood to protect the board from
// and a filter would only throw away events for no reason. Everything open goes
// through and rank.mjs sorts it, which is what rank.mjs is for.
//
// The prize has to come from the detail page. Six of ten listings state no
// prize in their card text, and those six include the AMD and AI Infra Summit
// flagships. Their detail pages all carry a structured "Prize pool" figure:
// AMD ACT III shows nothing on the board and $5,000 on its page. rank.mjs
// treats a missing prize as 0 rather than guessing, deliberately, so reading
// only the listing would sink the biggest sponsors to the bottom of the board.
//
// One fetch per listing plus one per open event, paced. Never exits non-zero
// for a source problem: a discovery source that can fail the whole sweep is a
// discovery source that gets removed from the sweep.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPatterns,
  scoreCandidate,
} from "./lib/candidate-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/lablab-candidates.json");

const LISTING = "https://lablab.ai/event";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = Number(process.env.LABLAB_TIMEOUT_MS ?? 20_000);
const MAX_DETAIL = Number(process.env.LABLAB_MAX_DETAIL ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patterns = buildPatterns(config);
const problems = [];

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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

/** Largest money figure in a blob, in dollars. "$60,000+" and "$10k" both read. */
function parsePrize(text) {
  let best = 0;
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s*([km])?/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const scale = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
    best = Math.max(best, n * scale);
  }
  return best;
}

/**
 * The listing is a Next.js page, so the reliable structure is the anchor to
 * each event rather than any class name. Status and mode sit in the same anchor
 * text as the registrant count, which is the only figure always present.
 */
function parseListing(html) {
  const out = new Map();
  const anchor = /<a[^>]+href="(\/ai-hackathons\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const path = m[1];
    if (out.has(path)) continue;
    const text = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#\d+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // "LIVEOnline", "RegisterHybrid", "FinishedOnline", "TBAHybrid".
    const status = /finished/i.test(text) ? "finished"
      : /\bLIVE\b/i.test(text) ? "live"
      : /\bTBA\b/i.test(text) ? "tba"
      : /register/i.test(text) ? "upcoming" : "unknown";
    const mode = /hybrid/i.test(text) ? "hybrid" : /online/i.test(text) ? "online" : "unknown";
    const going = Number((text.match(/\b(\d{3,6})\b/) ?? [])[1]) || null;
    out.set(path, { path, text, status, mode, going });
  }
  return [...out.values()];
}

/** Detail pages state the prize as a structured field, and the dates as prose. */
function parseDetail(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // The figure is written three ways across these pages: inline in the hero
  // line ("... in the cloud I Prize Pool $5,000+"), as a label with the amount
  // on the following line, and as a "Total prize pool: $X" heading. Take the
  // largest of whatever is found on a line that mentions a prize at all, rather
  // than the largest figure anywhere, so a sponsor's funding round or a credits
  // offer elsewhere on the page cannot be read as the prize.
  let prize = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/prize/i.test(lines[i])) continue;
    prize = Math.max(prize, parsePrize(lines[i]));
    if (lines[i + 1] && /^[^a-z]*\$/i.test(lines[i + 1])) {
      prize = Math.max(prize, parsePrize(lines[i + 1]));
    }
  }

  // Line 0 is the document title, which always carries lablab's own suffix.
  // Stripping it is more reliable than guessing which later line is the h1:
  // the page puts a "Live page" link, the registrant count and the mode ahead
  // of it, and that order is not guaranteed.
  const title = (lines[0] ?? "")
    .replace(/\s*AI Hackathon\s*\|\s*lablab\.ai\s*$/i, "")
    .replace(/\s*\|\s*lablab\.ai\s*$/i, "")
    .trim()
    .slice(0, 200);
  const partner = lines.find((l) => /×|\bx\b/.test(l) && /lablab/i.test(l)) ?? null;
  return { prize, title, partner, text: lines.slice(0, 120).join("\n") };
}

/**
 * lablab prints ranges like "SEP 1 - 30", "AUG 28 - SEP 4", "OCT 12 - 18".
 * No year and no clock time, same shape as Devpost, so the normalizer's
 * date-only handling applies. A range that has already ended is rolled to next
 * year only when the listing still calls the event live or upcoming.
 */
function parseRange(listingText, stillOpen) {
  const m = listingText.match(
    /\b([A-Z]{3})\s+(\d{1,2})\s*[-–]\s*(?:([A-Z]{3})\s+)?(\d{1,2})\b/,
  );
  if (!m) return null;
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m1 = MONTHS[m[1].toUpperCase()];
  const m2 = MONTHS[(m[3] ?? m[1]).toUpperCase()];
  if (m1 === undefined || m2 === undefined) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  let start = new Date(Date.UTC(year, m1, Number(m[2]), 7));
  let end = new Date(Date.UTC(year, m2, Number(m[4]) + 1, 6, 59));
  if (end < start) end = new Date(Date.UTC(year + 1, m2, Number(m[4]) + 1, 6, 59));
  if (end < now && stillOpen) {
    start = new Date(Date.UTC(year + 1, m1, Number(m[2]), 7));
    end = new Date(Date.UTC(year + 1, m2, Number(m[4]) + 1, 6, 59));
  }
  return { start, end };
}

const listingHtml = await get(LISTING);
const rows = listingHtml ? parseListing(listingHtml) : [];
// Finished events are history, and a TBA one has no date to put on a board.
const open = rows.filter((r) => r.status === "live" || r.status === "upcoming");

const candidates = [];
const skipped = { finished: 0, tba: 0, undated: 0, detailFailed: 0 };
for (const r of rows) {
  if (r.status === "finished") skipped.finished += 1;
  if (r.status === "tba") skipped.tba += 1;
}

for (const row of open.slice(0, MAX_DETAIL)) {
  const url = `https://lablab.ai${row.path}`;
  const html = await get(url);
  await sleep(700);
  if (!html) {
    skipped.detailFailed += 1;
    continue;
  }
  const detail = parseDetail(html);
  const dates = parseRange(row.text, true);
  if (!dates) {
    skipped.undated += 1;
    continue;
  }

  const title = detail.title || row.text.slice(0, 120);
  const evidence = [
    detail.partner,
    title,
    row.mode === "hybrid" ? "Hybrid" : "Online",
    detail.prize ? `Prizes $${detail.prize.toLocaleString("en-US")}` : "Prize pool not stated",
    row.going ? `${row.going} Going` : null,
    row.text.slice(0, 200),
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
      startDate: dates.start.toISOString(),
      endDate: dates.end.toISOString(),
      // lablab prints a date range and no clock time, same as Devpost, so the
      // normalizer suppresses the midnight placeholder rather than inventing one.
      timeSource: "lablab-date-only",
      organizers: ["lablab.ai"],
      // Hybrid events keep an on-site phase somewhere in the world, but the
      // build is online and anyone can enter from anywhere, which is the only
      // question the online board is asking.
      location: { name: "Online", city: null, region: null, online: true },
      offerAvailability: "InStock",
      going: row.going,
      // rank.mjs reads a prize label off the board and treats a missing one as
      // zero. Six of ten listings state no prize, so this is the field that
      // stops the biggest sponsors sorting to the bottom.
      prize: detail.prize ? `$${detail.prize.toLocaleString("en-US")}` : null,
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
        "lablab.ai's own hackathon board, read anonymously. Every open event is " +
        "taken: only about ten are open at once, so there is nothing to filter " +
        "against. The prize is read from each detail page, not the listing, " +
        "because six of ten listings omit it and those six include the largest " +
        "sponsors. Dates only, no clock times, same as Devpost. Hybrid events " +
        "are treated as online because the build phase is.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `lablab discovery: ${candidates.length} candidate(s) from ${rows.length} seen ` +
    `(${skipped.finished} finished, ${skipped.tba} undated TBA, ` +
    `${skipped.undated} unparseable dates, ${skipped.detailFailed} detail fetch failed)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
