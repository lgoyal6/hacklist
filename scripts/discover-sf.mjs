import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lightpanda } from "@lightpanda/browser";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);

const escapePattern = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const vocabularyPattern = new RegExp(
  `\\b(${config.candidateTerms.map(escapePattern).join("|")})\\b`,
  "i",
);
// Organisers invent a new "-a-thon" every week (dog-a-thon, make-a-thon,
// print-a-thon), so match the shape rather than trying to list them. The
// separator before "a" is required so this does not fire on "marathon".
const athonPattern = /\b[a-z]{3,}[-\s]a[-\s]?thon\b/i;
const candidatePattern = {
  test: (text) => vocabularyPattern.test(text) || athonPattern.test(text),
};
const buildPattern =
  /\b(build|ship|prototype|code|hack|create|make|implement|develop)\w*\b/i;
const competitionPattern =
  /\b(team|submission|deadline|judge|judging|winner|prize|bount(?:y|ies)|demo day|pitch)\w*\b/i;
const negativePattern =
  /\b(meetup|happy hour|fireside|conference|screening|dinner|networking|workshop)\b/i;
// Formats that are not hackathons. A title naming one of these is only
// publishable when the title also names a hackathon format, so
// "AI Infra Summit Hackathon" survives while "MITAI Conference" does not.
const negativeTitlePattern =
  /\b(meet[-\s]?ups?|conference|summit|webinar|expo|mixer|happy hour|fireside|panel|screening|dinner|networking|workshop|office hours|pitch night|demo night|launch party|party|social|talk|talks|showcase|open house|salons?|series|roundtable|symposium|forum|town hall|book club|concert|film)\b/i;
const locationPattern = new RegExp(
  `\\b(${config.placeTerms.map(escapePattern).join("|")})\\b`,
  "i",
);

function canonicalize(raw, base, allowExternal = false) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:") return null;
    const isLuma = ["luma.com", "lu.ma"].includes(url.hostname);
    if (!isLuma && !allowExternal) return null;
    if (isLuma) {
      url.hostname = "luma.com";
      url.search = "";
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|ref$|ref_|source$)/i.test(key)) url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isLumaUrl(url) {
  return new URL(url).hostname === "luma.com";
}

// Curated hackathon boards we trust as inventories rather than as pages to
// classify. Every event they list is visited and classified on its own page,
// because a listing's summary metadata is far too thin to judge from: the
// "Dog-a-thon" reads as an unknown word in a JSON-LD blob and as an obvious
// hackathon on its own page.
function isCuratedIndex(url) {
  return (config.curatedIndexUrls ?? []).includes(url);
}

function needsSlowRender(url) {
  return (config.slowRenderUrls ?? []).includes(url);
}

/**
 * Pages that list many events and load them as you scroll. Reading one without
 * scrolling sees only the first screenful: the signed-in pass found 141 events
 * across these surfaces while the sweep was seeing a fraction of that, and 135
 * of those needed no login at all.
 */
function isBrowseSurface(url) {
  const path = new URL(url).pathname;
  return (
    isCuratedIndex(url) ||
    path.startsWith("/discover") ||
    // A calendar's own page is the same kind of surface: a virtualized list that
    // renders a screenful and loads the rest as you scroll. Read without
    // scrolling it reports a calendar as nearly empty.
    path.startsWith("/calendar/")
  );
}

