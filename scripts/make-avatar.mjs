// Calendar avatar. Luma renders it around 40-64px, so this has to be a mark
// with one idea in it: a dither field with a bright cell ring and a single
// accent cell. At small sizes you read "square + coloured dot"; up close the
// grain matches the site's background.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { root } from "./lib/local-browser.mjs";

const SIZE = 512; // rendered at 2x below
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 9x9 field. 2 = accent cell, 1 = bright cell, 0 = faint dot.
// A pixel H rather than a plain ring: same dither language, but it carries the
// name instead of reading like any generic app icon. Two verticals and a
// crossbar survive being shrunk to 40px.
const MARKS = {
  h: [
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 2],
  ],
};
const RING = MARKS.h;

const cell = SIZE / 8;
const cells = RING.flatMap((row, y) =>
  row.map((kind, x) => {
    const cx = x * cell + cell / 2;
    const cy = y * cell + cell / 2;
    if (kind === 0) {
      return `<circle cx="${cx}" cy="${cy}" r="${cell * 0.055}" fill="#f6f4ec" opacity="0.09"/>`;
    }
    const fill = kind === 2 ? "#c2521f" : "#f6f4ec";
    const size = cell * (kind === 2 ? 0.62 : 0.92);
    return `<rect x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" fill="${fill}"/>`;
  }),
).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${SIZE}px;height:${SIZE}px}
  body{position:relative;overflow:hidden;background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0 1px, transparent 1px 3px),
    radial-gradient(90% 70% at 22% 8%, #2b291f 0%, transparent 60%),
    linear-gradient(150deg,#232118 0%,#191813 55%,#12110d 100%);}
  svg{position:absolute;inset:0}
</style><body><svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${cells}</svg></body>`;

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
  const variant = "h";
  const out = resolve(root, `public/calendar-avatar-${variant}.png`);
  await page.screenshot({ path: out });
  // A 48px copy, to check it survives the size Luma actually shows.
  const small = await browser.newPage({ viewport: { width: 48, height: 48 } });
  await small.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await small.addStyleTag({ content: `html,body{width:48px;height:48px}svg{width:48px;height:48px}` });
  await small.waitForTimeout(300);
  await small.screenshot({ path: resolve(root, `public/avatar-48-${variant}.png`) });
  console.log(`Wrote ${out} at ${SIZE * 2}x${SIZE * 2}, plus a 48px proof`);
} finally {
  await browser.close();
}
