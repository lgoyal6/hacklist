// Adds pending events to the free "Hacklist SF" Luma calendar by driving
// Luma's own supported Add Event admin UI with the signed-in local profile.
// This is the no-paid-API path: same clicks a human would make, just batched.
//
// Usage:
//   node scripts/luma-sync-ui.mjs --calendar https://luma.com/<slug> [--dry-run]
//   node scripts/luma-sync-ui.mjs --queue        # print pending list, no browser
//
// The calendar URL is remembered in data/luma-ledger.json after the first run.
import {
  formatQueueReport,
  markFailed,
  markSynced,
  pendingEvents,
  readEvents,
  readLedger,
  writeLedger,
} from "./lib/luma-queue.mjs";
import {
  ensureSignedIn,
  launchLocalBrowser,
  needsHumanAttention,
} from "./lib/local-browser.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const queueOnly = args.includes("--queue");
const headless = args.includes("--headless");
const calendarArg = args[args.indexOf("--calendar") + 1];
const calendarFromArg =
  args.includes("--calendar") && calendarArg && !calendarArg.startsWith("--")
    ? calendarArg.startsWith("http")
      ? calendarArg.replace(/\/$/, "")
      : `https://luma.com/${calendarArg.replace(/^\/+/, "")}`
    : null;

const { events } = await readEvents();
const ledger = await readLedger();
const calendarUrl = calendarFromArg ?? ledger.calendar;
const pending = pendingEvents(events, ledger);

if (queueOnly) {
  console.log(formatQueueReport(pending, ledger));
  process.exit(0);
}

