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
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const profileDir = resolve(root, ".local-browser-profile");

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Launch the dedicated persistent profile. Headed by default: the whole point
 * is that a human can complete sign-in and the occasional CAPTCHA.
 */
export async function launchLocalBrowser({ headless = false } = {}) {
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    executablePath: CHROME_MAC,
    viewport: { width: 1280, height: 900 },
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
    const urls = new Set();
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
      urls.add(`https://luma.com/${path}`);
    }
    return [...urls];
  });
}
