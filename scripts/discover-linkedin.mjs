// LinkedIn discovery: finds hackathons that are announced to a network rather
// than published to a calendar.
//
// Search discovery (scripts/discover-search.mjs) only finds an event once a
// search engine has indexed its registration page. Plenty of Bay Area
// hackathons are announced first — sometimes only — as a LinkedIn post or a
// weekly "Bay Area AI events" digest, and the registration link lives in the
// post body or in the author's own first comment. Those are the ones this pass
// is for.
//
// Two stages, and only the first one can cost money:
//
//   1. Search for LinkedIn pages that talk about Bay Area hackathons. Uses
//      whichever search provider is available; see pickFreeProvider(). When the
//      free provider comes back empty — the keyless endpoint throttles hard —
//      it escalates to a paid per-call LinkedIn search over Zero (x402, no
//      signup), bounded by linkedinMaxPaidQueriesPerRun.
//   2. Read each of those LinkedIn pages over plain HTTPS and pull the event
//      URLs out of them. This stage is free: LinkedIn serves the post body,
//      the article body and the top comments to an anonymous reader, which is
//      where the registration links are. No login, no cookie, no session.
//
// Output is data/linkedin-seeds.json — the same shape as data/search-seeds.json,
// consumed by the sweep in scripts/discover-sf.mjs. A LinkedIn mention is not
// evidence of anything: every URL is still visited and classified on its own
// event page like any other find.
//
// Like search discovery, this never exits non-zero for a source problem. A
// sweep with no LinkedIn results is worth strictly more than a sweep that did
// not run.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/linkedin-seeds.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every network call is bounded. This pass runs unattended on a schedule, and a
// single socket that never answers would otherwise hang the job indefinitely —
// one link shortener that stopped responding stalled a test run for ten minutes.
const FETCH_TIMEOUT_MS = Number(process.env.LINKEDIN_FETCH_TIMEOUT_MS ?? 20_000);
function timed(init = {}) {
  return { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
}
// Belt and braces: even with every call bounded, a long enough queue of slow
// pages could outlast the schedule's next firing. Reading stops at the deadline
// and reports the shortfall rather than running on.
const readDeadline =
  Date.now() + Number(process.env.LINKEDIN_MAX_MINUTES ?? 6) * 60_000;

// The Zero capability that runs the LinkedIn search leg. Priced per call at
// roughly a third of a cent; the slug is what `zero fetch --capability` wants.
const ZERO_SEARCH_URL = "https://linkedin.withzero.ai/run";
const ZERO_SEARCH_CAPABILITY =
  "zeroclick-x402-service-registry-linkedin-search-extract-bd5c1ed3";

/**
 * LinkedIn URL shapes worth reading. Everything else a `site:linkedin.com`
 * search returns — profiles, company pages, job ads, /top-content/ SEO pages —
 * either never carries a registration link or carries hundreds of unrelated
 * ones, so it is not worth a fetch.
 */
const READABLE_LINKEDIN =
  /^\/(?:posts\/[^/]+|pulse\/[^/]+|feed\/update\/[^/]+)\/?$/i;
/** LinkedIn's own event pages. Recorded, not seeded — see the note below. */
const LINKEDIN_EVENT = /^\/events\/[^/]+\/?$/i;

// Luma paths that are surfaces, not events. Same list search discovery uses.
const NON_EVENT_PATH =
  /^(discover|home|signin|signup|create|pricing|help|settings|user|explore|about|terms|privacy|sf|nyc|la|app|calendar|hackathon_collections|maps?|embed)$/i;

const candidatePattern = new RegExp(
  `(${config.candidateTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "i",
);

function allQueries() {
  if (
    Array.isArray(config.linkedinQueries) &&
    config.linkedinQueries.length
  ) {
    return config.linkedinQueries;
  }
  const year = new Date().getFullYear();
  return [
    `hackathon san francisco ${year} lu.ma`,
    `hackathon "bay area" ${year} register luma`,
    `"ai hackathon" san francisco open registration ${year}`,
    `buildathon OR makeathon san francisco ${year} sign up`,
    `hackathon "palo alto" OR berkeley OR oakland ${year} luma`,
    `weekly bay area ai events hackathon ${year}`,
  ];
}

/**
 * A few queries per run, rotating. Identical reasoning to search discovery: the
 * job runs twice a day, so the whole list is covered every few runs without
 * hammering a keyless endpoint or burning a metered quota.
 */
function buildQueries() {
  const all = allQueries();
  const perRun = Math.min(config.linkedinQueriesPerRun ?? 3, all.length);
  const slot = Math.floor(Date.now() / (12 * 3_600 * 1_000));
  const start = ((slot * perRun) % all.length + all.length) % all.length;
  return Array.from({ length: perRun }, (_, i) => all[(start + i) % all.length]);
}

function pickFreeProvider() {
  // Bright Data first when configured: its whole purpose is unblocking, so it is
  // the only provider here that reliably returns results from a datacenter IP —
  // which is what GitHub Actions is. Free tier is 5,000 credits a month with no
  // card, and this pass needs a few hundred.
  if (process.env.BRIGHTDATA_API_KEY) return "brightdata";
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  return "duckduckgo-html";
}

// ---------------------------------------------------------------------------
// Stage 1: find LinkedIn pages that mention Bay Area hackathons.
// ---------------------------------------------------------------------------

/** Results are normalized to {link, text} so every provider looks the same. */
function scopeToLinkedIn(query) {
  return `site:linkedin.com ${query}`;
}

async function searchDuckDuckGo(query) {
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(scopeToLinkedIn(query))}`,
    timed({ headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" } }),
  );
  // 202 is DuckDuckGo's soft rate-limit response: accepted, deliberately empty.
  if (response.status === 202) return { results: [], throttled: true };
  if (!response.ok) return { results: [], error: `HTTP ${response.status}` };
  const html = await response.text();
  const results = [];
  for (const match of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      results.push({ link: decodeURIComponent(match[1]), text: "" });
    } catch {
      // skip malformed
    }
  }
  return { results };
}

async function searchSerper(query) {
  const response = await fetch(
    "https://google.serper.dev/search",
    timed({
      method: "POST",
      headers: {
        "x-api-key": process.env.SERPER_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q: scopeToLinkedIn(query), num: 20 }),
    }),
  );
  if (!response.ok) return { results: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    results: (body.organic ?? [])
      .filter((result) => result.link)
      .map((result) => ({
        link: result.link,
        text: `${result.title ?? ""} ${result.snippet ?? ""}`,
      })),
  };
}

