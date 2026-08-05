// Shared helper for the local, signed-in browser passes (personalized
// discovery and the Luma calendar UI sync).
//
// Design rules:
//   * A DEDICATED persistent profile, never the user's everyday Chrome
//     profile — pointing automation at a live profile risks profile-lock
//     errors and corrupting real browsing data.
//   * The profile lives outside version control and is never exported.
//     Cookies and storage stay on this machine; nothing session-related is
//     ever written into the repo or into CI.
//   * Only Luma's own public/admin web UI is driven. No internal endpoints.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const profileDir = resolve(root, ".local-browser-profile");

// The board's timezone. Every browser this launches is pinned to it so that a
// time typed into a Luma form means the same thing wherever the code runs.
const BOARD_TIMEZONE = process.env.BOARD_TIMEZONE ?? "America/Los_Angeles";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/**
 * Where Chrome is. playwright-core ships no browser of its own, so this has to
 * be found rather than assumed — the path differs between this Mac and a CI
 * runner. CHROME_PATH wins when set.
 */
function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return CHROME_CANDIDATES[0]; // let Playwright report the real error
}

/**
 * The session cookies that carry a Luma login, if they have been supplied.
 *
 * Set LUMA_SESSION_COOKIES to the JSON array that scripts/export-luma-session.mjs
 * prints, and the passes that need a signed-in browser will run anywhere — CI
 * included — instead of only on the machine holding the profile.
 *
 * Only the two cookies that constitute the session are carried. Cloudflare's
 * (__cf_bm, cf_clearance) are deliberately left behind: they are short-lived and
 * bound to the IP and user agent that earned them, so replaying them from a
 * datacenter is worse than letting that runner earn its own.
 */
function suppliedCookies() {
  const raw = process.env.LUMA_SESSION_COOKIES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    console.warn("LUMA_SESSION_COOKIES is set but is not valid JSON — ignoring it.");
    return null;
  }
}

/**
 * Launch a browser with a Luma session.
 *
 * Two modes. Given LUMA_SESSION_COOKIES it launches a throwaway browser and
 * injects them, which is what lets this run somewhere that has no profile.
 * Otherwise it opens the dedicated persistent profile, headed by default, so a
 * human can complete sign-in and the occasional CAPTCHA.
 */
export async function launchLocalBrowser({ headless = false } = {}) {
  const cookies = suppliedCookies();
  if (cookies) {
    const browser = await chromium.launch({
      headless: true, // nobody is watching wherever this is running
      executablePath: chromeExecutable(),
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // Pin the zone. Luma's forms render and interpret times in the browser's
      // timezone, and a GitHub runner is UTC — so a 9am Pacific start typed into
      // the form was read as 9am UTC and stored as 2am Pacific, a silent
      // seven-hour shift that never showed up in local testing.
      timezoneId: BOARD_TIMEZONE,
      locale: "en-US",
    });
    await context.addCookies(cookies);
    context.setDefaultTimeout(30_000);
    // Closing the context alone would leak the browser process.
    const close = context.close.bind(context);
    context.close = async () => {
      await close().catch(() => {});
      await browser.close().catch(() => {});
    };
    return context;
  }

  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    executablePath: chromeExecutable(),
    viewport: { width: 1280, height: 900 },
    // Same reason as above, and it also keeps a run on this Mac identical to a
    // run anywhere else rather than accidentally correct.
    timezoneId: BOARD_TIMEZONE,
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.setDefaultTimeout(30_000);
  return context;
}

/**
 * True when the profile has a live Luma session. Checked from the DOM of a
 * normal page rather than by inspecting cookies.
 */
export async function isSignedIn(page) {
  try {
    await page.goto("https://luma.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch {
    return false;
  }
  await page.waitForTimeout(2_500);
  const signedOut = await page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    const onSignInPage = /\/signin/.test(location.pathname);
    const hasSignInCta = /\bSign In\b/.test(text) && !/\bSign Out\b/.test(text);
    return onSignInPage || hasSignInCta;
  });
  return !signedOut;
}

