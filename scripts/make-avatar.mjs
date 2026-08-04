// Calendar avatar: just the dino, on the banner's dark red.
//
// Plain on purpose. The bridge version had a fog gradient and a tapering tower
// competing for attention in a 48px square and read as mud. One shape, one
// colour, and it matches the banner so the pair reads as a set.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";
import { DINO } from "./lib/dino-sprites.mjs";

const SIZE = 480;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const INK = "#f2e9e4";

// Fit the sprite to the frame with an even margin, so nothing is cropped.
const SPRITE_W = DINO[0].length;
const SPRITE_H = DINO.length;
const CELL = Math.floor((SIZE * 0.72) / Math.max(SPRITE_W, SPRITE_H));
const ox = Math.round((SIZE - SPRITE_W * CELL) / 2);
const oy = Math.round((SIZE - SPRITE_H * CELL) / 2);

const rects = DINO.flatMap((row, y) =>
  [...row].map((glyph, x) =>
    glyph === "#"
      ? `<rect x="${ox + x * CELL}" y="${oy + y * CELL}" width="${CELL + 0.5}" height="${CELL + 0.5}" fill="${INK}"/>`
      : "",
  ),
).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${SIZE}px;height:${SIZE}px}
  body{position:relative;overflow:hidden;background:
    radial-gradient(90% 90% at 50% 30%, #5c1213 0%, transparent 65%),
    linear-gradient(160deg,#4a0f10 0%,#380c0d 55%,#2a0809 100%);}
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
  const small = await browser.newPage({ viewport: { width: 48, height: 48 } });
  await small.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await small.addStyleTag({ content: "html,body{width:48px;height:48px}svg{width:48px;height:48px}" });
  await small.waitForTimeout(300);
  await small.screenshot({ path: resolve(root, "public/avatar-48.png") });
  console.log(`Wrote public/calendar-avatar.png at ${SIZE * 2}px, plus a 48px proof`);
} finally {
  await browser.close();
}