async function searchTavily(query) {
  const response = await fetch(
    "https://api.tavily.com/search",
    timed({
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: scopeToLinkedIn(query),
        max_results: 20,
        search_depth: "basic",
      }),
    }),
  );
  if (!response.ok) return { results: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    results: (body.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        link: result.url,
        text: `${result.title ?? ""} ${result.content ?? ""}`,
      })),
  };
}

/**
 * Bright Data's SERP API, via the unified /request endpoint. Appending
 * `brd_json=1` to the Google URL makes it return parsed results rather than HTML,
 * so there is no markup to scrape.
 *
 * Needs a Web Unlocker / SERP zone; name it in BRIGHTDATA_SERP_ZONE. Untested
 * here for want of an account — it is wired, documented and inert until the key
 * is set, and a wrong response shape is recorded as a problem like any other.
 */
/**
 * Pull result links out of a Google SERP's HTML.
 *
 * Needed because the zone type decides the response format: a SERP API zone
 * honours brd_json=1 and returns parsed JSON, while a Web Unlocker zone returns
 * the page itself. Rejecting HTML as "not JSON" would make the whole leg silently
 * useless on a perfectly good account, so both are handled.
 */
function linksFromSerpHtml(html) {
  const found = [];
  // Google wraps real results in /url?q=<target>&...; the rest are its own chrome.
  for (const match of html.matchAll(/\/url\?q=([^&"'<>]+)/g)) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (/^https?:\/\//.test(decoded)) found.push(decoded);
    } catch {
      // skip malformed
    }
  }
  // Newer markup links directly; keep absolute hrefs that are not Google's own.
  for (const match of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)*(?:google|gstatic|googleusercontent|youtube)\./i.test(match[1])) {
      found.push(match[1]);
    }
  }
  return [...new Set(found)];
}

async function searchBrightData(query) {
  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", scopeToLinkedIn(query));
  target.searchParams.set("num", "20");
  target.searchParams.set("brd_json", "1");
  const response = await fetch(
    "https://api.brightdata.com/request",
    timed({
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
    }),
  );
  if (!response.ok) return { results: [], error: `HTTP ${response.status}` };
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not a SERP-API zone; fall through to reading the page.
  }
  const organic = body?.organic ?? body?.results?.organic ?? null;
  if (Array.isArray(organic)) {
    return {
      results: organic
        .filter((result) => result.link ?? result.url)
        .map((result) => ({
          link: result.link ?? result.url,
          text: `${result.title ?? ""} ${result.description ?? result.snippet ?? ""}`,
        })),
    };
  }
  // HTML zone: no snippets to harvest, just the links. The page fetch that
  // follows is what actually reads each one, so nothing is lost but a shortcut.
  const links = linksFromSerpHtml(text);
  if (!links.length) {
    return { results: [], error: "brightdata: no results in JSON or HTML response" };
  }
  return { results: links.map((link) => ({ link, text: "" })) };
}