function eventKey(title) {
  return title
    .toLowerCase()
    .replace(/\s*-\s*open registration\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function structuredEvidence(event) {
  return [
    event.name,
    event.description,
    ...(event.organizers ?? []),
    event.location?.name,
    event.location?.city,
    event.location?.region,
  ]
    .filter(Boolean)
    .join("\n");
}

function scorePage(title, text) {
  const combined = `${title}\n${text}`;
  const direct = candidatePattern.test(combined);
  const builds = buildPattern.test(combined);
  const competes = competitionPattern.test(combined);
  const negative = negativePattern.test(title);
  const local = locationPattern.test(combined);

  const signals = {
    directHackathonTerm: direct,
    buildEvidence: builds,
    competitionEvidence: competes,
    sfBayAreaEvidence: local,
    negativeTitleEvidence: negative,
  };

  let confidence = direct ? 62 : 20;
  if (builds) confidence += 16;
  if (competes) confidence += 16;
  if (negative && !(builds && competes)) confidence -= 30;
  confidence = Math.max(0, Math.min(100, confidence));

  let relevance = Math.round(confidence * 0.65);
  if (local) relevance += 20;
  if (/\b(open|register|approval required|request to join)\b/i.test(combined)) {
    relevance += 8;
  }
  if (/\b(prize|bount(?:y|ies)|cash|credits?)\b/i.test(combined)) {
    relevance += 7;
  }
  relevance = Math.max(0, Math.min(100, relevance));

  return { confidence, relevance, signals };
}

async function extractPage(
  page,
  url,
  { settleMs = 350, timeoutMs = 12_000, scrollPasses = 0 } = {},
) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    // A slow page is not a dead page: navigation often times out on
    // subresources after the DOM is usable, so read whatever rendered
    // instead of discarding the visit. Genuinely empty pages simply yield
    // no candidates below.
    if (!/timed?\s?out|timeout/i.test(String(error))) throw error;
  }
  await page.waitForTimeout(settleMs);
  for (let pass = 0; pass < scrollPasses; pass++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(700);
  }

  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a[href]")].map((link) => {
      const ownText = (link.textContent || "").replace(/\s+/g, " ").trim();
      const surroundingText = (link.parentElement?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      return {
        href: link.getAttribute("href") || "",
        text: ownText || surroundingText,
      };
    });
    const bodyText = (document.body?.innerText || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const structuredEvents = [];
    const seenEvents = new Set();
    const types = (value) =>
      (Array.isArray(value) ? value : [value]).filter(Boolean);
    const organizerNames = (organizer) =>
      (Array.isArray(organizer) ? organizer : [organizer])
        .map((item) => (typeof item === "string" ? item : item?.name))
        .filter(Boolean);
    const walk = (value) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (types(value["@type"]).includes("Event")) {
        const address = value.location?.address;
        const event = {
          url: value.url || value["@id"] || null,
          name: value.name || null,
          description: value.description || null,
          startDate: value.startDate || null,
          endDate: value.endDate || null,
          attendanceMode: value.eventAttendanceMode || null,
          eventStatus: value.eventStatus || null,
          location: {
            name: value.location?.name || null,
            city:
              (typeof address === "object" && address?.addressLocality) || null,
            region:
              (typeof address === "object" && address?.addressRegion) || null,
          },
          organizers: organizerNames(value.organizer),
          offerAvailability: (Array.isArray(value.offers)
            ? value.offers
            : [value.offers]
          )
            .map((offer) => offer?.availability)
            .find(Boolean) || null,
        };
        const key = `${event.url || event.name}|${event.startDate || ""}`;
        if (event.name && !seenEvents.has(key)) {
          seenEvents.add(key);
          structuredEvents.push(event);
        }
      }
      Object.values(value).forEach(walk);
    };
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      try {
        walk(JSON.parse(script.textContent || "null"));
      } catch {
        // Ignore malformed third-party JSON-LD blocks.
      }
    }
    return { title: document.title, bodyText, links, structuredEvents };
  });
}

const host = "127.0.0.1";
// A previous interrupted sweep must not block the next one on a fixed port.
const port = 10_000 + Math.floor(Math.random() * 20_000);
const processHandle = await lightpanda.serve({ host, port });
const browser = await chromium.connectOverCDP(`ws://${host}:${port}`);
const context = await browser.newContext();
const page = await context.newPage();

// Event URLs collected by the local personalized pass (see
// scripts/discover-personalized.mjs). They are crawled and classified exactly
// like anonymous finds — being recommended is not evidence of anything.
let personalizedSeeds = [];
try {
  const personalized = JSON.parse(
    await readFile(resolve(root, "data/personalized-seeds.json"), "utf8"),
  );
  // Keep the card text: a personalized feed is mostly general events, so the
  // ones whose names look like hackathons are visited first and the rest fill
  // whatever budget is left over.
  personalizedSeeds = (personalized.urls ?? []).map((entry) => ({
    url: entry.url,
    promising: candidatePattern.test(
      `${entry.text ?? ""} ${entry.url.replace(/[^a-z0-9]+/gi, " ")}`,
    ),
  }));
} catch {
  // Optional input; absent until the local pass has run.
}

/** Take `size` items, advancing the window every 12 hours to match the schedule. */
function rotateSlice(items, size) {
  if (items.length <= size) return items;
  const slot = Math.floor(Date.now() / (12 * 3_600 * 1_000));
  const start = ((slot * size) % items.length + items.length) % items.length;
  return Array.from({ length: size }, (_, i) => items[(start + i) % items.length]);
}

