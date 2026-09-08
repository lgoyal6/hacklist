// The whole reader journey, in both languages, at both widths.
//
// Rendered-output tests prove the words; this proves the product: on the
// English and the Spanish board, on a laptop and on a phone, a reader can
// search, filter, reach an event page, copy the feed, and download the
// calendar - and gets the identical calendar bytes whichever language they
// came from. Served the way the production worker is served, with the client
// bundle on disk, so the page actually hydrates.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

const eventsData = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);
const catalogs = {
  en: JSON.parse(
    await readFile(new URL("../app/i18n/en.json", import.meta.url), "utf8"),
  ),
  es: JSON.parse(
    await readFile(new URL("../app/i18n/es.json", import.meta.url), "utf8"),
  ),
};

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter(Boolean);
// Resolved at module load: node:test evaluates a test's options when the test
// is registered, which happens before any hook runs.
const executablePath = CHROME.find((path) => existsSync(path));
const skipUnlessBrowser = executablePath
  ? {}
  : { skip: "no Chrome found; set CHROME_PATH to run these" };

const CONTENT_TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let server;
let browser;
let origin;

before(async () => {
  const clientDir = new URL("../dist/client/", import.meta.url);
  const assets = {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, "");
      try {
        const body = await readFile(new URL(path, clientDir));
        return new Response(body, {
          headers: {
            "content-type":
              CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("browser", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  server = createServer(async (request, response) => {
    const url = `http://127.0.0.1:${server.address().port}${request.url}`;
    let served = await assets.fetch(new Request(url));
    if (served.status === 404) {
      served = await worker.fetch(
        new Request(url, {
          headers: { accept: request.headers.accept ?? "text/html" },
        }),
        { ASSETS: assets },
        { waitUntil() {}, passThroughOnException() {} },
      );
    }
    response.writeHead(served.status, Object.fromEntries(served.headers));
    response.end(Buffer.from(await served.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  if (!executablePath) return; // tests below skip themselves
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
});

const JOURNEYS = [
  { locale: "en", path: "/", width: "desktop", viewport: { width: 1280, height: 800 } },
  { locale: "en", path: "/", width: "mobile", viewport: { width: 390, height: 844 } },
  { locale: "es", path: "/es", width: "desktop", viewport: { width: 1280, height: 800 } },
  { locale: "es", path: "/es", width: "mobile", viewport: { width: 390, height: 844 } },
];

// The calendar each journey downloads, keyed by locale, compared at the end:
// the same region's feed must be the same bytes whichever board asked.
const downloaded = new Map();

for (const journey of JOURNEYS) {
  const messages = catalogs[journey.locale];
  test(
    `a ${journey.locale} reader on ${journey.width} can search, filter, reach an event, subscribe and download`,
    skipUnlessBrowser,
    async () => {
      const context = await browser.newContext({
        viewport: journey.viewport,
        locale: journey.locale,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`${origin}${journey.path}`, { waitUntil: "networkidle" });

      // The page states its language and shows this locale's chrome.
      assert.equal(
        await page.evaluate(() => document.documentElement.lang),
        journey.locale,
      );
      assert.equal(
        await page.locator(".subscribe-copy h2").textContent(),
        messages["subscribe.title"],
      );

      // Search: a query that matches nothing announces zero and the localized
      // empty state; clearing it brings the board back.
      const search = page.getByLabel(messages["listing.searchAria"]);
      await search.fill("zzz-nothing-matches-this");
      await page
        .locator(".count")
        .filter({ hasText: messages["listing.shown.other"].replace("{count}", "0") })
        .waitFor();
      assert.equal(
        (await page.locator(".empty").textContent())?.trim(),
        messages["empty.noMatch"],
      );
      await search.fill("");

      // Filter: switching views moves aria-pressed, the state a screen reader
      // and these tests share.
      const everything = page.getByRole("button", {
        name: messages["views.everything"],
        exact: true,
      });
      await everything.click();
      assert.equal(await everything.getAttribute("aria-pressed"), "true");
      const shownAfterFilter = await page.locator(".events li .event").count();
      assert.ok(shownAfterFilter > 0, "the Everything view shows no events");

      // Event detail: the first listing links straight to the organizer's page
      // in a new tab, title verbatim from the data whatever the UI language.
      const firstLink = page.locator(".events .event-body h4 a").first();
      const href = await firstLink.getAttribute("href");
      assert.match(href ?? "", /^https:\/\//);
      assert.equal(await firstLink.getAttribute("target"), "_blank");
      const title = (await firstLink.textContent())?.trim();
      assert.ok(
        eventsData.events.some((event) => event.title === title),
        `"${title}" is not an event title from the data - was it translated?`,
      );

      // Subscribe: the copy button confirms in this locale's words, in the
      // visible label and the announced name both (WCAG 2.5.3 in each language).
      const copy = page.locator(".feed button").first();
      assert.equal(
        (await copy.textContent())?.trim(),
        messages["subscribe.copy"],
      );
      await copy.click();
      await page.waitForFunction(
        (copied) =>
          document.querySelector(".feed button")?.textContent === copied,
        messages["subscribe.copied"],
        { timeout: 5000 },
      );
      const announced = await copy.getAttribute("aria-label");
      assert.equal(announced, messages["subscribe.copiedAria"]);
      assert.ok(
        announced
          .toLowerCase()
          .includes(messages["subscribe.copied"].toLowerCase()),
        `the announced name ${JSON.stringify(announced)} does not contain the visible label`,
      );
      const copiedUrl = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      assert.equal(copiedUrl, `${origin}/calendar.ics`);

      // Calendar download: the download link serves a real calendar, and its
      // bytes are recorded to prove both languages hand out the same feed.
      const downloadHref = await page
        .getByRole("link", { name: messages["subscribe.download"] })
        .getAttribute("href");
      assert.equal(downloadHref, "/calendar.ics");
      const feed = await page.request.get(`${origin}${downloadHref}`);
      assert.equal(feed.status(), 200);
      assert.match(feed.headers()["content-type"] ?? "", /^text\/calendar\b/i);
      const ics = await feed.text();
      assert.match(ics, /BEGIN:VCALENDAR/);
      downloaded.set(`${journey.locale}`, ics);

      await context.close();
    },
  );
}

test(
  "both languages downloaded the identical calendar bytes",
  skipUnlessBrowser,
  () => {
    const english = downloaded.get("en");
    const spanish = downloaded.get("es");
    assert.ok(english && spanish, "both journeys must have downloaded the feed");
    // Identity, timestamps, everything: one artifact, two doors to it. (The
    // DTSTAMP is the sweep time, not the request time, so this cannot flake.)
    assert.ok(english === spanish, "the two locales downloaded different calendars");
  },
);