async function searchBrave(query) {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(scopeToLinkedIn(query))}&count=20`,
    timed({
      headers: {
        accept: "application/json",
        "x-subscription-token": process.env.BRAVE_API_KEY,
      },
    }),
  );
  if (!response.ok) return { results: [], error: `HTTP ${response.status}` };
  const body = await response.json();
  return {
    results: (body.web?.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        link: result.url,
        text: `${result.title ?? ""} ${result.description ?? ""}`,
      })),
  };
}

/**
 * Where the `zero` CLI lives.
 *
 * Resolved by path rather than by trusting $PATH, because the schedule this
 * pass runs on is launchd, which starts with a minimal PATH that has no
 * ~/.zero in it. Trusting PATH here would mean the paid fallback worked in a
 * terminal and silently did nothing twice a day — the same trap that broke
 * node resolution in scripts/local-passes.sh once already.
 */
function zeroBinary() {
  if (process.env.ZERO_RUNNER) return process.env.ZERO_RUNNER;
  const wellKnown = resolve(homedir(), ".zero/runtime/bin/zero");
  if (existsSync(wellKnown)) return wellKnown;
  return "zero"; // let PATH try; absence is handled as a recorded problem
}

/**
 * Paid LinkedIn search over Zero. The capability wraps a Google
 * `site:linkedin.com` search and injects the site: scope itself, so extra
 * search operators are stripped: passing `inurl:` through makes it answer 502
 * (and still charge for the call).
 */
async function searchZero(query, maxPay) {
  const cleaned = query.replace(/\b(?:site|inurl|intitle|filetype):\S*/gi, "").trim();
  const args = [
    "fetch",
    ZERO_SEARCH_URL,
    "--capability",
    ZERO_SEARCH_CAPABILITY,
    "--json",
    "--max-pay",
    String(maxPay),
    "--timeout",
    "120",
    "-H",
    "Content-Type:application/json",
    "-d",
    JSON.stringify({ query: cleaned }),
  ];
  // The CLI exits non-zero when the capability answers with an error, but it
  // still prints the envelope — which is where the amount actually charged is.
  // Throwing that away would lose both the reason and the spend.
  let stdout;
  try {
    ({ stdout } = await execFileAsync(zeroBinary(), args, {
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.code === "ENOENT") throw error; // no CLI here at all
    stdout = error.stdout ?? "";
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { results: [], error: "zero: no JSON envelope", spent: 0 };
  }
  const spent = Number(envelope.payment?.amount ?? 0);
  if (!envelope.ok) {
    return { results: [], error: `zero HTTP ${envelope.status}`, spent };
  }
  return {
    results: (envelope.body?.results?.organic ?? [])
      .filter((result) => result.link)
      .map((result) => ({
        link: result.link,
        text: `${result.title ?? ""} ${result.description ?? ""}`,
      })),
    spent,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: read the LinkedIn pages and pull event URLs out of them.
// ---------------------------------------------------------------------------

/** Normalize a Luma or allowlisted external event URL, or return null. */
function classifyEventUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (["luma.com", "lu.ma"].includes(host)) {
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!path || path.includes("/")) return null; // event permalinks are one segment
    if (NON_EVENT_PATH.test(path)) return null;
    return `https://luma.com/${path}`;
  }
  // Non-Luma event hosts a post might link to instead. Kept to an allowlist:
  // a LinkedIn post links to plenty of things that are not events.
  if ((config.linkedinEventHosts ?? []).includes(host)) {
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  }
  return null;
}

/** Strip tags so link context can be read as prose. */
function pageText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * Pull event URLs out of one page, each with the words around it.
 *
 * The context matters: a weekly "Bay Area AI events" digest can carry fifty
 * Luma links of which three are hackathons, and seeding all fifty would spend
 * the sweep's page budget on yoga classes. Links whose surrounding text names a
 * hackathon format are marked promising and crawled first; the rest are kept
 * behind them, capped, so the signal is never crowded out.
 */
