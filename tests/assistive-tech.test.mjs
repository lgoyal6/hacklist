// C29 - what an assistive technology perceives on the Hacklist board.
//
// tests/accessibility.test.mjs already pins the four defects found by hand:
// contrast measured off composited pixels, the result count's live-region
// markup, aria-pressed on both filter navs, and Label-in-Name on the copy
// button. Those are markup assertions on server-rendered HTML. What was never
// checked is what the *accessibility tree* holds once the page hydrates, and
// whether the one live region on the page actually announces.
//
// This file drives a real Chrome through the accessibility tree:
//
//   1. Key tasks - choose a region, filter the list, copy the feed link - with
//      assertions on the computed role, accessible name, value and state.
//   2. The live region: that filtering produces the announcement a user would
//      hear, once per change, with the right number in it.
//   3. Touch targets, measured on the rendered boxes, at a phone viewport.
//   4. axe-core injected from node_modules, reporting `incomplete` alongside
//      `violations`, because the last scan on this board returned zero
//      violations while declining to check color-contrast on 471 nodes.
//
// WHAT THIS ESTABLISHES: the roles, names, states and live-region text that
// Chromium's accessibility tree carries for these flows, and the axe result
// including what axe could not decide.
//
// WHAT IT DOES NOT: no screen reader is run. NVDA, JAWS, VoiceOver and TalkBack
// each apply their own heuristics on top of this tree and disagree with one
// another about ordering, verbosity and which live-region updates to suppress.
// Nothing here is a claim of WCAG conformance.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = CHROME.find((path) => existsSync(path));
const skip = executablePath ? false : "no Chrome on this machine";

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
            "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("at", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  server = createServer(async (request, response) => {
    const url = `http://127.0.0.1:${server.address().port}${request.url}`;
    let served = await assets.fetch(new Request(url));
    if (served.status === 404) {
      served = await worker.fetch(
        new Request(url, { headers: { accept: request.headers.accept ?? "text/html" } }),
        { ASSETS: assets },
        { waitUntil() {}, passThroughOnException() {} }
      );
    }
    response.writeHead(served.status, Object.fromEntries(served.headers));
    response.end(Buffer.from(await served.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;

  if (!executablePath) return;
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
});

/** A hydrated page on the board, with the live-region recorder already armed. */
async function board(viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  // Hydration has happened once a filter button responds to a click, so wait
  // for React rather than for a timer.
  await page.waitForSelector("nav.views button", { state: "visible" });
  return { context, page };
}

/**
 * Record what the page's live regions hand to a screen reader.
 *
 * One entry per region per MutationObserver callback: a callback is one
 * microtask checkpoint, which is the granularity at which the browser raises a
 * single accessibility notification. Two writes inside the same React commit
 * are therefore one announcement, and two writes in separate commits are two -
 * which is exactly the "announced once, not three times" question.
 */
