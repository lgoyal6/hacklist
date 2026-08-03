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
const candidatePattern = new RegExp(
  `\\b(${config.candidateTerms.map(escapePattern).join("|")})\\b`,
  "i",
);
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
  /\b(meet[-\s]?ups?|conference|summit|webinar|expo|mixer|happy hour|fireside|panel|screening|dinner|networking|workshop|office hours|pitch night|demo night|launch party|party|social|talk|talks|showcase|open house)\b/i;
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
// classify. Their Luma links are followed even when the link text uses a name
// our candidate vocabulary would not recognize.
function isExternalIndexUrl(url) {
  return (config.externalIndexUrls ?? []).includes(url);
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

async function extractPage(page, url, { settleMs = 350, timeoutMs = 12_000 } = {}) {
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
  personalizedSeeds = (personalized.urls ?? []).map((entry) => entry.url);
} catch {
  // Optional input; absent until the local pass has run.
}

const queue = [
  ...config.seedUrls.map((url) => ({
    url,
    depth: 0,
    via: "seed",
    allowExternal: !["luma.com", "lu.ma"].includes(new URL(url).hostname),
  })),
  ...personalizedSeeds.map((url) => ({
    url,
    depth: 1, // already an event page; do not expand a graph from it
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
  candidates.set(key, {
    ...preferred,
    structuredEvent:
      preferred.structuredEvent ?? fallback.structuredEvent ?? null,
    evidence:
      preferred.evidence.length >= fallback.evidence.length
        ? preferred.evidence
        : fallback.evidence,
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

    const isIndexSource = isExternalIndexUrl(url);
    try {
      // Curated boards are client-rendered apps; they need real settle time
      // before their event links exist in the DOM.
      const result = await extractPage(
        page,
        url,
        isIndexSource ? { settleMs: 3_500, timeoutMs: 25_000 } : {},
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
      const looksLikeCollection =
        /events calendar|tech events in|popular events in|events$/i.test(title);
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

      const record = () => ({
        url,
        title,
        discoveredVia: current.via,
        ...score,
        evidence: result.bodyText.slice(0, 2000),
        checkedAt: new Date().toISOString(),
      });

      if (isEventCandidate) {
        recordCandidate(record());
      } else if (baseQualifies) {
        // Looked like a local build event but failed a format check. Surface it
        // for a human instead of dropping it silently.
        review.set(url, {
          ...record(),
          heldBecause: formatMismatch
            ? "title names a non-hackathon format"
            : "no competition or submission evidence",
        });
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
          discoveredVia: url,
          ...structuredScore,
          evidence: evidence.slice(0, 2000),
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
          review.set(eventUrl, {
            ...structuredRecord,
            heldBecause: "title names a non-hackathon format",
          });
          continue;
        }
        if (
          !structuredScore.signals.competitionEvidence &&
          !structuredDirectTitleTerm
        ) {
          review.set(eventUrl, {
            ...structuredRecord,
            heldBecause: "no competition or submission evidence",
          });
          continue;
        }
        recordCandidate(structuredRecord);

        if (!isLumaUrl(eventUrl) && current.depth < config.maxGraphDepth) {
          queue.unshift({
            url: eventUrl,
            depth: current.depth + 1,
            via: url,
            allowExternal: true,
          });
        }
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
        const genericNavigation =
          /^(discover events?|sign in|pricing|help|get the app|report event|contact the host|tech|ai|crypto|san francisco)$/i.test(
            link.text,
          );
        const graphLink =
          isEventCandidate && link.text.length > 1 && !genericNavigation;
        if (directCandidateLink || graphLink || curatedLink) {
          const item = {
            url: next,
            depth: current.depth + 1,
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
