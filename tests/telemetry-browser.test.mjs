// What a real browser actually sends, and what a real Worker actually stores.
//
// The schema tests in tests/recommender.test.mjs prove the rules. This proves
// the wiring: a Chrome on the built board, the built Worker behind it with a
// stand-in for the Analytics Engine binding, and the data points read back off
// the sink. A privacy rule that only holds in a unit test is a privacy rule
// nobody has checked.
//
// Deliberately NOT in test:artifact. That gate stands between a correct board
// and its deploy, and a flaky Chrome must never be able to withhold a correct
// board.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

import {
  BLOB_COLUMNS,
  EVENT_FIELDS,
  FEED_EVENT_ID,
  FORBIDDEN_FIELDS,
  fromQueryRow,
} from "../app/telemetry-schema.mjs";

const ranker = JSON.parse(
  await readFile(new URL("../data/ranker.json", import.meta.url), "utf8"),
);

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter(Boolean);
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
/** Everything the stand-in binding was asked to store. */
let stored = [];
/** Every header the endpoint's requests arrived with, so we can prove what was ignored. */
let arrivedWith = [];

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
  workerUrl.searchParams.set("telemetry", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  // Unlike the i18n browser harness, this one forwards the method, the headers
  // and the body: the whole point is a POST reaching the real handler. The
  // headers deliberately include an address and a user-agent, so "the stored
  // row has neither" is a claim about the code and not about the fixture.
  server = createServer(async (request, response) => {
    const url = `http://127.0.0.1:${server.address().port}${request.url}`;
    let served = await assets.fetch(new Request(url));
    if (served.status === 404) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      headers.set("cf-connecting-ip", "203.0.113.7");
      headers.set("x-forwarded-for", "203.0.113.7");
      if (!headers.has("accept")) headers.set("accept", "text/html");
      arrivedWith.push(Object.fromEntries(headers));
      served = await worker.fetch(
        new Request(url, {
          method: request.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }),
        {
          ASSETS: assets,
          EVENTS: {
            writeDataPoint(point) {
              stored.push(point);
            },
          },
        },
        { waitUntil() {}, passThroughOnException() {} },
      );
    }
    response.writeHead(served.status, Object.fromEntries(served.headers));
    response.end(Buffer.from(await served.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  if (!executablePath) return;
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
});

/** The rows the binding was handed, as events again. */
const events = () =>
  stored.map((point) => {
    const row = {};
    point.blobs.forEach((value, i) => {
      row[`blob${i + 1}`] = value;
    });
    point.doubles.forEach((value, i) => {
      row[`double${i + 1}`] = value;
    });
    return fromQueryRow(row);
  });

const settle = async (page) => {
  // The client batches impressions and flushes after the list settles.
  await page.waitForTimeout(1500);
};

test(
  "the board reports what it showed, where it showed it, and nothing about the reader",
  skipUnlessBrowser,
  async () => {
    stored = [];
    arrivedWith = [];
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await settle(page);

    const impressions = events().filter((row) => row.type === "impression");
    const rendered = await page.locator(".events li .event").count();
    assert.ok(rendered > 0, "the board rendered no events");
    assert.equal(
      impressions.length,
      rendered,
      "one impression per rendered row, no more and no fewer",
    );

    // Positions are the ranks actually shown: 0-based, dense, no gaps.
    const positions = impressions.map((row) => row.position).sort((a, b) => a - b);
    assert.deepEqual(
      positions,
      Array.from({ length: rendered }, (unused, index) => index),
    );

    // The address and the user-agent WERE on every request that reached the
    // handler, and are in none of the stored rows.
    assert.ok(
      arrivedWith.some((headers) => headers["cf-connecting-ip"]),
      "the harness never sent an address, so this proves nothing",
    );
    assert.ok(
      arrivedWith.some((headers) => headers["user-agent"]),
      "the harness never sent a user-agent, so this proves nothing",
    );
    const flat = JSON.stringify(stored);
    assert.doesNotMatch(flat, /203\.0\.113\.7/, "an address was stored");
    assert.doesNotMatch(flat, /Mozilla|Chrome\//, "a user-agent was stored");
    assert.doesNotMatch(flat, /@/, "something email-shaped was stored");
    for (const row of events()) {
      assert.deepEqual(Object.keys(row).sort(), [...EVENT_FIELDS].sort());
      for (const forbidden of FORBIDDEN_FIELDS) {
        assert.ok(!(forbidden in row), `${forbidden} reached the sink`);
      }
    }

    // 127.0.0.1 is us, and says so, so developer traffic can be excluded from
    // the organic counts without the evaluator having to know our hosts.
    assert.ok(
      events().every((row) => row.source === "dev"),
      "traffic from localhost was not tagged as developer traffic",
    );
    assert.ok(events().every((row) => row.locale === "en"));
    assert.ok(events().every((row) => row.viewport === "wide"));
    assert.ok(events().every((row) => row.client_id.length >= 16));
    assert.equal(
      new Set(events().map((row) => row.client_id)).size,
      1,
      "one page load reported more than one client id",
    );

    // The index is the client id, which is the grain the bootstrap resamples on.
    assert.ok(stored.every((point) => point.indexes.length === 1));
    assert.equal(stored[0].blobs.length, BLOB_COLUMNS.length);

    await context.close();
  },
);

test(
  "a click carries the rank it was clicked at, and a subscribe is about the feed",
  skipUnlessBrowser,
  async () => {
    stored = [];
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "es",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/es`, { waitUntil: "networkidle" });
    await settle(page);

    // A narrow viewport is reported as narrow.
    assert.ok(
      events().every((row) => row.viewport === "narrow"),
      "a 390px viewport was not reported as narrow",
    );
    assert.ok(events().every((row) => row.locale === "es"));

    const before = events().filter((row) => row.type === "click").length;
    // target="_blank", so this opens a tab rather than leaving the board.
    await page.locator(".events .event-body h4 a").first().click();
    await settle(page);
    const clicks = events().filter((row) => row.type === "click");
    assert.equal(clicks.length, before + 1, "the click was not reported");
    assert.equal(clicks[0].position, 0, "a click on the top row was not rank 0");
    // Which team owns rank 0 is a seeded coin off a freshly minted client id,
    // so it is genuinely either one. What must hold is that the click agrees
    // with the impression it came from: crediting a click to the team that did
    // not put the row there is the one way this measurement can be wrong.
    const topImpression = events().find(
      (row) => row.type === "impression" && row.position === 0,
    );
    assert.equal(
      clicks[0].ranking,
      topImpression.ranking,
      "the click credited a different team than the impression at the same rank",
    );
    assert.equal(clicks[0].event_id, topImpression.event_id);
    assert.equal(clicks[0].session_id, topImpression.session_id);

    // The copy button is the subscribe action, and the feed is not one event.
    await page.locator(".feed button").first().click();
    await settle(page);
    const saves = events().filter((row) => row.type === "save");
    assert.equal(saves.length, 1, "subscribing was not reported");
    assert.equal(saves[0].event_id, FEED_EVENT_ID);
    assert.equal(
      saves[0].ranking,
      "none",
      "a feed-level save credited an ordering it is not evidence for",
    );

    await context.close();
  },
);

test(
  "the client id is random, local, and thrown away after seven days",
  skipUnlessBrowser,
  async () => {
    stored = [];
    const context = await browser.newContext({ locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await settle(page);

    const stashed = await page.evaluate(() =>
      window.localStorage.getItem("hacklist.client"),
    );
    const parsed = JSON.parse(stashed);
    assert.match(parsed.id, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(typeof parsed.createdAt, "number");
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["createdAt", "id"],
      "the stored record carries something beyond a random id and its age",
    );
    assert.equal(
      events()[0].client_id,
      parsed.id,
      "the reported client id is not the one in localStorage",
    );

    // Two fresh browsers must not agree on an id: there is no server-side
    // derivation, so nothing can make them.
    const second = await browser.newContext({ locale: "en" });
    const secondPage = await second.newPage();
    await secondPage.goto(`${origin}/`, { waitUntil: "networkidle" });
    await settle(secondPage);
    const other = JSON.parse(
      await secondPage.evaluate(() =>
        window.localStorage.getItem("hacklist.client"),
      ),
    );
    assert.notEqual(other.id, parsed.id, "two browsers were given the same id");
    await second.close();

    // Age the record past the rotation window and reload: a new id, and the old
    // one is gone rather than remembered anywhere.
    await page.evaluate(() => {
      const raw = JSON.parse(window.localStorage.getItem("hacklist.client"));
      raw.createdAt -= 8 * 86400000;
      window.localStorage.setItem("hacklist.client", JSON.stringify(raw));
    });
    stored = [];
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    const rotated = JSON.parse(
      await page.evaluate(() => window.localStorage.getItem("hacklist.client")),
    );
    assert.notEqual(
      rotated.id,
      parsed.id,
      "an eight-day-old client id was not rotated",
    );
    assert.ok(
      events().every((row) => row.client_id === rotated.id),
      "the board kept reporting the rotated-out id",
    );

    await context.close();
  },
);

test(
  "with a model in the build the board drafts, says so, and labels every row",
  skipUnlessBrowser,
  async () => {
    stored = [];
    const context = await browser.newContext({ locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await settle(page);

    const rows = events().filter((row) => row.type === "impression");
    const teams = new Set(rows.map((row) => row.ranking));
    assert.ok(
      teams.has("production") && teams.has("candidate"),
      `the drafted list used only ${[...teams].join(", ")}`,
    );
    // Team sizes never differ by more than one across the whole list, which is
    // what makes a click a fair vote between the two orderings.
    const counts = { production: 0, candidate: 0 };
    for (const row of [...rows].sort((a, b) => a.position - b.position)) {
      counts[row.ranking] += 1;
      assert.ok(
        Math.abs(counts.production - counts.candidate) <= 1,
        `teams drifted to ${counts.production} versus ${counts.candidate} by rank ${row.position}`,
      );
    }
    assert.ok(
      rows.every((row) => row.model_version === ranker.model_version),
      "a drafted impression did not name the model that drafted it",
    );

    // The page says the order is being tested, and stops printing month
    // headings, because it is no longer in date order.
    assert.equal(await page.locator(".ordering-note").count(), 1);
    assert.equal(
      await page.locator(".events .month").count(),
      0,
      "a drafted list still printed month headings, which claim date order",
    );

    // The server render, which has no client identity, is still the board's
    // own ordering: the reorder happens after hydration or not at all.
    const serverHtml = await (await fetch(`${origin}/`)).text();
    assert.ok(
      serverHtml.includes('class="month"'),
      "the server render lost its month headings, so it drafted without a client id",
    );

    await context.close();
  },
);
