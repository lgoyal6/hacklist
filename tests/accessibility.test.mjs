// Regression tests for the four accessibility defects measured in C29.
//
// Each one was found by hand with a browser, not by axe: axe reported zero
// violations on this board while returning `color-contrast` as *incomplete* for
// 484 nodes, because the body's gradient and grain defeat its computation. So
// the contrast test below does the arithmetic itself, against the composited
// pixel colours sampled by `.agent-work/contrast2.mjs`, rather than trusting a
// tool that declined to look.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

const CSS = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

/** The value of a `--token` declared in :root, as an [r, g, b] triple. */
function token(name) {
  const hex = CSS.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i"))?.[1];
  assert.ok(hex, `--${name} is not declared as a six-digit hex in globals.css`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two colours. */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("faint ink clears 4.5:1 on every ground the board paints it on", () => {
  // The first four are composited pixels read back off a full-page screenshot
  // of the production build, so the gradient and the grain are included rather
  // than guessed: white behind the listing, the sunk band behind the byline,
  // the card behind the masthead buttons, and the separator's own ground. The
  // last two are the paper tokens as declared, so a change to either of them is
  // also covered.
  const grounds = [
    ["listing white", [255, 255, 255]],
    ["byline band", [234, 233, 222]],
    ["masthead card", [245, 237, 231]],
    ["separator ground", [237, 236, 226]],
    ["--paper", token("paper")],
    ["--paper-sunk", token("paper-sunk")],
  ];

  // --ink-faint carries the byline, the result count, month headings, event
  // notes, two status pills and the footer copy. All of it is small text, so
  // 1.4.3 AA asks for 4.5:1 and none of it qualifies for the 3:1 large-text
  // allowance.
  const faint = token("ink-faint");
  for (const [where, ground] of grounds) {
    const ratio = contrast(faint, ground);
    assert.ok(
      ratio >= 4.5,
      `--ink-faint rgb(${faint}) is ${ratio.toFixed(2)}:1 on ${where} ` +
        `rgb(${ground}); WCAG 1.4.3 AA needs 4.5:1 for text this size`,
    );
  }

  // And it must stay distinguishable from --ink-soft, or darkening it far
  // enough to pass would silently collapse two levels of the type hierarchy
  // into one colour.
  assert.notDeepEqual(faint, token("ink-soft"));
});

/** The built worker, rendering one path, as rendered-html.test.mjs drives it. */
async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("the result count is a live region, so a search announces itself", async () => {
  const html = await (await render("/")).text();
  const count = html.match(/<span class="count"[^>]*>/)?.[0];
  assert.ok(count, "the result count is not on the first paint at all");

  // Typing in the search box rewrites this element from "69 shown" to
  // "15 shown" and moves nothing else. Without a live region that change is
  // silent, and a screen reader user gets no confirmation the search did
  // anything (WCAG 4.1.3 Status Messages).
  assert.match(
    count,
    /role="status"/,
    `the result count exposes no status role: ${count}`,
  );
  assert.match(
    count,
    /aria-live="polite"/,
    `the result count is not a polite live region: ${count}`,
  );
});

/** Every `<button>` inside one `<nav class="...">`, with its exposed state. */
function navButtons(html, className) {
  const nav = html.match(
    new RegExp(`<nav class="${className}"[^>]*>([\\s\\S]*?)</nav>`),
  )?.[1];
  assert.ok(nav, `no <nav class="${className}"> on the first paint`);
  return [...nav.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    label: m[2].replace(/<!--[\s\S]*?-->/g, "").trim(),
    pressed: m[1].match(/aria-pressed="(true|false)"/)?.[1] ?? null,
    active: /class="[^"]*\bactive\b/.test(m[1]),
  }));
}