if (!calendarUrl) {
  console.error(
    [
      "",
      "  No Hacklist SF calendar configured yet.",
      "  ------------------------------------------------------",
      "  One-time setup on Luma (free, no Luma Plus needed):",
      "    1. Open https://luma.com/create/calendar",
      '    2. Name it "Hacklist SF" and create it.',
      "    3. Copy its URL (e.g. https://luma.com/hacklist-sf).",
      "",
      "  Then run:",
      "    node scripts/luma-sync-ui.mjs --calendar https://luma.com/<slug>",
      "",
      "  To see what would be added first:",
      "    node scripts/luma-sync-ui.mjs --queue",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!pending.length) {
  console.log(formatQueueReport(pending, ledger));
  process.exit(0);
}

console.log(
  `${pending.length} pending event${pending.length === 1 ? "" : "s"} for ${calendarUrl}` +
    `${dryRun ? " (dry run — nothing will be submitted)" : ""}\n`,
);

const manageUrl = `${calendarUrl}/manage`;
const context = await launchLocalBrowser({ headless });
let stopReason = null;
let added = 0;
let failed = 0;

/** Locate the Add Event control, trying the labels Luma uses for admins. */
async function openAddEvent(page) {
  const candidates = [
    page.getByRole("button", { name: /^add event$/i }),
    page.getByRole("link", { name: /^add event$/i }),
    page.getByRole("button", { name: /add event/i }),
    page.getByRole("button", { name: /submit event/i }),
    page.getByRole("link", { name: /submit event/i }),
  ];
  for (const locator of candidates) {
    try {
      const control = locator.first();
      if (await control.isVisible({ timeout: 2_500 })) {
        await control.click();
        await page.waitForTimeout(1_200);
        return true;
      }
    } catch {
      // try the next label
    }
  }
  return false;
}

/** Find the field that takes an existing event URL. */
async function fillEventUrl(page, url) {
  const candidates = [
    page.getByPlaceholder(/luma\.com|event url|event link|paste/i),
    page.locator('input[type="url"]'),
    page.getByRole("textbox", { name: /url|link/i }),
    page.locator('input[type="text"]:visible'),
    page.locator("textarea:visible"),
  ];
  for (const locator of candidates) {
    try {
      const field = locator.first();
      if (await field.isVisible({ timeout: 2_000 })) {
        await field.fill(url);
        await page.waitForTimeout(800);
        return true;
      }
    } catch {
      // try the next selector
    }
  }
  return false;
}

async function confirmSubmission(page) {
  const candidates = [
    page.getByRole("button", { name: /^add event$/i }),
    page.getByRole("button", { name: /^add$/i }),
    page.getByRole("button", { name: /^submit$/i }),
    page.getByRole("button", { name: /confirm|continue|save/i }),
  ];
  for (const locator of candidates) {
    try {
      const control = locator.last();
      if (
        (await control.isVisible({ timeout: 2_000 })) &&
        (await control.isEnabled())
      ) {
        await control.click();
        await page.waitForTimeout(2_500);
        return true;
      }
    } catch {
      // try the next label
    }
  }
  return false;
}

/**
 * Only ever mark synced on positive evidence: the event's slug shows up in the
 * calendar's own management list.
 */
async function verifyOnCalendar(page, event) {
  try {
    await page.goto(manageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    const slug = new URL(event.url).pathname.replace(/^\/+/, "");
    return await page.evaluate(
      ({ slug, title }) => {
        const html = document.body?.innerHTML ?? "";
        const text = document.body?.innerText ?? "";
        const normalize = (value) =>
          value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        return (
          (slug.length > 3 && html.includes(slug)) ||
          normalize(text).includes(normalize(title).slice(0, 40))
        );
      },
      { slug, title: event.title },
    );
  } catch {
    return false;
  }
}

try {
  const page = await ensureSignedIn(context);

  for (const event of pending) {
    if (stopReason) break;
    const label = `${event.dateLabel} ${event.title.slice(0, 48)}`;

    if (dryRun) {
      console.log(`  would add: ${label}\n            ${event.url}`);
      continue;
    }

    try {
      await page.goto(manageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2_000);

      stopReason = await needsHumanAttention(page);
      if (stopReason) break;

      if (!(await openAddEvent(page))) {
        // Not fatal for this event alone, but it means the UI does not look
        // the way we expect — stop rather than thrash the whole queue.
        markFailed(ledger, event, "Add Event control not found on manage page");
        failed += 1;
        stopReason = "ui-mismatch";
        break;
      }

      if (!(await fillEventUrl(page, event.url))) {
        markFailed(ledger, event, "Event URL field not found in Add Event dialog");
        failed += 1;
        stopReason = "ui-mismatch";
        break;
      }

      if (!(await confirmSubmission(page))) {
        markFailed(ledger, event, "Submit control not found or disabled");
        failed += 1;
        continue;
      }

      stopReason = await needsHumanAttention(page);
      if (stopReason) break;

      if (await verifyOnCalendar(page, event)) {
        markSynced(ledger, event, "luma-ui");
        added += 1;
        console.log(`  added:  ${label}`);
      } else {
        markFailed(ledger, event, "Submitted but not visible on calendar");
        failed += 1;
        console.warn(`  unverified: ${label}`);
      }
    } catch (error) {
      markFailed(ledger, event, error instanceof Error ? error.message : error);
      failed += 1;
      console.warn(`  failed: ${label} — ${error}`);
    }
  }
} finally {
  await context.close();
  if (!dryRun) {
    ledger.calendar = calendarUrl;
    await writeLedger(ledger);
  }
}

if (dryRun) {
  console.log(`\nDry run complete: ${pending.length} event(s) would be submitted.`);
  process.exit(0);
}

console.log(
  `\nLuma UI sync: ${added} added, ${failed} failed, ` +
    `${pendingEvents(events, ledger).length} still pending.`,
);

if (stopReason === "captcha") {
  console.error(
    "Stopped on a CAPTCHA. Re-run and solve it in the browser window; the queue is preserved.",
  );
} else if (stopReason === "signed-out") {
  console.error("Stopped: session signed out. Re-run to sign in again.");
} else if (stopReason === "ui-mismatch") {
  console.error(
    [
      "Stopped: Luma's Add Event UI did not match what this script expects.",
      "Nothing was lost — every unsynced event stays pending.",
      "Run with --queue to get the paste-by-hand list.",
    ].join("\n"),
  );
}
process.exit(stopReason ? 1 : 0);