function eventUrlsWithContext(html) {
  const text = pageText(html);
  const found = new Map();
  const pattern =
    /https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[A-Za-z0-9._%-]+|(?:lu\.ma|luma\.com)\/[A-Za-z0-9._%-]+/g;
  for (const source of [text, html]) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
      const url = classifyEventUrl(raw);
      if (!url) continue;
      // Context is only meaningful from the prose pass; the HTML pass exists so
      // a link that only appears inside an attribute is still collected.
      const context =
        source === text
          ? text.slice(
              Math.max(0, match.index - 260),
              match.index + match[0].length + 160,
            )
          : "";
      const existing = found.get(url);
      if (!existing || (!existing.context && context)) {
        found.set(url, { url, context });
      }
    }
  }
  if (config.linkedinEventHosts?.length) {
    const hosts = config.linkedinEventHosts
      .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const external = new RegExp(
      `https://(?:www\\.)?(?:${hosts})/[A-Za-z0-9._%/-]*`,
      "g",
    );
    for (const match of text.matchAll(external)) {
      const url = classifyEventUrl(match[0]);
      if (!url || found.has(url)) continue;
      found.set(url, {
        url,
        context: text.slice(
          Math.max(0, match.index - 260),
          match.index + match[0].length + 160,
        ),
      });
    }
  }
  return [...found.values()];
}

/**
 * Y Combinator event URLs get their own bucket rather than joining the seed
 * list. events.ycombinator.com is a client-rendered app, so handing one to the
 * headless sweep would visit an empty shell; scripts/discover-yc.mjs reads these
 * out of here and pulls their structured props instead.
 */
function collectYcUrls(source, into) {
  for (const match of source.matchAll(
    /events\.ycombinator\.com\/([A-Za-z0-9._-]+)/g,
  )) {
    into.add(`https://events.ycombinator.com/${match[1]}`);
  }
}

/**
 * LinkedIn shortens outbound links to lnkd.in in some surfaces. Resolve one hop
 * without following it into a browser: the redirect target is all we want.
 */
async function resolveShortLink(url) {
  try {
    const response = await fetch(
      url,
      timed({ method: "GET", redirect: "manual", headers: { "user-agent": UA } }),
    );
    const location = response.headers.get("location");
    if (location) return location;
    // lnkd.in serves an interstitial for some links; the target is in the body.
    if (response.ok) {
      const html = await response.text();
      const match = html.match(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[A-Za-z0-9._%-]+/);
      if (match) return match[0];
    }
  } catch {
    // A shortener that will not resolve is not worth a retry.
  }
  return null;
}

