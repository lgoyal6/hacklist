// Integration test for the code that fills Luma's Add External Event form.
//
// This is the largest untested surface in the repo and the one that put wrong
// rows on a public calendar three times in a day: an event three weeks early, two
// events seven hours off, and five refused for reasons that turned out to be my
// own bugs. Unit tests could not have caught any of it, because the mistakes were
// all in how the code interacts with a real page.
//
// So: the real filling code, driven by a real browser, against a page that
// reproduces the behaviours that broke — see the fixture for what and why. No
// network, nothing written to anyone's calendar.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

import { fillExternalEvent } from "../scripts/lib/luma-external-form.mjs";

const TZ = "America/Los_Angeles";
const FIXTURE = new URL("./fixtures/luma-external-form.html", import.meta.url);
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter(Boolean);

let server;
let browser;
let origin;

// Resolved at module load, not in before(): node:test evaluates a test's options
// when the test is REGISTERED, which happens before any hook runs. Deciding the
// skip from a variable that before() sets meant every test skipped itself.
const executablePath = CHROME.find((path) => existsSync(path));

before(async () => {
  const html = await readFile(FIXTURE, "utf8");
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;

  if (!executablePath) return; // tests below skip themselves
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
});

/** A page on the fixture, with the timezone pinned as production pins it. */
async function openForm() {
  const context = await browser.newContext({ timezoneId: TZ, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { page, context };
}

const event = (over = {}) => ({
  url: "https://builder.aws.com/content/abc/some-hackathon",
  title: "Women in AI Hackathon at the AWS Builder Loft",
  organizer: "Devnovate",
  venue: "AWS Builder Loft",
  city: "San Francisco",
  timezone: TZ,
  start: "2026-08-21T09:00:00-07:00",
  end: "2026-08-21T18:00:00-07:00",
  timeUnverified: false,
  ...over,
});

const skipUnlessBrowser = () =>
  executablePath ? {} : { skip: "no Chrome found; set CHROME_PATH to run these" };

test("fills every field and sets the date the board states", skipUnlessBrowser(), async () => {
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(page, event(), { timezone: TZ });
    assert.equal(result.ok, true, `should fill: ${result.why ?? ""}`);

    assert.equal(
      await page.locator("input[name=url]").inputValue(),
      "https://builder.aws.com/content/abc/some-hackathon",
    );
    assert.equal(
      await page.locator("input[name=name]").inputValue(),
      "Women in AI Hackathon at the AWS Builder Loft",
    );
    assert.equal(await page.locator("input[name=host]").inputValue(), "Devnovate");
    assert.match(
      await page.locator('input[placeholder*="address" i]').inputValue(),
      /AWS Builder Loft/,
    );
    // The date the form settled on, not merely what was typed.
    assert.equal(await page.locator("#d0").inputValue(), "Fri, Aug 21");
  } finally {
    await context.close();
  }
});

test("types an unambiguous date rather than the format the field displays", skipUnlessBrowser(), async () => {
  // The bug this guards: "Fri, Aug 21" typed back into the field is parsed as
  // "Aug 2" — three weeks early, silently. The driver must type ISO.
  const { page, context } = await openForm();
  try {
    await fillExternalEvent(page, event(), { timezone: TZ });
    const typed = await page.evaluate(() => window.__state.rawDateTyped);
    assert.equal(typed, "2026-08-21", "must type ISO, not the displayed format");
  } finally {
    await context.close();
  }
});

test("writes the clock time in the board's zone, not the host's", skipUnlessBrowser(), async () => {
  // The bug this guards: a 9am Pacific start stored as 2am, because Luma reads a
  // typed time in the browser's zone and the CI runner is UTC.
  const { page, context } = await openForm();
  try {
    await fillExternalEvent(page, event(), { timezone: TZ });
    assert.equal(await page.locator("#t0").inputValue(), "09:00", "start time, Pacific");
    assert.equal(await page.locator("#t1").inputValue(), "18:00", "end time, Pacific");
  } finally {
    await context.close();
  }
});

test("accepts a date in another year, which the field displays differently", skipUnlessBrowser(), async () => {
  // Luma shows out-of-year dates as "1/25/2027". A readback check that only knows
  // the verbose format rejects a perfectly good date — it did, to DeveloperWeek.
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(
      page,
      event({
        title: "DeveloperWeek 2027 Hackathon",
        start: "2027-01-25T09:00:00-08:00",
        end: "2027-01-25T17:00:00-08:00",
      }),
      { timezone: TZ },
    );
    assert.equal(result.ok, true, `should accept: ${result.why ?? ""}`);
    assert.equal(await page.locator("#d0").inputValue(), "1/25/2027");
  } finally {
    await context.close();
  }
});

test("refuses an event whose time nobody stated", skipUnlessBrowser(), async () => {
  // Luma has no all-day option and substitutes 19:00 server-side, so publishing
  // one of these means inventing an hour.
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(
      page,
      event({ title: "Shower Hacks", timeUnverified: true }),
      { timezone: TZ },
    );
    assert.equal(result.ok, false);
    assert.match(result.why, /no stated start time/);
    assert.equal(await page.evaluate(() => window.__state.submitted), false);
  } finally {
    await context.close();
  }
});

test("adds a time-unknown event when explicitly told to", skipUnlessBrowser(), async () => {
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(
      page,
      event({ title: "Shower Hacks", timeUnverified: true }),
      { timezone: TZ, syncTimeUnknownExternals: true },
    );
    assert.equal(result.ok, true, `should fill: ${result.why ?? ""}`);
    // The claim is retracted in the only field we control.
    assert.match(
      await page.locator("input[name=name]").inputValue(),
      /start time on event page/,
    );
  } finally {
    await context.close();
  }
});

test("reports the truncated end date rather than hiding it", skipUnlessBrowser(), async () => {
  // Luma's end field mirrors the start and cannot be set, so a multi-day event
  // becomes a one-day entry. That is a limit of the target, and it is recorded.
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(
      page,
      event({ start: "2026-08-21T09:00:00-07:00", end: "2026-08-23T18:00:00-07:00" }),
      { timezone: TZ },
    );
    assert.equal(result.ok, true, `should fill: ${result.why ?? ""}`);
    assert.match(result.note ?? "", /not expressible/);
    assert.equal(await page.locator("#d0").inputValue(), "Fri, Aug 21", "starts on day one");
  } finally {
    await context.close();
  }
});

test("does not press Escape, which would close the whole dialog", skipUnlessBrowser(), async () => {
  // Escape dismisses the date picker and the modal with it. The fixture removes
  // the dialog on Escape, so if the driver ever reaches for it the form vanishes.
  const { page, context } = await openForm();
  try {
    await fillExternalEvent(page, event(), { timezone: TZ });
    assert.equal(
      await page.locator("#dialog").count(),
      1,
      "the dialog must still be open after filling",
    );
  } finally {
    await context.close();
  }
});

test("leaves an event with no date alone", skipUnlessBrowser(), async () => {
  const { page, context } = await openForm();
  try {
    const result = await fillExternalEvent(
      page,
      event({ title: "OpenEnv Hackathon SF", start: null, end: null }),
      { timezone: TZ },
    );
    assert.equal(result.ok, false);
    assert.match(result.why, /no date|no stated start time/);
  } finally {
    await context.close();
  }
});