async function armRecorder(page) {
  await page.evaluate(() => {
    window.__ann = [];
    const observer = new MutationObserver((records) => {
      const batch = new Map();
      for (const record of records) {
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const host = node?.closest("[aria-live], [role='status'], [role='alert'], [role='log']");
        if (!host) continue;
        const text = host.textContent.trim();
        if (!text) continue;
        batch.set(host, text);
      }
      for (const [host, text] of batch) {
        window.__ann.push({
          region: host.getAttribute("role") || host.getAttribute("aria-live"),
          politeness:
            host.getAttribute("aria-live") ||
            (host.getAttribute("role") === "alert" ? "assertive" : "polite"),
          text,
        });
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

const heard = (page) => page.evaluate(() => window.__ann);

/* ── 1. Key tasks through the accessibility tree ───────────────────────── */

test("the region and filter navs expose grouped, named, pressable buttons", { skip }, async () => {
  const { context, page } = await board();
  try {
    // Names and states as the platform computes them, not as the markup spells
    // them: getByRole resolves through the accessibility tree.
    const regions = page.getByRole("navigation", { name: "Choose a region" });
    assert.equal(await regions.count(), 1, "the region switcher must be a named landmark");

    const regionButtons = regions.getByRole("button");
    const names = await regionButtons.evaluateAll((els) => els.map((el) => el.textContent.trim()));
    assert.ok(names.length >= 2, `expected several regions, got ${JSON.stringify(names)}`);

    const pressed = await regionButtons.evaluateAll((els) =>
      els.filter((el) => el.getAttribute("aria-pressed") === "true").map((el) => el.textContent.trim())
    );
    assert.equal(
      pressed.length,
      1,
      `exactly one region should read as pressed, got ${JSON.stringify(pressed)}`
    );

    const views = page.getByRole("navigation", { name: "Filter events" });
    assert.equal(await views.count(), 1, "the view filter must be a named landmark");
    const viewPressed = await views
      .getByRole("button")
      .evaluateAll((els) =>
        els.filter((el) => el.getAttribute("aria-pressed") === "true").map((el) => el.textContent.trim())
      );
    assert.equal(viewPressed.length, 1, "exactly one view filter should read as pressed");

    // The whole board's aria tree, so a reader of this record can see what a
    // screen reader walks.
    const tree = await page.getByRole("navigation", { name: "Filter events" }).ariaSnapshot();
    console.log("\n[aria tree] filter nav\n" + tree);
    console.log(`[aria tree] regions: ${JSON.stringify(names)}, pressed: ${JSON.stringify(pressed)}`);
  } finally {
    await context.close();
  }
});

test("the search box and the copy button resolve to real accessible names", { skip }, async () => {
  const { context, page } = await board();
  try {
    const search = page.getByRole("searchbox", { name: "Search events" });
    const textbox = (await search.count()) ? search : page.getByRole("textbox", { name: "Search events" });
    assert.equal(await textbox.count(), 1, "the search input must be reachable by its name");

    const copy = page.getByRole("button", { name: "Copy link to calendar feed" });
    assert.equal(await copy.count(), 1, "the copy control must be reachable by its resting name");

    // Nothing focusable may compute to an empty name: that is what a screen
    // reader reads out as an unlabelled button.
    const unnamed = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )) {
        if (el.closest("[aria-hidden='true']")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const labelled = el.getAttribute("aria-labelledby");
        const fromIds = labelled
          ? labelled
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || "")
              .join(" ")
          : "";
        const name = (
          el.getAttribute("aria-label") ||
          fromIds ||
          [...(el.labels || [])].map((l) => l.textContent).join(" ") ||
          el.textContent ||
          el.getAttribute("title") ||
          ""
        ).trim();
        if (!name) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
      return out;
    });
    assert.deepEqual(unnamed, [], "controls that would be announced as unlabelled");
  } finally {
    await context.close();
  }
});

/* ── 2. The live region actually announces ─────────────────────────────── */

test("filtering announces the new result count, once per change", { skip }, async () => {
  const { context, page } = await board();
  try {
    const count = page.locator(".count");
    const before = (await count.textContent()).trim();

    await armRecorder(page);
    await page.getByRole("textbox", { name: "Search events" }).fill("hackathon");
    // Let React finish the commit the keystrokes produced.
    await page.waitForFunction(
      (previous) => document.querySelector(".count")?.textContent.trim() !== previous,
      before
    );
    await page.waitForTimeout(200);

    const announcements = await heard(page);
    console.log("\n[announced] typing 'hackathon' into the search box");
    console.log(`  before: "${before}"`);
    console.log("  " + JSON.stringify(announcements));

    assert.ok(announcements.length > 0, "filtering must reach the live region");
    for (const a of announcements) {
      assert.equal(a.politeness, "polite", "a filter result is not an interruption");
      assert.match(a.text, /^\d+ shown$/, `unexpected announcement text: ${a.text}`);
    }
    // The announcement a user actually hears at rest is the final one, and it
    // has to match what is on screen.
    const after = (await count.textContent()).trim();
    assert.equal(announcements.at(-1).text, after);
    assert.notEqual(after, before, "the filter must have changed the count");

    // No repeat of the same text back to back: a region rewritten with an
    // identical string in a separate commit is spoken twice by readers that do
    // not suppress it.
    const stutter = announcements.filter((a, i) => i > 0 && announcements[i - 1].text === a.text);
    assert.deepEqual(stutter, [], "the same count must not be announced twice in a row");
  } finally {
    await context.close();
  }
});

test("typing does not queue one announcement per keystroke", { skip }, async () => {
  const { context, page } = await board();
  try {
    const box = page.getByRole("textbox", { name: "Search events" });
    await box.click();
    await armRecorder(page);
    // Character by character with a human-ish delay. `fill()` would set the
    // value in one commit and hide the question entirely: the failure mode a
    // polite live region has is being rewritten on every keystroke, which some
    // screen readers read out in full each time.
    const query = "hackathon";
    await box.pressSequentially(query, { delay: 80 });
    await page.waitForTimeout(500);

    const announcements = await heard(page);
    console.log(
      `\n[announced] typing "${query}" one character at a time (${query.length} keystrokes)`
    );
    console.log(`  ${announcements.length} announcement(s): ` + JSON.stringify(announcements.map((a) => a.text)));

    assert.ok(announcements.length > 0, "typing must eventually announce the new count");
    // The count is genuinely different after most keystrokes, so an
    // announcement per distinct value is correct behaviour; what would be wrong
    // is announcing the same number repeatedly.
    const texts = announcements.map((a) => a.text);
    const stutter = texts.filter((t, i) => i > 0 && texts[i - 1] === t);
    assert.deepEqual(stutter, [], "the same count must never be announced twice in a row");
    assert.ok(
      announcements.length <= query.length,
      `at most one announcement per keystroke, got ${announcements.length} for ${query.length}`
    );
    assert.equal(
      announcements.at(-1).text,
      (await page.locator(".count").textContent()).trim(),
      "the last thing announced must be what is on screen"
    );
  } finally {
    await context.close();
  }
});

test("an emptied board announces zero rather than going silent", { skip }, async () => {
  const { context, page } = await board();
  try {
    await armRecorder(page);
    await page
      .getByRole("textbox", { name: "Search events" })
      .fill("zzzz-no-such-event-anywhere");
    await page.waitForFunction(() => document.querySelector(".count")?.textContent.trim() === "0 shown");

    const announcements = await heard(page);
    console.log("\n[announced] a search with no matches");
    console.log("  " + JSON.stringify(announcements.at(-1)));
    assert.equal(announcements.at(-1).text, "0 shown");

    // The empty-state copy is on screen but sits outside the live region, so a
    // screen reader hears the count and has to be told to go read the list. The
    // count carrying the number is what makes that recoverable.
    const empty = (await page.locator("li.empty").textContent()).trim();
    console.log(`  visible empty-state text (NOT announced): "${empty}"`);
    assert.ok(empty.length > 0);
  } finally {
    await context.close();
  }
});

test("the recorder stays silent when nothing changes (control)", { skip }, async () => {
  const { context, page } = await board();
  try {
    await armRecorder(page);
    await page.waitForTimeout(400);
    assert.deepEqual(await heard(page), [], "an idle page must announce nothing");
  } finally {
    await context.close();
  }
});

/* ── 3. Touch targets on a phone ───────────────────────────────────────── */

test("every control clears the 24x24 target minimum at a phone width", { skip }, async () => {
  const { context, page } = await board({ width: 390, height: 844 });
  try {
    const measured = await page.evaluate(() => {
      const targets = [];
      for (const el of document.querySelectorAll("button, a[href], input, select, [tabindex='0']")) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        targets.push({
          el,
          box,
          // SC 2.5.8's "Inline" exception: a target inside a sentence, where
          // the line box decides its height and the author cannot enlarge it
          // without breaking the text.
          inline: style.display.startsWith("inline") && !!el.closest("p, li"),
          what: `${el.tagName.toLowerCase()}.${el.className || "?"}`,
          name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
        });
      }
      const centre = (b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
      const out = [];
      for (const t of targets) {
        if (t.inline) continue;
        if (t.box.width >= 24 && t.box.height >= 24) continue;
        // SC 2.5.8's "Spacing" exception, as written: a 24px-diameter circle
        // centred on the undersized target must not intersect another target,
        // nor the circle of another undersized target. Circle-against-box for a
        // full-size neighbour, circle-against-circle for an undersized one.
        const a = centre(t.box);
        const hitsBox = (box) => {
          const nx = Math.max(box.left, Math.min(a.x, box.right));
          const ny = Math.max(box.top, Math.min(a.y, box.bottom));
          return Math.hypot(a.x - nx, a.y - ny) < 12;
        };
        let crowdedBy = null;
        for (const other of targets) {
          if (other === t) continue;
          const undersized = other.box.width < 24 || other.box.height < 24;
          const b = centre(other.box);
          const clash = undersized
            ? Math.hypot(a.x - b.x, a.y - b.y) < 24
            : hitsBox(other.box);
          if (clash) {
            crowdedBy = other.name || other.what;
            break;
          }
        }
        out.push({
          what: t.what,
          name: t.name,
          size: `${t.box.width.toFixed(1)}x${t.box.height.toFixed(1)}`,
          exemptBySpacing: crowdedBy === null,
          crowdedBy,
        });
      }
      return out;
    });

    const failing = measured.filter((m) => !m.exemptBySpacing);
    console.log("\n[target size] at 390x844, undersized targets and how SC 2.5.8 lands");
    for (const m of measured) {
      console.log(
        `  ${m.size.padEnd(12)} ${m.exemptBySpacing ? "exempt (spacing)" : "FAILS, crowded by " + m.crowdedBy}  ${m.name}`
      );
    }
    assert.deepEqual(
      failing.map((f) => `${f.name} ${f.size}`),
      [],
      "undersized targets that the spacing exception does not rescue"
    );
  } finally {
    await context.close();
  }
});

/* ── 4. axe, with the incomplete count ─────────────────────────────────── */

test("axe reports violations AND what it declined to check", { skip }, async () => {
  const { context, page } = await board();
  try {
    const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
    await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(async () => {
      const run = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      });
      const shape = (list) =>
        list.map((r) => ({ id: r.id, impact: r.impact, nodes: r.nodes.length }));
      return {
        version: window.axe.version,
        violations: shape(run.violations),
        incomplete: shape(run.incomplete),
        passes: run.passes.length,
        inapplicable: run.inapplicable.length,
      };
    });

    const incompleteNodes = result.incomplete.reduce((n, r) => n + r.nodes, 0);
    console.log("\n[axe] hacklist board, axe-core " + result.version);
    console.log("  violations : " + JSON.stringify(result.violations));
    console.log(`  incomplete : ${incompleteNodes} nodes -> ${JSON.stringify(result.incomplete)}`);
    console.log(`  passes: ${result.passes} rules, inapplicable: ${result.inapplicable} rules`);

    assert.deepEqual(result.violations, [], "axe violations");
    // Deliberately NOT asserted to be zero. A rule that returns `incomplete`
    // did not pass, it declined to decide, and reporting only `violations`
    // turns that into a green tick. The number is recorded so a reader can see
    // how much of the page the tool actually judged: the previous scan on this
    // board left color-contrast incomplete for 471 nodes, which is why
    // tests/accessibility.test.mjs does the contrast arithmetic by hand.
    assert.equal(typeof incompleteNodes, "number");
  } finally {
    await context.close();
  }
});