test("view filters expose their selected state the way region buttons do", async () => {
  const html = await (await render("/")).text();

  // The region switcher already does this correctly, and is the pattern to
  // match rather than a second convention to invent.
  const regions = navButtons(html, "regions");
  assert.ok(regions.length > 1, "expected more than one region button");
  for (const button of regions) {
    assert.notEqual(button.pressed, null, `region "${button.label}" lost aria-pressed`);
  }

  // The view filters signalled selection only through a CSS `active` class,
  // which is a paint and not a state: nothing in the accessibility tree said
  // which view was showing (WCAG 4.1.2 Name, Role, Value).
  const views = navButtons(html, "views");
  assert.ok(views.length > 1, "expected more than one view filter");
  for (const button of views) {
    assert.notEqual(
      button.pressed,
      null,
      `view filter "${button.label}" reports no aria-pressed, only class active=${button.active}`,
    );
    // Bound to the same condition the class is bound to, not to a constant.
    assert.equal(
      button.pressed === "true",
      button.active,
      `view filter "${button.label}" says aria-pressed=${button.pressed} but ` +
        `paints itself active=${button.active}`,
    );
  }
  assert.equal(
    views.filter((button) => button.pressed === "true").length,
    1,
    "exactly one view filter is showing, so exactly one may be pressed",
  );
});

test("the copy button's resting name contains its visible label", async () => {
  const html = await (await render("/")).text();
  const button = html.match(/<button([^>]*)>Copy link<\/button>/);
  assert.ok(button, "the copy button is not on the first paint as 'Copy link'");
  const name = button[1].match(/aria-label="([^"]*)"/)?.[1] ?? "Copy link";

  // WCAG 2.5.3 Label in Name: an accessible name that does not contain the
  // visible label leaves a speech-input user saying a phrase the page cannot
  // match. "Copy calendar link" does not contain "Copy link".
  assert.ok(
    name.toLowerCase().includes("copy link"),
    `visible label "Copy link" is not contained in the accessible name ${JSON.stringify(name)}`,
  );
});

// The half of the copy button that only exists after a click needs a real
// browser: the confirmation is client state, so the first paint cannot show it.
// Served the way the production worker is served, with the client bundle on
// disk, so the page actually hydrates.
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter(Boolean);
// Resolved at module load: node:test evaluates a test's options when the test is
// registered, which happens before any hook runs.
const executablePath = CHROME.find((path) => existsSync(path));

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
  origin = `http://127.0.0.1:${server.address().port}/`;

  if (!executablePath) return; // the test below skips itself
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
});

test(
  "the copy button's accessible name changes when it copies",
  { skip: executablePath ? false : "no Chrome on this machine" },
  async () => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    const copy = page.locator(".feed button").first();

    /** What the accessibility tree calls this control right now. */
    const accessibleName = async () =>
      (await copy.ariaSnapshot()).match(/"([^"]*)"/)?.[1] ?? "";
    const visibleLabel = async () => (await copy.textContent())?.trim() ?? "";

    const restingName = await accessibleName();
    const restingLabel = await visibleLabel();

    await copy.click();
    await page.waitForFunction(
      () => document.querySelector(".feed button")?.textContent === "Copied",
      null,
      { timeout: 5000 },
    );
    const copiedName = await accessibleName();
    const copiedLabel = await visibleLabel();
    await context.close();

    assert.equal(restingLabel, "Copy link");
    assert.equal(copiedLabel, "Copied");

    // The visible label changed, so the announced one has to change too, or the
    // confirmation is visual only and a screen reader user never learns the
    // copy happened.
    assert.notEqual(
      copiedName,
      restingName,
      `the accessible name stayed ${JSON.stringify(restingName)} while the ` +
        `visible label went "${restingLabel}" -> "${copiedLabel}"`,
    );

    // WCAG 2.5.3 Label in Name, in both states.
    for (const [label, name] of [
      [restingLabel, restingName],
      [copiedLabel, copiedName],
    ]) {
      assert.ok(
        name.toLowerCase().includes(label.toLowerCase()),
        `visible label ${JSON.stringify(label)} is not contained in the ` +
          `accessible name ${JSON.stringify(name)}`,
      );
    }
  },
);