// Event URLs from web search (scripts/discover-search.mjs). These reach events
// no calendar we follow links to, which is the whole point, but a search hit is
// not evidence: each one is classified on its own page like anything else.
let searchSeeds = [];
try {
  const searched = JSON.parse(
    await readFile(resolve(root, "data/search-seeds.json"), "utf8"),
  );
  searchSeeds = (searched.urls ?? []).map((entry) => entry.url);
} catch {
  // Optional input; absent until search discovery has run.
}

// Calendars that Luma's public API saw hosting a hackathon
// (scripts/discover-luma-api.mjs). The feed reaches events on calendars nobody
// seeded, and the calendar behind one hackathon usually runs more — so the
// crawl's reach grows from what the API found, without anyone editing config.
let apiCalendarSeeds = [];
try {
  const lumaApi = JSON.parse(
    await readFile(resolve(root, "data/luma-api.json"), "utf8"),
  );
  const configured = new Set(config.seedUrls);
  apiCalendarSeeds = (lumaApi.calendarSeeds ?? [])
    .map((slug) => `https://luma.com/${slug}`)
    .filter((url) => !configured.has(url));
} catch {
  // Optional input; absent until the API pass has run.
}

// Event URLs pulled out of public LinkedIn posts and articles
// (scripts/discover-linkedin.mjs). These reach hackathons that were announced
// to a network and never indexed as an event page, which search discovery
// cannot see. A LinkedIn mention is not evidence either: same classifier.
let linkedinSeeds = [];
try {
  const linkedin = JSON.parse(
    await readFile(resolve(root, "data/linkedin-seeds.json"), "utf8"),
  );
  // `promising` means the words around the link named a hackathon format. A
  // weekly events digest links dozens of unrelated events, so the ones that
  // read like hackathons are visited before the remainder.
  linkedinSeeds = (linkedin.urls ?? []).map((entry) => ({
    url: entry.url,
    promising: entry.promising === true,
  }));
} catch {
  // Optional input; absent until LinkedIn discovery has run.
}

const queue = [
  ...config.seedUrls.map((url) => ({
    url,
    depth: 0,
    via: "seed",
    allowExternal: !["luma.com", "lu.ma"].includes(new URL(url).hostname),
  })),
  // Calendars the API found hosting a hackathon. Crawled like any other seed,
  // but capped per run so a growing list cannot crowd out the configured ones.
  ...rotateSlice(apiCalendarSeeds, config.apiCalendarSeedsPerRun ?? 12).map(
    (url) => ({ url, depth: 1, via: "luma-api-calendar", allowExternal: false }),
  ),
  // Promising ones ahead of the anonymous seeds, the remainder behind them.
  ...personalizedSeeds
    .filter((entry) => entry.promising)
    .map((entry) => ({
      url: entry.url,
      depth: 1, // already an event page; do not expand a graph from it
      via: "personalized",
      allowExternal: false,
    })),
  // LinkedIn finds that read like hackathons, ahead of the anonymous seeds.
  // Unlike every other seed source these are not all Luma URLs: a post links
  // straight to Devpost or an organizer's own page just as often.
  ...linkedinSeeds
    .filter((entry) => entry.promising)
    .map((entry) => ({
      url: entry.url,
      depth: config.maxGraphDepth, // visit and classify, never expand
      via: "linkedin",
      allowExternal: !["luma.com", "lu.ma"].includes(
        new URL(entry.url).hostname,
      ),
    })),
  ...searchSeeds.map((url) => ({
    url,
    depth: config.maxGraphDepth, // visit and classify, never expand
    via: "search",
    allowExternal: false,
  })),
  ...linkedinSeeds
    .filter((entry) => !entry.promising)
    .map((entry) => ({
      url: entry.url,
      depth: config.maxGraphDepth,
      via: "linkedin",
      allowExternal: !["luma.com", "lu.ma"].includes(
        new URL(entry.url).hostname,
      ),
    })),
  // The rest of the personalized feed is mostly general events, and visiting
  // all of it every sweep would cost more time than it is worth. Take a slice
  // per run and rotate, so everything is covered over a couple of days while
  // any single sweep stays inside its budget.
  ...rotateSlice(
    personalizedSeeds.filter((entry) => !entry.promising),
    config.personalizedPerRun ?? 40,
  ).map((entry) => ({
    url: entry.url,
    depth: config.maxGraphDepth,
    via: "personalized",
    allowExternal: false,
  })),
];
const visited = new Set();
const candidates = new Map();
const review = new Map();
const errors = [];
let structuredEventsFound = 0;
let externalPagesVisited = 0;

