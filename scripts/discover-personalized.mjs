// Personalized discovery pass. Runs LOCALLY ONLY, using the signed-in
// dedicated browser profile, because a real Luma session must never be placed
// in CI. It collects the event URLs Luma shows *this user* (recommendations,
// followed calendars, subscribed hosts) and writes them as extra seeds for the
// anonymous pipeline to crawl and classify normally.
//
// Output (data/personalized-seeds.json) holds public event URLs only — no
// cookies, tokens, or account details — so it is safe to commit.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensureSignedIn,
  eventUrlsFromPage,
  launchLocalBrowser,
  needsHumanAttention,
  root,
} from "./lib/local-browser.mjs";

const SURFACES = [
  { url: "https://luma.com/home", label: "home feed" },
  { url: "https://luma.com/discover", label: "discover" },
  { url: "https://luma.com/discover/sf", label: "discover SF" },
  { url: "https://luma.com/discover/sf/tech", label: "discover SF tech" },
  { url: "https://luma.com/discover/sf/ai", label: "discover SF AI" },
];

const outputPath = resolve(root, "data/personalized-seeds.json");
const headless = process.argv.includes("--headless");

const context = await launchLocalBrowser({ headless });
const found = new Map(); // url -> surfaces that showed it
let attention = null;

try {
  const page = await ensureSignedIn(context);

  for (const surface of SURFACES) {
    try {
      await page.goto(surface.url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      console.warn(`  ${surface.label}: navigation failed, skipping.`);
      continue;
    }
    await page.waitForTimeout(2_500);

    attention = await needsHumanAttention(page);
    if (attention) break;

    // Luma lazy-loads event cards; scroll to pull in more before reading.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1_200);
    }

    const urls = await eventUrlsFromPage(page);
    for (const url of urls) {
      const surfaces = found.get(url) ?? [];
      if (!surfaces.includes(surface.label)) surfaces.push(surface.label);
      found.set(url, surfaces);
    }
    console.log(`  ${surface.label}: ${urls.length} event links`);
  }
} finally {
  await context.close();
}

if (attention) {
  console.error(
    attention === "captcha"
      ? "\nStopped: Luma showed a CAPTCHA. Re-run and solve it in the browser window."
      : "\nStopped: the Luma session signed out. Re-run to sign in again.",
  );
}

// Merge with previous seeds so a partial run never shrinks coverage.
let previous = { urls: [] };
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  // first run
}

const merged = new Map();
for (const entry of previous.urls ?? []) merged.set(entry.url, entry);
for (const [url, surfaces] of found) {
  merged.set(url, {
    url,
    surfaces,
    lastSeenAt: new Date().toISOString(),
  });
}

const urls = [...merged.values()].sort((a, b) => a.url.localeCompare(b.url));
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      surfacesVisited: SURFACES.length,
      note: "Public Luma event URLs surfaced to the signed-in user. No session data.",
      urls,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `\nPersonalized pass: ${found.size} event links this run, ${urls.length} tracked total.` +
    `\nWrote ${outputPath}` +
    `\nRun \`npm run discover:sf\` to crawl and classify them.`,
);

if (attention) process.exit(1);
