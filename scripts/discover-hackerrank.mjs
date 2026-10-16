// HackerRank's own hackathons.
//
// Why this exists: HackerRank runs online hackathons on its own site and hosts
// company ones on HackerRank Engage, and none of them reach Devpost, lablab or
// any Luma calendar. Orchestrate (a monthly 24-hour agent build with an AI
// judge, 12k to 40k entrants) and the micro1 Eval Hackathon were both open on
// the day this was written and neither had ever been on the board.
//
// Two places list them, so two reads:
//
// - The contests feed, /rest/contests/upcoming. Despite the name it returns
//   every contest newest first, back to 2017, with exact epoch start and end
//   times and a signup count. Only contests that have not ended are taken.
// - The promoted cards on /contests, which is where HackerRank Engage events
//   (micro1, company challenges) appear. Each card carries its event URL in a
//   data-attr1 attribute in the server-rendered HTML. Those pages state the
//   challenge start and a duration in prose, not as fields.
//
// Events that call themselves a hackathon are hackathons. Everything else open
// here is a company challenge ("Salesforce Design Challenge", a timed contest):
// not a hackathon, but a build-adjacent recruiting event, so it is kept as
// "adjacent" with that reason rather than dropped. hackqueue's recruiting lane
// reads those. Prize amounts on Engage pages render client-side and are not in
// the HTML, so they are left unstated rather than guessed.
//
// Never exits non-zero for a source problem: a discovery source that can fail
// the whole sweep is a discovery source that gets removed from the sweep.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPatterns, scoreCandidate } from "./lib/candidate-score.mjs";
import { engageDates, pageText, promotedEvents, titleOf } from "./lib/hackerrank.mjs";
import { safeFetch } from "./lib/safe-fetch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(resolve(root, "config/discovery.json"), "utf8"));
const outputPath = resolve(root, "data/hackerrank-candidates.json");

const BASE = "https://www.hackerrank.com";
const FEED = `${BASE}/rest/contests/upcoming?offset=0&limit=100`;
const LISTING = `${BASE}/contests`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = Number(process.env.HACKERRANK_TIMEOUT_MS ?? 20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patterns = buildPatterns(config);
const problems = [];

async function get(url, accept = "text/html") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { headers: { "user-agent": UA, accept }, signal: controller.signal });
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

const isHackathon = (...texts) => texts.some((t) => /\bhackathon\b/i.test(t ?? ""));

const candidates = [];
// notHackathon counts the ones kept as adjacent company challenges.
const skipped = { ended: 0, notHackathon: 0, undated: 0, fetchFailed: 0 };

const CHALLENGE = "company challenge on HackerRank, not a hackathon";

function candidate({ url, title, text, start, end, going, organizer, adjacent = false }) {
  const evidence = [title, "Online", going ? `${going} Going` : null, text.slice(0, 600)].filter(Boolean).join("\n");
  const scored = scoreCandidate(title, evidence, patterns);
  return {
    url,
    title,
    category: adjacent ? "adjacent" : "hackathon",
    discoveredVia: LISTING,
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: adjacent ? CHALLENGE : null,
    structuredEvent: {
      url,
      name: title,
      description: null,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      // Both reads carry real clock times: the feed as epochs, Engage pages in GMT.
      timeSource: "hackerrank",
      organizers: [organizer],
      location: { name: "Online", city: null, region: null, online: true },
      offerAvailability: "InStock",
      going: going ?? null,
      prize: null,
    },
  };
}

// 1. The contests feed.
const feed = await get(FEED, "application/json");
let models = [];
try {
  models = feed ? JSON.parse(feed).models ?? [] : [];
} catch (error) {
  problems.push(`${FEED}: unreadable JSON (${error.message})`);
}
const now = Date.now();
for (const m of models) {
  if (!m.epoch_endtime || m.epoch_endtime * 1000 <= now) {
    skipped.ended += 1;
    continue;
  }
  // The contest's landing page is where its title says what it is: the feed
  // calls Orchestrate "Orchestrate October'26", the page calls it a hackathon.
  const url = `${BASE}/${m.slug}`;
  const html = await get(url);
  await sleep(500);
  if (!html) {
    skipped.fetchFailed += 1;
    continue;
  }
  const title = titleOf(html) || m.name;
  const text = pageText(html);
  const adjacent = !isHackathon(title, m.name, text.slice(0, 400));
  if (adjacent) skipped.notHackathon += 1;
  candidates.push(candidate({
    adjacent,
    url,
    title: /orchestrate/i.test(m.name) ? `HackerRank ${m.name.replace(/'(\d\d)$/, " 20$1")}` : title,
    text,
    start: new Date(m.epoch_starttime * 1000),
    end: new Date(m.epoch_endtime * 1000),
    going: m.signup_count ?? null,
    organizer: "HackerRank",
  }));
}

// 2. Promoted HackerRank Engage events.
const listing = await get(LISTING);
for (const url of promotedEvents(listing)) {
  if (candidates.some((c) => c.url === url)) continue;
  const html = await get(url);
  await sleep(500);
  if (!html) {
    skipped.fetchFailed += 1;
    continue;
  }
  const title = titleOf(html);
  const text = pageText(html);
  const adjacent = !isHackathon(title);
  const dates = engageDates(text);
  if (!dates) {
    skipped.undated += 1;
    continue;
  }
  if (dates.end.getTime() <= now) {
    skipped.ended += 1;
    continue;
  }
  const organizer = (title.match(/^(\S+)/) ?? [])[1] ?? "HackerRank";
  if (adjacent) skipped.notHackathon += 1;
  candidates.push(candidate({ url, title, text, ...dates, going: null, organizer, adjacent }));
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: LISTING,
      seen: models.length,
      candidates: candidates.length,
      online: candidates.length,
      skipped,
      problems,
      note:
        "HackerRank's contests feed plus the promoted HackerRank Engage events on " +
        "/contests. Events that call themselves hackathons are hackathons; the rest " +
        "are company challenges, kept as adjacent. All online. Prizes on Engage pages " +
        "render client-side and are left unstated.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `hackerrank discovery: ${candidates.length} candidate(s) from ${models.length} feed contests ` +
    `(${skipped.ended} ended, ${skipped.notHackathon} company challenges kept as adjacent, ${skipped.undated} undated, ` +
    `${skipped.fetchFailed} fetch failed)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
