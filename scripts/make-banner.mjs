// Calendar banner: the Chrome offline dino, on dark red.
//
// Sprites are hand-mapped pixel art composited onto one grid, the same way the
// game draws them. Cell size is chosen so the dino stands about half the banner
// height, which keeps it readable when Luma scales the image down.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const WIDTH = 1600;
const HEIGHT = 420;
const CELL = 10;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DINO = [
  "..............######",
  ".............#######",
  ".............###.###",
  ".............#######",
  ".............####...",
  "............######..",
  "#...........######..",
  "##.........#######..",
  "###.......########..",
  "####.....#########..",
  "#####...##########..",
  "######.###########..",
  ".##################.",
  "..################..",
  "...##############...",
  "....############....",
  ".....##########.....",
  "......#########.....",
  "......####.####.....",
  "......###...###.....",
  "......##.....##.....",
  "......#.......#.....",
  ".....###.....###....",
];

const CACTUS = [
  "..#..",
  "..#..",
  "#.#..",
  "#.#.#",
  "#.#.#",
  "###.#",
  "..###",
  "..#..",
  "..#..",
  "..#..",
];

const CLOUD = [
  "..####..",
  ".######.",
  "########",
  "..####..",
];

const cols = Math.ceil(WIDTH / CELL);
const rows = Math.ceil(HEIGHT / CELL);
const GROUND_ROW = rows - 8;
const INK = "#f2e9e4";
const INK_DIM = "rgba(242,233,228,.45)";

const rects = [];
const place = (sprite, ox, oy, fill = INK) => {
  sprite.forEach((row, y) =>
    [...row].forEach((glyph, x) => {
      if (glyph !== "#") return;
      rects.push(
        `<rect x="${(ox + x) * CELL}" y="${(oy + y) * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`,
      );
    }),
  );
};

// The dino stands on the ground line, mid-stride.
place(DINO, 12, GROUND_ROW - DINO.length);
// Cacti ahead of it, at the game's uneven spacing.
place(CACTUS, 58, GROUND_ROW - CACTUS.length);
place(CACTUS, 96, GROUND_ROW - CACTUS.length);
place(CACTUS, 132, GROUND_ROW - CACTUS.length);
// Clouds drifting at two heights.
place(CLOUD, 44, 4, INK_DIM);
place(CLOUD, 88, 9, INK_DIM);
place(CLOUD, 124, 3, INK_DIM);

// Ground: a solid line with the game's scattered pebbles under it.
for (let x = 0; x < cols; x++) {
  rects.push(
    `<rect x="${x * CELL}" y="${GROUND_ROW * CELL}" width="${CELL}" height="${CELL}" fill="${INK}"/>`,
  );
  if ((x * 7 + 3) % 11 === 0) {
    rects.push(
      `<rect x="${x * CELL}" y="${(GROUND_ROW + 2) * CELL}" width="${CELL}" height="${CELL}" fill="${INK_DIM}"/>`,
    );
  }
  if ((x * 5 + 1) % 17 === 0) {
    rects.push(
      `<rect x="${x * CELL}" y="${(GROUND_ROW + 4) * CELL}" width="${CELL}" height="${CELL}" fill="${INK_DIM}"/>`,
    );
  }
}

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${WIDTH}px;height:${HEIGHT}px}
  body{position:relative;overflow:hidden;background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.03) 0 1px, transparent 1px 3px),
    radial-gradient(90% 120% at 18% 20%, #6d1616 0%, transparent 62%),
    linear-gradient(160deg,#4a0f10 0%,#380c0d 52%,#280809 100%);}
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
  console.log(`Wrote public/calendar-banner.png at ${WIDTH * 2}x${HEIGHT * 2}`);
} finally {
  await browser.close();
}
