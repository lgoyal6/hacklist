// Query-based discovery: finds events that no calendar we follow links to.
//
// Everything else in the pipeline reaches events by crawling outward from known
// calendars, so a hackathon nobody curates stays invisible. This asks a search
// engine instead, and writes the event URLs it finds to data/search-seeds.json
// for the normal crawler to visit and classify. Being a search hit is not
// evidence of anything — every URL still faces the same classifier.
//
// Providers:
//   * Brave Search API when BRAVE_API_KEY is set — reliable, use this in CI.
//   * DuckDuckGo's public HTML endpoint otherwise — no key, but it rate-limits
//     aggressively, so queries are spaced out and soft failures are tolerated.
//
// This script never exits non-zero for search problems: a sweep with no search
// results is worth strictly more than a sweep that did not run.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/search-seeds.json");

// Any one of these works; pick whichever you can sign up for. Serper and
// Tavily take no card, Brave now bills new accounts, and DuckDuckGo needs no
// key but throttles a repeat caller to nothing.
// Bright Data first when configured: it is the only one of these that reliably
// answers from a datacenter IP, which is what CI runs on. Free tier is 5,000
// credits a month with no card; this pass spends a few hundred.
const provider = process.env.BRIGHTDATA_API_KEY
  ? "brightdata"
  : process.env.SERPER_API_KEY
    ? "serper"
    : process.env.TAVILY_API_KEY
      ? "tavily"
      : process.env.BRAVE_API_KEY
        ? "brave"
        : "duckduckgo-html";
const hasKey = provider !== "duckduckgo-html";
const delayMs = hasKey ? 1_200 : Number(process.env.SEARCH_DELAY_MS ?? 18_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Luma paths that are surfaces, not events.
const NON_EVENT_PATH =
  /^(discover|home|signin|signup|create|pricing|help|settings|user|explore|about|terms|privacy|sf|nyc|la|app|calendar|hackathon_collections|maps?|embed)$/i;

function allQueries() {
  if (Array.isArray(config.searchQueries) && config.searchQueries.length) {
    return config.searchQueries;
  }
  const year = new Date().getFullYear();
  return [
    `site:luma.com hackathon san francisco ${year}`,
    `site:lu.ma hackathon san francisco ${year}`,
    `site:luma.com hackathon "bay area" ${year}`,
    `site:luma.com buildathon OR makeathon OR "make-a-thon" bay area`,
    `site:luma.com "ai hackathon" san francisco upcoming`,
    `luma "hackathon" oakland OR berkeley OR "palo alto" ${year}`,
    `luma.com hackathon "san jose" OR "santa clara" OR sunnyvale ${year}`,
    `"hackathon" san francisco ${year} register lu.ma`,
  ];
}

/**
 * Run only a few queries per sweep and rotate which ones. Firing the whole list
 * at once is what got the keyless endpoint blocked, and it burns a metered quota
 * for no reason: the job runs twice a day, so the full list is covered every few
 * runs anyway.
 */
function buildQueries() {
  const all = allQueries();
  const perRun = Math.min(
    config.searchQueriesPerRun ?? (hasKey ? 8 : 2),
    all.length,
  );
  // A stateless rotation that advances every 12 hours, matching the schedule.
  const slot = Math.floor(Date.now() / (12 * 3_600 * 1_000));
  const start = ((slot * perRun) % all.length + all.length) % all.length;
  return Array.from({ length: perRun }, (_, i) => all[(start + i) % all.length]);
}

/** Pull absolute URLs out of DuckDuckGo's redirect-wrapped results. */
function urlsFromDuckDuckGo(html) {
  const found = [];
  for (const match of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      found.push(decodeURIComponent(match[1]));
    } catch {
      // skip malformed
    }
  }
  // Some results are plain links rather than redirects.
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[a-z0-9._-]+/gi)) {
    found.push(match[0]);
  }
  return found;
}

async function searchDuckDuckGo(query) {
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    },
  );
  // 202 is DuckDuckGo's soft rate-limit response: accepted, deliberately empty.
  if (response.status === 202) return { urls: [], throttled: true };
  if (!response.ok) return { urls: [], error: `HTTP ${response.status}` };
  const html = await response.text();
  return { urls: urlsFromDuckDuckGo(html), throttled: false };
}

async function searchSerper(query) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "x-api-key": process.env.SERPER_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ q: query, num: 20 }),
  });
  if (!response.ok) return { urls: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    urls: [...(body.organic ?? []), ...(body.topStories ?? [])]
      .map((result) => result.link)
      .filter(Boolean),
  };
}

async function searchTavily(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, max_results: 20, search_depth: "basic" }),
  });
  if (!response.ok) return { urls: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    urls: (body.results ?? []).map((result) => result.url).filter(Boolean),
  };
}

