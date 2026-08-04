// Calendar avatar: the Golden Gate as pixel art.
//
// Drawn on a deliberately coarse 12x12 grid. Luma shows this around 40-64px, so
// each cell has to land on roughly 4 real pixels — any finer and the towers turn
// to mush, which is exactly what killed the earlier dither mark.
//
// Usage: node scripts/make-avatar.mjs
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const SIZE = 480;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// One tower, not the whole span. The Golden Gate's identity is the tapering
// twin-upright tower and the cable sweeping away from it; two tiny towers on a
// coarse grid just read as a fence. Cropping to one tower buys the scale to
// show both, and it survives 48px.
// o = structure, ~ = bay, . = sky
const ART = [
  ".............",
  ".....o.o.....",
  ".....ooo.....",
  ".....o.o.....",
  "..o..ooo..o..",
  ".o...o.o...o.",
  "o....o.o....o",
  "ooooooooooooo",
  ".....o.o.....",
  ".....o.o.....",
  ".~~~~~~~~~~~.",
  ".~~~~~~~~~~~.",
  ".............",
];

const GRID = ART.length;
const cell = SIZE / GRID;
// International orange, the bridge's actual colour.
const ORANGE = "#c0362c";
const ORANGE_LIT = "#d9502f";
const BAY = "#1d2a33";

const rects = ART.flatMap((row, y) =>
  [...row].map((glyph, x) => {
    if (glyph === ".") return "";
    const fill =
      glyph === "~" ? BAY : y <= 2 ? ORANGE_LIT : ORANGE;
    // Full-bleed cells: pixel art wants hard edges, not gaps.
    return `<rect x="${x * cell}" y="${y * cell}" width="${cell + 0.5}" height="${cell + 0.5}" fill="${fill}"/>`;
  }),
).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${SIZE}px;height:${SIZE}px}
  body{
    position:relative;overflow:hidden;
    /* Dusk sky, and the site's scanline grain over the top. */
    background:
      repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px),
      linear-gradient(178deg,#2c2a3a 0%,#3b3547 34%,#5b4348 62%,#7a4c38 100%);
  }
  svg{position:absolute;inset:0;shape-rendering:crispEdges}
</style><body><svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${rects}</svg></body>`;

const htmlPath = resolve(root, "public/avatar.html");
await writeFile(htmlPath, html);
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(root, "public/calendar-avatar.png") });

  // The proof that matters: what a 48px list item actually shows.
  const small = await browser.newPage({ viewport: { width: 48, height: 48 } });
  await small.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await small.addStyleTag({
    content: "html,body{width:48px;height:48px}svg{width:48px;height:48px}",
  });
  await small.waitForTimeout(300);
  await small.screenshot({ path: resolve(root, "public/avatar-48.png") });
  console.log(`Wrote public/calendar-avatar.png at ${SIZE * 2}px, plus a 48px proof`);
} finally {
  await browser.close();
}
