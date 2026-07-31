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
const locationPattern = new RegExp(
  `\\b(${config.placeTerms.map(escapePattern).join("|")})\\b`,
  "i",
);

function canonicalize(raw, base) {
  try {
    const url = new URL(raw, base);
    if (!["luma.com", "lu.ma"].includes(url.hostname)) return null;
    url.hostname = "luma.com";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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

async function extractPage(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8_000 });
  } catch (error) {
    if (!String(error).includes("OperationTimedout")) throw error;
  }
  await page.waitForTimeout(350);

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
    return { title: document.title, bodyText, links };
  });
}

const host = "127.0.0.1";
const port = 9222;
const processHandle = await lightpanda.serve({ host, port });
const browser = await chromium.connectOverCDP(`ws://${host}:${port}`);
const context = await browser.newContext();
const page = await context.newPage();

const queue = config.seedUrls.map((url) => ({ url, depth: 0, via: "seed" }));
const visited = new Set();
const candidates = new Map();
const errors = [];

try {
  while (queue.length && visited.size < config.maxPagesPerSweep) {
    const current = queue.shift();
    const url = canonicalize(current.url, current.url);
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const result = await extractPage(page, url);
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
      const isEventCandidate =
        score.confidence >= 54 &&
        localHeaderEvidence &&
        !looksLikeCollection &&
        !looksLikeProfile &&
        !isPastEvent;

      if (isEventCandidate) {
        const eventKey = title
          .toLowerCase()
          .replace(/\s*-\s*open registration\s*$/i, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        const candidate = {
          url,
          title,
          discoveredVia: current.via,
          ...score,
          evidence: result.bodyText.slice(0, 1200),
          checkedAt: new Date().toISOString(),
        };
        const existing = candidates.get(eventKey);
        if (!existing || candidate.relevance > existing.relevance) {
          candidates.set(eventKey, candidate);
        }
      }

      if (current.depth >= config.maxGraphDepth) continue;
      for (const link of result.links) {
        const next = canonicalize(link.href, url);
        if (!next || visited.has(next)) continue;
        const directCandidateLink = candidatePattern.test(link.text);
        const genericNavigation =
          /^(discover events?|sign in|pricing|help|get the app|report event|contact the host|tech|ai|crypto|san francisco)$/i.test(
            link.text,
          );
        const graphLink =
          isEventCandidate && link.text.length > 1 && !genericNavigation;
        if (directCandidateLink || graphLink) {
          const item = {
            url: next,
            depth: current.depth + 1,
            via: url,
          };
          if (directCandidateLink) {
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
    pagesVisited: visited.size,
    candidatesFound: candidates.size,
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
console.log(
  `SF sweep complete: ${output.sweep.pagesVisited} pages, ${output.sweep.candidatesFound} candidates.`,
);