/**
 * Bright Data's SERP API via the unified /request endpoint; `brd_json=1` makes
 * Google return parsed results instead of HTML. Needs a Web Unlocker / SERP zone
 * named in BRIGHTDATA_SERP_ZONE. Wired and documented but untested for want of an
 * account — inert until BRIGHTDATA_API_KEY is set, and a bad response shape is
 * reported as a problem rather than throwing.
 */
async function searchBrightData(query) {
  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", query);
  target.searchParams.set("num", "20");
  target.searchParams.set("brd_json", "1");
  const response = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      zone: process.env.BRIGHTDATA_SERP_ZONE ?? "serp_api",
      url: target.toString(),
      format: "raw",
    }),
  });
  if (!response.ok) return { urls: [], error: `HTTP ${response.status}` };
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { urls: [], error: "brightdata: response was not JSON" };
  }
  const organic = body.organic ?? body.results?.organic ?? [];
  if (!Array.isArray(organic)) {
    return { urls: [], error: "brightdata: no organic array in response" };
  }
  return { urls: organic.map((result) => result.link ?? result.url).filter(Boolean) };
}

async function searchBrave(query) {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`,
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": process.env.BRAVE_API_KEY,
      },
    },
  );
  if (!response.ok) return { urls: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    urls: (body.web?.results ?? []).map((result) => result.url).filter(Boolean),
  };
}

function classifyUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (!["luma.com", "lu.ma"].includes(host)) return null; // Luma events only
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!path || path.includes("/")) return null; // event permalinks are one segment
  if (NON_EVENT_PATH.test(path)) return null;
  return `https://luma.com/${path}`;
}

const queries = buildQueries();
const found = new Map(); // url -> queries that surfaced it
let throttled = 0;
const problems = [];

for (const [index, query] of queries.entries()) {
  if (index > 0) await sleep(delayMs);
  let result;
  try {
    result =
      provider === "brightdata"
        ? await searchBrightData(query)
        : provider === "serper"
        ? await searchSerper(query)
        : provider === "tavily"
          ? await searchTavily(query)
          : provider === "brave"
            ? await searchBrave(query)
            : await searchDuckDuckGo(query);
  } catch (error) {
    problems.push({ query, error: String(error).slice(0, 120) });
    continue;
  }
  if (result.error) problems.push({ query, error: result.error });
  if (result.throttled) {
    throttled += 1;
    // Back off once, then move on rather than hammering.
    await sleep(delayMs * 2);
    try {
      result = await searchDuckDuckGo(query);
    } catch {
      continue;
    }
  }

  let fresh = 0;
  for (const raw of result.urls ?? []) {
    const url = classifyUrl(raw);
    if (!url) continue;
    if (!found.has(url)) fresh += 1;
    const queriesFor = found.get(url) ?? [];
    if (!queriesFor.includes(query)) queriesFor.push(query);
    found.set(url, queriesFor);
  }
  console.log(`  [${index + 1}/${queries.length}] ${fresh} new · ${query}`);
}

// Merge with previous results so a throttled run never shrinks coverage.
let previous = { urls: [] };
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  // first run
}
const merged = new Map();
for (const entry of previous.urls ?? []) merged.set(entry.url, entry);
for (const [url, viaQueries] of found) {
  merged.set(url, { url, queries: viaQueries, lastSeenAt: new Date().toISOString() });
}

// Search engines mostly index the archive, so this list fills with events that
// have already happened. Left unpruned it would spend crawl budget on dead URLs
// every sweep, so entries stop being retried once they go stale.
const retainMs = (config.searchSeedRetentionDays ?? 21) * 86_400_000;
const cutoff = Date.now() - retainMs;
const urls = [...merged.values()]
  .filter((entry) => {
    const seen = Date.parse(entry.lastSeenAt ?? "");
    return !Number.isFinite(seen) || seen >= cutoff;
  })
  .sort((a, b) => a.url.localeCompare(b.url))
  .slice(0, config.searchSeedCap ?? 60);
const pruned = merged.size - urls.length;
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      provider,
      queriesRun: queries.length,
      throttledQueries: throttled,
      problems,
      note: "Public event URLs from web search. Classified by the normal crawler; a search hit is not evidence.",
      urls,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Search discovery: ${found.size} event URLs this run, ${urls.length} tracked total` +
    (pruned > 0 ? `, ${pruned} stale pruned` : "") +
    (throttled ? `, ${throttled} query(ies) throttled` : "") +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
if (!hasKey && throttled >= Math.ceil(queries.length / 2)) {
  console.warn(
    "Queries were rate-limited. For reliable search set one of " +
      "SERPER_API_KEY or TAVILY_API_KEY (both free, no card) or BRAVE_API_KEY.",
  );
}
