// Meetup hackathons, from its own search page.
//
// See scripts/lib/search-page-events.mjs for why these two sources exist and how
// they are filtered. This file is only the queries and the bookkeeping.
//
// Never exits non-zero for a source problem.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPatterns, localCitySet } from "./lib/candidate-score.mjs";
import { createPacer } from "./lib/page-http.mjs";
import { searchPageCandidates } from "./lib/search-page-events.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const patterns = buildPatterns(config);
const localCities = localCitySet(config);
const outputPath = resolve(root, "data/meetup-candidates.json");
const pace = createPacer(1_200);
const SOURCE = "meetup";
const QUERIES = config.meetupQueries ?? [];

const problems = [];
const byUrl = new Map();
const skipped = { past: 0, online: 0, notLocal: 0, notHackathon: 0, recurring: 0 };

for (const query of QUERIES) {
  try {
    await pace();
    const result = await searchPageCandidates({
      url: query,
      source: SOURCE,
      config,
      localCities,
      patterns,
    });
    for (const candidate of result.candidates) {
      // A hackathon listed under two city queries is one hackathon.
      if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate);
    }
    for (const [key, value] of Object.entries(result.skipped)) {
      skipped[key] += value;
    }
  } catch (error) {
    problems.push({ query, error: String(error).slice(0, 160) });
  }
}

const candidates = [...byUrl.values()].sort((a, b) => b.relevance - a.relevance);
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: SOURCE,
      queries: QUERIES,
      skipped,
      problems,
      note:
        "Meetup search pages, read anonymously. They server-render schema.org " +
        "Events with a postal address and a description. Names that say the event " +
        "repeats are recorded as adjacent rather than published as hackathons.",
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `${SOURCE} discovery: ${candidates.length} candidate(s) from ${QUERIES.length} query(s) ` +
    `(${skipped.notLocal} not local, ${skipped.notHackathon} not a hackathon, ` +
    `${skipped.past} outside the window, ${skipped.online} online, ` +
    `${skipped.recurring} recurring)` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