/**
 * Detect the two states that mean "stop, a human is needed" so callers can
 * exit without losing queue state.
 */
export async function needsHumanAttention(page) {
  const signals = await page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    return {
      captcha:
        /captcha|verify you are human|unusual activity|are you a robot/i.test(
          text,
        ) || Boolean(document.querySelector('iframe[src*="captcha"], iframe[title*="challenge" i]')),
      signedOut: /\/signin/.test(location.pathname),
    };
  });
  if (signals.captcha) return "captcha";
  if (signals.signedOut) return "signed-out";
  return null;
}

/**
 * Interactive first-run sign-in. Opens Luma and polls until the profile has a
 * session, so the user signs in with their own hands and we never touch
 * credentials.
 */
export async function ensureSignedIn(context, { timeoutMs = 300_000 } = {}) {
  const page = context.pages()[0] ?? (await context.newPage());
  if (await isSignedIn(page)) return page;

  // Running on supplied cookies means nobody is at a keyboard. Waiting five
  // minutes for a sign-in that cannot happen would just burn the job's budget
  // and then fail anyway, so say what is wrong and fail immediately.
  if (process.env.LUMA_SESSION_COOKIES) {
    throw new Error(
      "LUMA_SESSION_COOKIES did not produce a signed-in session. The cookies " +
        "have probably been revoked or expired — re-export them with " +
        "`npm run luma:export-session` and update the secret.",
    );
  }

  console.log(
    [
      "",
      "  Luma sign-in required (one time per profile)",
      "  ------------------------------------------------------",
      "  A Chrome window is open. In that window:",
      "    1. Sign in to Luma with the account that will administer",
      "       the Hacklist SF calendar.",
      "    2. Complete any email code or CAPTCHA it asks for.",
      "  This script waits and continues by itself once you are in.",
      `  The session is stored only in ${profileDir}`,
      "  (gitignored) and is never uploaded or committed.",
      "",
    ].join("\n"),
  );

  try {
    await page.goto("https://luma.com/signin", { waitUntil: "domcontentloaded" });
  } catch {
    // Sign-in page may already be open, or navigation may race the redirect.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5_000);
    let stillSignedOut;
    try {
      stillSignedOut = await page.evaluate(() => {
        const text = document.body?.innerText ?? "";
        return (
          /\/signin/.test(location.pathname) ||
          (/\bSign In\b/.test(text) && !/\bSign Out\b/.test(text))
        );
      });
    } catch {
      continue; // mid-navigation
    }
    if (!stillSignedOut) {
      console.log("  Signed in. Continuing.\n");
      return page;
    }
  }
  throw new Error(
    "Timed out waiting for Luma sign-in. Re-run when you can complete it.",
  );
}

export function eventUrlsFromPage(page) {
  return page.evaluate(() => {
    // Capture the card's text with the link. The sweep uses it to visit
    // hackathon-looking events first, so a personalized feed full of general
    // meetups cannot crowd out the events we actually want.
    const urls = new Map();
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      let resolved;
      try {
        resolved = new URL(href, location.href);
      } catch {
        continue;
      }
      if (!["luma.com", "lu.ma"].includes(resolved.hostname)) continue;
      const path = resolved.pathname.replace(/^\/+|\/+$/g, "");
      // Event permalinks are a single path segment. Skip Luma's own surfaces.
      if (!path || path.includes("/")) continue;
      if (
        /^(home|signin|signup|discover|create|pricing|help|settings|calendar|user|explore|about|terms|privacy)$/i.test(
          path,
        )
      ) {
        continue;
      }
      const url = `https://luma.com/${path}`;
      const own = (anchor.textContent || "").replace(/\s+/g, " ").trim();
      const nearby = (anchor.closest("li,article,div")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      const text = own.length > 3 ? own : nearby;
      if (!urls.has(url) || (text && text.length > urls.get(url).length)) {
        urls.set(url, text);
      }
    }
    return [...urls].map(([url, text]) => ({ url, text }));
  });
}