function recordCandidate(candidate) {
  const titleKey = eventKey(candidate.title);
  const urlMatch = [...candidates.entries()].find(
    ([, existingCandidate]) => existingCandidate.url === candidate.url,
  );
  const key = urlMatch?.[0] ?? titleKey;
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(titleKey, candidate);
    return;
  }
  const preferred =
    candidate.relevance > existing.relevance ? candidate : existing;
  const fallback = preferred === candidate ? existing : candidate;
  // Whichever record saw more of the page decides the category and supplies the
  // evidence: a visited page knows things a listing blurb cannot.
  const richer =
    preferred.evidence.length >= fallback.evidence.length ? preferred : fallback;
  candidates.set(key, {
    ...preferred,
    category: richer.category ?? preferred.category ?? "hackathon",
    heldBecause: richer.heldBecause ?? null,
    structuredEvent:
      preferred.structuredEvent ?? fallback.structuredEvent ?? null,
    evidence: richer.evidence,
  });
}

// Hard wall-clock stop. Page budget alone is not enough: one slow source can
// stretch a sweep past the scheduler's timeout, which would kill the run and
// publish nothing at all. Stopping early with partial results is strictly
// better, and the shortfall is reported below.
const sweepDeadline =
  Date.now() + (config.maxSweepMinutes ?? 12) * 60_000;
let stoppedOnTime = false;