async function readLinkedInPage(url) {
  const response = await fetch(
    url,
    timed({
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      redirect: "follow",
    }),
  );
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const html = await response.text();
  const events = eventUrlsWithContext(html);
  collectYcUrls(html, ycEventUrls);
  // Resolve any lnkd.in wrappers the page used instead of a direct link.
  const shortLinks = [
    ...new Set(
      [...html.matchAll(/https?:\/\/lnkd\.in\/[A-Za-z0-9_-]+/g)].map((m) => m[0]),
    ),
  ].slice(0, config.linkedinShortLinksPerPage ?? 8);
  for (const shortLink of shortLinks) {
    const target = await resolveShortLink(shortLink);
    const resolved = target ? classifyEventUrl(target) : null;
    if (resolved && !events.some((event) => event.url === resolved)) {
      events.push({ url: resolved, context: "" });
    }
  }
  return { events, text: pageText(html) };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const queries = buildQueries();
const freeProvider = pickFreeProvider();
const forcedProvider = process.env.LINKEDIN_SEARCH_PROVIDER || null;
const hasKey = freeProvider !== "duckduckgo-html";
const searchDelayMs = hasKey ? 1_200 : Number(process.env.SEARCH_DELAY_MS ?? 18_000);
const providersUsed = new Set();
const problems = [];
let paidSpend = 0;

async function runSearch(provider, query) {
  switch (provider) {
    case "brightdata":
      return searchBrightData(query);
    case "serper":
      return searchSerper(query);
    case "tavily":
      return searchTavily(query);
    case "brave":
      return searchBrave(query);
    case "zero":
      return searchZero(query, config.linkedinMaxPayPerQuery ?? 0.02);
    default:
      return searchDuckDuckGo(query);
  }
}

/** LinkedIn pages worth reading -> the search text that surfaced them. */
const pages = new Map();
/** LinkedIn-native event pages seen. Reported, not seeded — see the output note. */
const linkedinEvents = new Set();
/** Y Combinator event pages seen. Handed to scripts/discover-yc.mjs. */
const ycEventUrls = new Set();
/** Event URLs read straight out of a search snippet, before any page fetch. */
const fromSnippets = new Map();

function absorb(results, query) {
  let fresh = 0;
  for (const result of results) {
    let url;
    try {
      url = new URL(result.link);
    } catch {
      continue;
    }
    collectYcUrls(`${result.link} ${result.text ?? ""}`, ycEventUrls);
    if (!/(^|\.)linkedin\.com$/.test(url.hostname)) continue;
    const path = url.pathname;
    if (LINKEDIN_EVENT.test(path)) {
      linkedinEvents.add(`https://www.linkedin.com${path.replace(/\/$/, "")}`);
      continue;
    }
    if (!READABLE_LINKEDIN.test(path)) continue;
    const canonical = `https://www.linkedin.com${path.replace(/\/$/, "")}`;
    if (!pages.has(canonical)) fresh += 1;
    const entry = pages.get(canonical) ?? { url: canonical, queries: [], text: "" };
    if (!entry.queries.includes(query)) entry.queries.push(query);
    entry.text = `${entry.text} ${result.text ?? ""}`.trim();
    pages.set(canonical, entry);
    // Snippets often quote the registration link outright, which is a free
    // find whether or not the page fetch below succeeds.
    for (const event of eventUrlsWithContext(result.text ?? "")) {
      if (!fromSnippets.has(event.url)) {
        fromSnippets.set(event.url, {
          ...event,
          context: event.context || result.text || "",
          sourcePage: canonical,
        });
      }
    }
  }
  return fresh;
}

const provider = forcedProvider ?? freeProvider;
for (const [index, query] of queries.entries()) {
  if (index > 0) await sleep(provider === "zero" ? 1_000 : searchDelayMs);
  let result;
  try {
    result = await runSearch(provider, query);
  } catch (error) {
    problems.push({ stage: "search", query, error: String(error).slice(0, 160) });
    continue;
  }
  providersUsed.add(provider);
  paidSpend += result.spent ?? 0;
  if (result.error) problems.push({ stage: "search", query, error: result.error });
  const fresh = absorb(result.results ?? [], query);
  console.log(
    `  [${index + 1}/${queries.length}] ${provider}: ${fresh} new page(s) · ${query}`,
  );
}

// The keyless endpoint throttles a repeat caller to nothing, and a run that
// found no LinkedIn page at all has nothing for stage 2 to read. That is what
// the paid search is for: it is metered, so it is only reached when the free
// path produced nothing, and it is capped per run.
const paidBudget = Number(
  process.env.LINKEDIN_PAID_QUERIES ?? config.linkedinMaxPaidQueriesPerRun ?? 2,
);
if (pages.size === 0 && provider !== "zero" && paidBudget > 0) {
  for (const query of queries.slice(0, paidBudget)) {
    let result;
    try {
      result = await runSearch("zero", query);
    } catch (error) {
      // No `zero` CLI installed here. Expected in CI, and no later query will
      // fare better, so stop asking.
      problems.push({
        stage: "paid-search",
        query,
        error: `zero CLI unavailable: ${String(error.code ?? error).slice(0, 80)}`,
      });
      break;
    }
    providersUsed.add("zero");
    paidSpend += result.spent ?? 0;
    if (result.error) {
      problems.push({ stage: "paid-search", query, error: result.error });
      continue;
    }
    const fresh = absorb(result.results ?? [], query);
    console.log(`  [paid] zero: ${fresh} new page(s) · ${query}`);
  }
}

// Stage 2. Reading a page is free but not instant, so it is budgeted and the
// pages whose search text already looks like a hackathon go first.
const ordered = [...pages.values()].sort((a, b) => {
  const aPromising = candidatePattern.test(`${a.text} ${a.url}`) ? 0 : 1;
  const bPromising = candidatePattern.test(`${b.text} ${b.url}`) ? 0 : 1;
  return aPromising - bPromising;
});
const toRead = ordered.slice(0, config.linkedinPagesPerRun ?? 12);
const foundEvents = new Map(fromSnippets);
let pagesRead = 0;

let readStoppedOnTime = false;
for (const [index, entry] of toRead.entries()) {
  if (Date.now() > readDeadline) {
    readStoppedOnTime = true;
    problems.push({
      stage: "read",
      error: `time budget reached with ${toRead.length - index} page(s) unread`,
    });
    break;
  }
  if (index > 0) await sleep(Number(process.env.LINKEDIN_PAGE_DELAY_MS ?? 1_500));
  let result;
  try {
    result = await readLinkedInPage(entry.url);
  } catch (error) {
    problems.push({ stage: "read", url: entry.url, error: String(error).slice(0, 160) });
    continue;
  }
  if (result.error) {
    problems.push({ stage: "read", url: entry.url, error: result.error });
    continue;
  }
  pagesRead += 1;
  for (const event of result.events) {
    const existing = foundEvents.get(event.url);
    if (existing && existing.context) continue;
    foundEvents.set(event.url, { ...event, sourcePage: entry.url });
  }
  console.log(
    `  read ${entry.url.replace("https://www.linkedin.com", "")} · ${result.events.length} event link(s)`,
  );
}

// Merge with the previous run so a throttled search never shrinks coverage.
let previous = { urls: [] };
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  // first run
}
const merged = new Map();
for (const entry of previous.urls ?? []) merged.set(entry.url, entry);
const now = new Date().toISOString();
for (const event of foundEvents.values()) {
  const promising = candidatePattern.test(
    `${event.context} ${event.url.replace(/[^a-z0-9]+/gi, " ")}`,
  );
  merged.set(event.url, {
    url: event.url,
    promising,
    sourcePage: event.sourcePage ?? null,
    // Enough of the surrounding words to see why this URL is here, without
    // storing whole articles in the repo.
    context: (event.context ?? "").trim().slice(0, 300) || null,
    lastSeenAt: now,
  });
}

