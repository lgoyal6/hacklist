// Calendar banner: a pale iridescent field seen through a fine pixel grid.
//
// The look is an LCD or holographic foil close up — soft mint, lavender, pink
// and peach clouds bleeding into each other, every cell of the grid filled, the
// whole thing light rather than dark. An earlier attempt read this as bright
// dots scattered on navy, which is close to its opposite.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const WIDTH = 1600;
const HEIGHT = 420;
const CELL = 6; // fine enough to read as a screen, coarse enough to see
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${WIDTH}px;height:${HEIGHT}px}
  body{position:relative;overflow:hidden;background:#161d28}

  /* Two hues only: deep blue and dark ochre. Large, overlapping and blurred so
     they tint the field rather than reading as shapes. */
  .clouds{
    position:absolute;inset:-10%;
    background:
      radial-gradient(40% 64% at 12% 28%, rgba(30,86,150,.95) 0%, transparent 62%),
      radial-gradient(34% 58% at 34% 74%, rgba(20,62,116,.9) 0%, transparent 60%),
      radial-gradient(32% 56% at 54% 26%, rgba(150,112,26,.88) 0%, transparent 62%),
      radial-gradient(36% 62% at 72% 66%, rgba(26,74,132,.92) 0%, transparent 62%),
      radial-gradient(30% 54% at 88% 32%, rgba(168,126,30,.85) 0%, transparent 60%),
      radial-gradient(48% 74% at 46% 52%, rgba(22,54,96,.6) 0%, transparent 72%);
    filter:blur(24px) saturate(135%);
  }

  /* Dark grid, equal weight both directions so the cells read square rather
     than as vertical striping. */
  .grid{
    position:absolute;inset:0;
    background-image:
      repeating-linear-gradient(90deg, rgba(8,12,18,.5) 0 1px, transparent 1px ${CELL}px),
      repeating-linear-gradient(0deg, rgba(8,12,18,.5) 0 1px, transparent 1px ${CELL}px),
      repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px ${CELL * 3}px);
  }

  /* Per-cell chroma. Crossing two gradients at opposite diagonals varies the
     tint cell by cell; a single horizontal gradient striped whole columns and
     made the whole thing read as woven fabric. */
  .shimmer{
    position:absolute;inset:0;
    background:
      repeating-linear-gradient(45deg,
        rgba(60,140,255,.16) 0 ${CELL}px,
        transparent ${CELL}px ${CELL * 2}px),
      repeating-linear-gradient(-45deg,
        rgba(255,200,60,.13) 0 ${CELL}px,
        transparent ${CELL}px ${CELL * 2}px);
    mix-blend-mode:screen;
  }

  /* Vignette instead of a white veil: keeps it dark and stops the edges glowing. */
  .veil{
    position:absolute;inset:0;
    background:radial-gradient(120% 90% at 50% 45%, transparent 40%, rgba(8,11,17,.55) 100%);
  }
</style><body>
  <div class="clouds"></div>
  <div class="grid"></div>
  <div class="shimmer"></div>
  <div class="veil"></div>
</body>`;

const htmlPath = resolve(root, "public/banner.html");
await writeFile(htmlPath, html);
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(root, "public/calendar-banner.png") });
  console.log(`Wrote public/calendar-banner.png at ${WIDTH * 2}x${HEIGHT * 2}`);
} finally {
  await browser.close();
}
