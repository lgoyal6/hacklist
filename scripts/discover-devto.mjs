// DEV's challenge board (dev.to/challenges).
//
// Why this exists: DEV runs a steady stream of sponsor-funded online build
// challenges (Sanity, Kaggle, Notion MCP, Redis, Auth0 and so on, $1,000 to
// $10,000 in prizes) that are submitted as DEV posts, so they never appear on
// Devpost, lablab or Luma. The Sanity Challenge was live with $2,500 in prizes
// and the online board had no trace of it.
//
// Only cards DEV itself marks current are read. The index lists the whole
// archive (eighty-odd past challenges) in the same markup, and the class
// "challenge-index-card--current" is the one thing separating the two. Writing
// challenges are dropped: DEV runs them through the same board, but they are
// essays about something already built, not a build, and the board is for
// builds.
//
// The dates and the prize come from each challenge's page. The index card says
// only "Cash prizes", and the page carries a "Key Dates" sidebar with the
// contest start and the submission deadline as plain dates, no clock time, so
// the normalizer's date-only handling applies exactly as it does for Devpost.
//
// One fetch for the index plus one per current challenge, paced. Never exits
// non-zero for a source problem: a discovery source that can fail the whole
// sweep is a discovery source that gets removed from the sweep.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPatterns, scoreCandidate } from "./lib/candidate-score.mjs";
import { parseDetail, parseListing } from "./lib/devto.mjs";
import { localToUtc } from "./lib/event-dates.mjs";
import { safeFetch } from "./lib/safe-fetch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/devto-candidates.json");

const LISTING = "https://dev.to/challenges";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = Number(process.env.DEVTO_TIMEOUT_MS ?? 20_000);
const MAX_DETAIL = Number(process.env.DEVTO_MAX_DETAIL ?? 15);
// DEV's deadlines are stated as dates; read them in the online board's zone.
const TIMEZONE =
  config.regions?.online?.timezone ?? config.timezone ?? "America/Los_Angeles";
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

const listingHtml = await get(LISTING);
const rows = listingHtml ? parseListing(listingHtml) : [];
const current = rows.filter((row) => row.state === "current");

const candidates = [];
const skipped = { past: rows.length - current.length, writing: 0, undated: 0, ended: 0, detailFailed: 0 };

for (const row of current.slice(0, MAX_DETAIL)) {
  if (/\bwriting\b/i.test(row.title)) {
    skipped.writing += 1;
    continue;
  }
  const html = await get(row.url);
  await sleep(700);
  if (!html) {
    skipped.detailFailed += 1;
    continue;
  }
  const detail = parseDetail(html);
  if (!detail.start || !detail.due) {
    skipped.undated += 1;
    continue;
  }
  const startUtc = localToUtc(detail.start.year, detail.start.month, detail.start.day, 0, 0, TIMEZONE);
  const endUtc = localToUtc(detail.due.year, detail.due.month, detail.due.day, 23, 59, TIMEZONE);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc <= startUtc) {
    skipped.undated += 1;
    continue;
  }
  if (endUtc < Date.now()) {
    skipped.ended += 1;
    continue;
  }

  const prizeLabel = detail.prize ? `$${detail.prize.toLocaleString("en-US")}` : null;
  // DEV describes its own challenges as online hackathons, and that is the
  // phrase the scorer knows. The subtitle and the page text carry the build and
  // prize evidence.
  const evidence = [
    row.title,
    "DEV Online Hackathon",
    "Online",
    row.subtitle,
    prizeLabel ? `${prizeLabel} in prizes` : "Cash prizes",
    detail.text.slice(0, 400),
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
      description: row.subtitle || null,
      startDate: new Date(startUtc).toISOString(),
      endDate: new Date(endUtc).toISOString(),
      // DEV states dates and no clock time, same as Devpost, so the normalizer
      // suppresses the midnight placeholder rather than inventing one.
      timeSource: "devto-date-only",
      organizers: ["DEV Community"],
      location: { name: "Online", city: null, region: null, online: true },
      offerAvailability: "InStock",
      going: null,
      prize: prizeLabel,
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
      current: current.length,
      online: candidates.length,
      skipped,
      problems,
      note:
        "DEV's challenge index, read anonymously. Only cards DEV marks current " +
        "are taken, and writing challenges are dropped because they are not " +
        "builds. Dates and prize come from each challenge's page; dates only, " +
        "no clock times, same as Devpost.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `dev.to discovery: ${candidates.length} candidate(s) from ${current.length} current ` +
    `of ${rows.length} listed (${skipped.writing} writing, ${skipped.undated} undated, ` +
    `${skipped.ended} ended, ${skipped.detailFailed} detail fetch failed)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