// LinkedIn indexes its archive like every other search surface, so this list
// fills up with events that already happened. Unpruned it would spend crawl
// budget on dead URLs every sweep.
const retainMs = (config.linkedinSeedRetentionDays ?? 21) * 86_400_000;
const cutoff = Date.now() - retainMs;
const cap = config.linkedinSeedCap ?? 60;
const kept = [...merged.values()].filter((entry) => {
  const seen = Date.parse(entry.lastSeenAt ?? "");
  return !Number.isFinite(seen) || seen >= cutoff;
});
// Promising first, so the cap trims the digest filler rather than the finds.
const urls = [
  ...kept.filter((entry) => entry.promising),
  ...kept.filter((entry) => !entry.promising),
].slice(0, cap);
const droppedToCap = Math.max(0, kept.length - urls.length);
const pruned = merged.size - kept.length;

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: now,
      searchProviders: [...providersUsed],
      queriesRun: queries.length,
      pagesFound: pages.size,
      pagesRead,
      readStoppedOnTimeBudget: readStoppedOnTime,
      paidSpendUsd: Number(paidSpend.toFixed(6)),
      problems,
      note:
        "Event URLs pulled from public LinkedIn posts and articles. Classified " +
        "by the normal crawler; a LinkedIn mention is not evidence. `promising` " +
        "means the words around the link named a hackathon format.",
      // LinkedIn's own event pages are recorded rather than seeded: the sweep
      // renders candidates in Lightpanda, and LinkedIn is not a surface it can
      // read. Wiring these up needs its own extractor.
      linkedinEventsSeen: [...linkedinEvents],
      // Read by scripts/discover-yc.mjs, which can parse this host properly.
      ycEventUrls: [...ycEventUrls],
      urls,
    },
    null,
    2,
  )}\n`,
);

const promisingCount = urls.filter((entry) => entry.promising).length;
console.log(
  `LinkedIn discovery: ${pages.size} page(s) found, ${pagesRead} read, ` +
    `${foundEvents.size} event URL(s) this run, ${urls.length} tracked ` +
    `(${promisingCount} promising)` +
    (pruned > 0 ? `, ${pruned} stale pruned` : "") +
    (droppedToCap > 0 ? `, ${droppedToCap} over cap` : "") +
    (linkedinEvents.size ? `, ${linkedinEvents.size} LinkedIn-hosted event(s) noted` : "") +
    (ycEventUrls.size ? `, ${ycEventUrls.size} YC event(s) handed to discover-yc` : "") +
    (paidSpend > 0 ? `, $${paidSpend.toFixed(4)} spent` : "") +
    (readStoppedOnTime ? ", stopped on time budget" : "") +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
if (pages.size === 0) {
  console.warn(
    "No LinkedIn pages surfaced. Set SERPER_API_KEY or TAVILY_API_KEY (both " +
      "free, no card) for a reliable search leg, or sign in to the `zero` CLI " +
      "to allow the paid fallback.",
  );
}
