// Calendar banner: a field of bright pixel noise, blue and yellow.
//
// Seeded so regenerating gives the same image — a banner that reshuffles every
// time it is built is not a brand asset.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const WIDTH = 1600;
const HEIGHT = 420;
const CELL = 10;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// mulberry32: small, deterministic, good enough for scatter.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seeded(20260803);

const PALETTE = [
  "#2b7cff", // blue
  "#4da3ff", // light blue
  "#ffd21f", // yellow
  "#ffe873", // pale yellow
  "#00e0d5", // cyan, for lift
];

const cols = Math.ceil(WIDTH / CELL);
const rows = Math.ceil(HEIGHT / CELL);
const rects = [];
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    // Denser toward the middle band and toward the left, so it reads as a
    // signal breaking up rather than evenly sprinkled confetti.
    const bandY = 1 - Math.abs(y / rows - 0.5) * 2;
    const density = 0.06 + bandY * 0.3 * (1 - (x / cols) * 0.55);
    if (rand() > density) continue;
    const colour = PALETTE[Math.floor(rand() * PALETTE.length)];
    const opacity = (0.5 + rand() * 0.5).toFixed(2);
    rects.push(
      `<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="${colour}" opacity="${opacity}"/>`,
    );
  }
}

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${WIDTH}px;height:${HEIGHT}px}
  body{position:relative;overflow:hidden;background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px),
    linear-gradient(105deg,#0b1020 0%,#131a2e 46%,#1a1526 100%);}
  svg{position:absolute;inset:0;shape-rendering:crispEdges}
</style><body><svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${rects.join("")}</svg></body>`;

const htmlPath = resolve(root, "public/banner.html");
await writeFile(htmlPath, html);
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(root, "public/calendar-banner.png") });
  console.log(`Wrote public/calendar-banner.png at ${WIDTH * 2}x${HEIGHT * 2} (${rects.length} lit cells)`);
} finally {
  await browser.close();
}
