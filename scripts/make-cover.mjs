// Renders the calendar cover / social preview from live data, so the numbers on
// it are never stale. Uses the same palette and type treatment as the site: the
// image and the page should read as one thing.
//
// 1.91:1 is what Luma asks for. Rendered at 2x for retina, which also survives
// being downscaled to a small link preview.
//
// Usage: node scripts/make-cover.mjs
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const WIDTH = 1200;
const HEIGHT = 628; // 1.91:1
const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const { meta, events } = JSON.parse(
  await readFile(resolve(root, "data/events.json"), "utf8"),
);
const withPrizes = events.filter((event) => /\$/.test(event.prize ?? "")).length;

// Three real upcoming hackathons, because a cover that shows actual events
// proves the calendar is live in a way a tagline cannot.
const now = Date.now();
const upcoming = events
  // Still to come, not merely later in the list: an event that finished this
  // morning has no business being advertised as upcoming.
  .filter(
    (event) =>
      event.category === "hackathon" &&
      event.start &&
      new Date(event.end ?? event.start).getTime() > now,
  )
  .sort((a, b) => a.start.localeCompare(b.start))
  .slice(0, 3)
  .map((event) => ({
    date: event.dateLabel,
    // Cut at a word boundary. Mid-word stumps like "& Token Econom" look like
    // a rendering fault rather than an abbreviation.
    title: truncateWords(event.title.replace(/^[^\p{L}\p{N}]+/u, ""), 34),
  }));

function truncateWords(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s(,:&-]+$/, "")}…`;
}

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    background: #f2efe6;
    color: #141414;
    font-family: "Helvetica Neue", Arial, sans-serif;
    display: grid;
    grid-template-rows: auto 1fr auto;
    position: relative;
    overflow: hidden;
  }
  body::before {
    content: "";
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, rgba(20,20,20,.06) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(20,20,20,.06) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  /* Kept clear of the type: a corner accent, not an obstacle. */
  .acid {
    position: absolute;
    top: -190px; right: -190px;
    width: 380px; height: 380px;
    background: #d9ff43;
    transform: rotate(45deg);
  }
  header {
    position: relative;
    display: flex; align-items: center; gap: 14px;
    padding: 44px 60px 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 16px; font-weight: 700; letter-spacing: .17em;
  }
  .mark {
    display: inline-grid; place-items: center;
    width: 34px; height: 34px;
    background: #141414; color: #f2efe6;
    font-size: 14px; font-weight: 900; letter-spacing: -.08em;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #ff5a36; }
  main {
    position: relative;
    padding: 0 60px;
    display: flex; flex-direction: column; justify-content: center; gap: 30px;
  }
  h1 {
    font-size: 84px;
    line-height: .88;
    letter-spacing: -.05em;
    text-transform: uppercase;
    font-weight: 900;
    max-width: 15ch;
  }
  h1 em {
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic; font-weight: 400;
    text-transform: none; letter-spacing: -.02em;
    color: #ff5a36;
  }
  .next { display: flex; gap: 12px; }
  .next div {
    border: 1.5px solid #141414;
    background: rgba(255,255,255,.5);
    padding: 11px 14px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px; line-height: 1.5;
    max-width: 250px;
  }
  .next b { display: block; font-size: 14px; letter-spacing: .06em; }
  .next span { color: #5d5b55; }
  footer {
    position: relative;
    background: #141414; color: #f2efe6;
    display: flex; align-items: center; justify-content: space-between;
    padding: 24px 60px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .stats { display: flex; gap: 44px; }
  .stat b { display: block; font-size: 38px; letter-spacing: -.04em; }
  .stat span { font-size: 12px; letter-spacing: .13em; color: #9a9a94; text-transform: uppercase; }
  .stat b.hi { color: #d9ff43; }
  .feed { text-align: right; font-size: 13px; line-height: 1.8; letter-spacing: .04em; }
  .feed span { color: #9a9a94; }
</style>
<body>
  <div class="acid"></div>
  <header>
    <span class="mark">H/</span> HACKLIST SF
    <i class="dot"></i> SF BAY AREA &middot; UPDATED TWICE DAILY
  </header>
  <main>
    <h1>Every hackathon.<br><em>Ranked by signal.</em></h1>
    <div class="next">
      ${upcoming
        .map((e) => `<div><b>${e.date}</b><span>${e.title}</span></div>`)
        .join("")}
    </div>
  </main>
  <footer>
    <div class="stats">
      <div class="stat"><b class="hi">${meta.hackathonCount}</b><span>Hackathons</span></div>
      <div class="stat"><b>${withPrizes}</b><span>With prizes</span></div>
      <div class="stat"><b>${meta.adjacentCount}</b><span>Tech events</span></div>
    </div>
    <div class="feed"><span>Subscribe once, never search again</span><br>hacklist-sf &middot; calendar.ics</div>
  </footer>
</body>`;

const htmlPath = resolve(root, "public/cover.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch({ executablePath: CHROME_MAC });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  const out = resolve(root, "public/calendar-cover.png");
  await page.screenshot({ path: out });
  console.log(
    `Wrote ${out} at ${WIDTH * 2}x${HEIGHT * 2} (1.91:1)\n` +
      `  ${meta.hackathonCount} hackathons, ${withPrizes} with prizes, ${meta.adjacentCount} tech events`,
  );
} finally {
  await browser.close();
}