try {
  while (queue.length && visited.size < config.maxPagesPerSweep) {
    if (Date.now() > sweepDeadline) {
      stoppedOnTime = true;
      break;
    }
    const current = queue.shift();
    const url = canonicalize(
      current.url,
      current.url,
      current.allowExternal,
    );
    if (!url || visited.has(url)) continue;
    visited.add(url);
    if (!isLumaUrl(url)) externalPagesVisited += 1;

    const isIndexSource = isCuratedIndex(url);
    try {
      // Curated boards are client-rendered apps; they need real settle time
      // before their event links exist in the DOM.
      const result = await extractPage(
        page,
        url,
        needsSlowRender(url) || current.spa
          ? { settleMs: 3_500, timeoutMs: 25_000, scrollPasses: 6 }
          : isBrowseSurface(url)
            ? { settleMs: 1_200, timeoutMs: 20_000, scrollPasses: 6 }
            : {},
      );
      const title = result.title.replace(/\s*[·|]\s*Luma\s*$/i, "").trim();
      const score = scorePage(title, result.bodyText);
      const isPastEvent = /\bPast Event\b|ended \d+ days ago|\b\d+ Went\b/i.test(
        result.bodyText.slice(0, 1100),
      );
      const featuredPlace = result.bodyText
        .slice(0, 700)
        .match(/Featured in\s+([^\n]+)/i)?.[1];
      const localHeaderEvidence = featuredPlace
        ? locationPattern.test(featuredPlace)
        : locationPattern.test(result.bodyText.slice(0, 700));
      score.signals.sfBayAreaEvidence = localHeaderEvidence;
      // Luma's own browse surfaces are inventories, never events. Match the
       // path as well as the title: "AI Events in San Francisco" reads like an
       // event name but is a directory page.
      const looksLikeCollection =
        /events?\s+(calendar|in|near)\b|popular events|events$/i.test(title) ||
        new URL(url).pathname.startsWith("/discover");
      const looksLikeProfile = new URL(url).pathname.startsWith("/user/");
      // A hackathon term in the title is the strongest single signal, because
      // body text routinely mentions other events' hackathons.
      const directTitleTerm = candidatePattern.test(title);
      const formatMismatch =
        negativeTitlePattern.test(title) && !directTitleTerm;
      const weakCompetition =
        !score.signals.competitionEvidence && !directTitleTerm;
      const baseQualifies =
        score.confidence >= 54 &&
        localHeaderEvidence &&
        !looksLikeCollection &&
        !looksLikeProfile &&
        !isIndexSource &&
        !isPastEvent;
      const isEventCandidate =
        baseQualifies && !formatMismatch && !weakCompetition;

      const record = (category) => ({
        url,
        title,
        category,
        discoveredVia: current.via,
        ...score,
        // Event pages run 3-6.5k characters and organisers put the prize list
        // near the bottom, so a 2k cap was cutting off the very details the
        // normalizer looks for: Better Days' $500/$300/$250 prizes were all
        // past the old limit.
        evidence: result.bodyText.slice(0, 8000),
        checkedAt: new Date().toISOString(),
      });

      if (isEventCandidate) {
        recordCandidate(record("hackathon"));
      } else if (baseQualifies) {
        // A local build-adjacent event: pitch night, demo day, robot night.
        // Published as its own category rather than dropped, so coverage stays
        // broad while the hackathon ranking stays honest about what it is.
        const adjacent = record("adjacent");
        adjacent.heldBecause = formatMismatch
          ? "title names a non-hackathon format"
          : "no competition or submission evidence";
        recordCandidate(adjacent);
        review.set(url, adjacent);
      }

      const sourceLocal = locationPattern.test(
        `${title}\n${result.bodyText.slice(0, 900)}`,
      );
      const localIndexSource =
        /^https:\/\/luma\.com\/discover\/sf(?:\/|$)/.test(url) ||
        url === "https://luma.com/hackathon_collections";
      for (const structuredEvent of result.structuredEvents) {
        structuredEventsFound += 1;
        const eventUrl = canonicalize(structuredEvent.url, url, true);
        if (!eventUrl || !structuredEvent.name) continue;
        const evidence = structuredEvidence(structuredEvent);
        const structuredScore = scorePage(structuredEvent.name, evidence);
        const structuredPlace = [
          structuredEvent.location?.city,
          structuredEvent.location?.region,
        ]
          .filter(Boolean)
          .join(", ");
        const structuredLocal = structuredEvent.location?.city
          ? locationPattern.test(structuredPlace)
          : locationPattern.test(evidence) || (localIndexSource && sourceLocal);
        structuredScore.signals.sfBayAreaEvidence = structuredLocal;
        const endTime = Date.parse(
          structuredEvent.endDate || structuredEvent.startDate || "",
        );
        const isPastStructuredEvent =
          Number.isFinite(endTime) && endTime < Date.now();

        // A curated hackathon board has already done human filtering, so visit
        // everything it lists and let the full page decide. Judging these from
        // listing metadata alone is what previously lost real hackathons whose
        // names our vocabulary did not know.
        if (
          isIndexSource &&
          !isPastStructuredEvent &&
          current.depth < config.maxGraphDepth
        ) {
          queue.unshift({
            url: eventUrl,
            depth: current.depth + 1,
            via: url,
            allowExternal: !isLumaUrl(eventUrl),
            spa: !isLumaUrl(eventUrl),
          });
        }

        if (
          structuredScore.confidence < 54 ||
          !structuredLocal ||
          isPastStructuredEvent
        ) {
          continue;
        }
        // Structured listings get the same format gate as visited pages;
        // otherwise a calendar's JSON-LD would republish what the page-level
        // check just held back.
        const structuredRecord = {
          url: eventUrl,
          title: structuredEvent.name,
          category: "hackathon",
          discoveredVia: url,
          ...structuredScore,
          evidence: evidence.slice(0, 8000),
          structuredEvent,
          checkedAt: new Date().toISOString(),
        };
        const structuredDirectTitleTerm = candidatePattern.test(
          structuredEvent.name,
        );
        if (
          negativeTitlePattern.test(structuredEvent.name) &&
          !structuredDirectTitleTerm
        ) {
          const adjacent = {
            ...structuredRecord,
            category: "adjacent",
            heldBecause: "title names a non-hackathon format",
          };
          recordCandidate(adjacent);
          review.set(eventUrl, adjacent);
          continue;
        }
        if (
          !structuredScore.signals.competitionEvidence &&
          !structuredDirectTitleTerm
        ) {
          const adjacent = {
            ...structuredRecord,
            category: "adjacent",
            heldBecause: "no competition or submission evidence",
          };
          recordCandidate(adjacent);
          review.set(eventUrl, adjacent);
          continue;
        }
        recordCandidate(structuredRecord);

        // Listing metadata carries no registration status, venue or prize
        // detail, so anything we intend to publish gets its real page fetched.
        // recordCandidate keeps the richer evidence, so the visit upgrades this
        // record rather than competing with it. Queued at max depth: worth
        // visiting however deep the listing was found, but never expanded
        // further, so this cannot widen the crawl.
        queue.unshift({
          url: eventUrl,
          depth: config.maxGraphDepth,
          via: url,
          allowExternal: !isLumaUrl(eventUrl),
          spa: !isLumaUrl(eventUrl),
        });
      }

      if (current.depth >= config.maxGraphDepth) continue;
      if (!isLumaUrl(url) && !isIndexSource) continue;
      for (const link of result.links) {
        const directCandidateLink = candidatePattern.test(link.text);
        // Index sources are followed for their Luma links only. Crawling a
        // board's own client-rendered event pages costs ~25s each and blew the
        // sweep past its CI budget for one extra event, so those are left to a
        // future board-specific parser.
        const next = canonicalize(
          link.href,
          url,
          directCandidateLink && !isIndexSource,
        );
        if (!next || visited.has(next)) continue;
        // Profile pages are never publishable and are slow to render, so they
        // waste both page budget and wall-clock.
        if (new URL(next).pathname.startsWith("/user/")) continue;
        const curatedLink = isIndexSource && isLumaUrl(next);
        // A browse surface is an inventory: take every event permalink on it,
        // not just the ones whose link text happens to use a word we know.
        // These go behind everything else, so they use leftover budget only.
        const browseListing =
          isBrowseSurface(url) &&
          isLumaUrl(next) &&
          /^\/[a-z0-9][a-z0-9._-]{2,}$/i.test(new URL(next).pathname) &&
          !isBrowseSurface(next);
        const genericNavigation =
          /^(discover events?|sign in|pricing|help|get the app|report event|contact the host|tech|ai|crypto|san francisco)$/i.test(
            link.text,
          );
        const graphLink =
          isEventCandidate && link.text.length > 1 && !genericNavigation;
        if (directCandidateLink || graphLink || curatedLink || browseListing) {
          const item = {
            url: next,
            // A browse listing is a leaf: classify it, never crawl outward from
            // it, or one directory page would pull in the whole site.
            depth: browseListing ? config.maxGraphDepth : current.depth + 1,
            via: url,
            allowExternal: !isLumaUrl(next),
          };
          if (directCandidateLink || curatedLink) {
            queue.unshift(item);
          } else {
            queue.push(item);
          }
        }
      }
    } catch (error) {
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await page.close();
  await context.close();
  await browser.close();
  processHandle.stdout.destroy();
  processHandle.stderr.destroy();
  processHandle.kill();
}

const output = {
  sweep: {
    city: config.city,
    startedFrom: config.seedUrls.length,
    personalizedSeeds: personalizedSeeds.length,
    personalizedPromising: personalizedSeeds.filter((e) => e.promising).length,
    searchSeeds: searchSeeds.length,
    apiCalendarSeeds: apiCalendarSeeds.length,
    linkedinSeeds: linkedinSeeds.length,
    linkedinPromising: linkedinSeeds.filter((e) => e.promising).length,
    pagesVisited: visited.size,
    externalPagesVisited,
    structuredEventsFound,
    candidatesFound: candidates.size,
    heldForReview: review.size,
    stoppedOnTimeBudget: stoppedOnTime,
    queueRemaining: queue.length,
    completedAt: new Date().toISOString(),
  },
  candidates: [...candidates.values()].sort(
    (a, b) => b.relevance - a.relevance,
  ),
  errors,
};

const outputPath = resolve(root, "data/discovery-output.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

// Borderline finds are recorded rather than discarded, so tightening a format
// rule never means quietly losing an event.
await writeFile(
  resolve(root, "data/review-queue.json"),
  `${JSON.stringify(
    {
      sweepCompletedAt: output.sweep.completedAt,
      note: "Local build-ish events held back by a format check. Promote by adding the title's format word to candidateTerms, or ignore.",
      held: [...review.values()]
        // A page that qualified through any path is published, not held.
        .filter(
          (entry) =>
            ![...candidates.values()].some(
              (candidate) => candidate.url === entry.url,
            ),
        )
        .sort((a, b) => b.relevance - a.relevance)
        .map(({ url, title, heldBecause, relevance, confidence }) => ({
          url,
          title,
          heldBecause,
          relevance,
          confidence,
        })),
    },
    null,
    2,
  )}\n`,
);

console.log(
  `SF sweep complete: ${output.sweep.pagesVisited} pages, ` +
    `${output.sweep.candidatesFound} candidates, ${review.size} held for review.`,
);
if (stoppedOnTime) {
  console.warn(
    `Stopped on the ${config.maxSweepMinutes ?? 12}-minute time budget with ` +
      `${queue.length} page(s) unvisited. Coverage this sweep is partial.`,
  );
}
