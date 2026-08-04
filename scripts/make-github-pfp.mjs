// GitHub profile picture: the Chrome dino under a night sky, on deep teal.
//
// Sprite is the real Chromium asset via scripts/lib/dino-sprites.mjs, not a
// hand-trace. Square, and composed so the dino still reads at the ~40px GitHub
// shows in comment threads.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";
import { DINO } from "./lib/dino-sprites.mjs";

const SIZE = 500;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CELL = 5; // dino lands at ~44% of the frame, leaving sky and margin
const cols = Math.ceil(SIZE / CELL);
const rows = Math.ceil(SIZE / CELL);
const GROUND = rows - 18;
const INK = "#eafaf7";
const DIM = "rgba(234,250,247,.5)";

// Deterministic star field: a profile picture should not reshuffle each build.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seeded(8032026);

const rects = [];
const cellAt = (x, y, fill) =>
  rects.push(
    `<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`,
  );

// Stars, as the game draws them: single cells, denser high in the frame.
for (let y = 1; y < GROUND - 8; y++) {
  for (let x = 0; x < cols; x++) {
    if (rand() < 0.012 + (1 - y / GROUND) * 0.02) {
      cellAt(x, y, rand() > 0.45 ? INK : DIM);
    }
  }
}

// The dino, centred and standing on the ground line.
const dinoW = DINO[0].length;
const ox = Math.round((cols - dinoW) / 2);
const oy = GROUND - DINO.length;
DINO.forEach((row, y) =>
  [...row].forEach((glyph, x) => {
    if (glyph === "#") cellAt(ox + x, oy + y, INK);
  }),
);

// Ground line plus the game's scattered pebbles.
for (let x = 0; x < cols; x++) {
  cellAt(x, GROUND, INK);
  if ((x * 7 + 2) % 9 === 0) cellAt(x, GROUND + 3, DIM);
  if ((x * 5 + 4) % 13 === 0) cellAt(x, GROUND + 6, DIM);
}

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${SIZE}px;height:${SIZE}px}
  body{position:relative;overflow:hidden;background:
    radial-gradient(85% 70% at 50% 88%, rgba(18,120,116,.55) 0%, transparent 60%),
    linear-gradient(168deg,#0a2b33 0%,#0c3a40 46%,#07242b 100%);}
  svg{position:absolute;inset:0;shape-rendering:crispEdges}
</style><body><svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${rects.join("")}</svg></body>`;

const htmlPath = resolve(root, "public/pfp.html");
await writeFile(htmlPath, html);
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(root, "public/github-pfp.png") });
  console.log(`Wrote public/github-pfp.png at ${SIZE * 2}x${SIZE * 2}`);
} finally {
  await browser.close();
}
