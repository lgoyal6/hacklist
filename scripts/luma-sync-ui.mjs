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
const nameArg = args[args.indexOf("--name") + 1];
const calendarName =
  args.includes("--name") && nameArg && !nameArg.startsWith("--")
    ? nameArg
    : "Hacklist SF";

const { events } = await readEvents();
const ledger = await readLedger();
const pending = pendingEvents(events, ledger);

if (queueOnly) {
  console.log(formatQueueReport(pending, ledger));
  process.exit(0);
}

if (!pending.length) {
  console.log(formatQueueReport(pending, ledger));
  process.exit(0);
}

console.log(
  `${pending.length} pending event${pending.length === 1 ? "" : "s"}` +
    `${dryRun ? " (dry run — nothing will be submitted)" : ""}\n`,
);

/**
 * Find the calendar's admin page. Luma's admin URL shape is not something to
 * guess at, so the signed-in Calendars list is the source of truth: match the
 * calendar by name and take the link Luma itself provides.
 */
async function resolveCalendarUrl(page) {
  const known = calendarFromArg ?? ledger.calendar;
  if (known) return known;

  const wanted = calendarName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const listing of [
    "https://luma.com/calendars",
    "https://luma.com/home",
  ]) {
    try {
      await page.goto(listing, { waitUntil: "domcontentloaded" });
    } catch {
      continue;
    }
    await page.waitForTimeout(2_500);
    const href = await page.evaluate((wanted) => {
      const normalize = (value) =>
        (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      for (const anchor of document.querySelectorAll("a[href]")) {
        if (!normalize(anchor.textContent).includes(wanted)) continue;
        try {
          const url = new URL(anchor.getAttribute("href"), location.href);
          if (["luma.com", "lu.ma"].includes(url.hostname)) {
            return `https://luma.com${url.pathname}`.replace(/\/$/, "");
          }
        } catch {
          // keep looking
        }
      }
      return null;
    }, wanted);
    if (href) return href;
  }
  return null;
}

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
    await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_500);
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

let adminUrl = null;

try {
  const page = await ensureSignedIn(context);

  const calendarUrl = await resolveCalendarUrl(page);
  if (!calendarUrl) {
    console.error(
      [
        "",
        `  Could not find a calendar named "${calendarName}" on this account.`,
        "  ------------------------------------------------------",
        "  Either create it at https://luma.com/create/calendar, or point at it",
        "  directly:",
        "    npm run luma:sync -- --calendar https://luma.com/<slug>",
        "  If it exists under a different name:",
        `    npm run luma:sync -- --name "Your Calendar Name"`,
        "",
      ].join("\n"),
    );
    await context.close();
    process.exit(1);
  }

  // Luma's admin surface has moved around; find the page that actually offers
  // Add Event rather than assuming a URL shape.
  const shapes = [
    `${calendarUrl}/manage`,
    calendarUrl,
    `${calendarUrl}/manage/events`,
  ];
  for (const shape of shapes) {
    try {
      await page.goto(shape, { waitUntil: "domcontentloaded" });
    } catch {
      continue;
    }
    await page.waitForTimeout(2_500);
    const hasControl = await page.evaluate(() =>
      /add event|submit event/i.test(document.body?.innerText ?? ""),
    );
    if (hasControl) {
      adminUrl = shape;
      break;
    }
  }
  if (!adminUrl) {
    console.error(
      `\n  Found the calendar at ${calendarUrl} but no Add Event control on it.` +
        `\n  Send me that page and I'll adjust the selectors.\n`,
    );
    await context.close();
    process.exit(1);
  }
  console.log(`Calendar admin: ${adminUrl}\n`);
  ledger.calendar = calendarUrl;

  for (const event of pending) {
    if (stopReason) break;
    const label = `${event.dateLabel} ${event.title.slice(0, 48)}`;

    if (dryRun) {
      console.log(`  would add: ${label}\n            ${event.url}`);
      continue;
    }

    try {
      await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2_500);

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
  // The resolved calendar is worth remembering even after a dry run, so the
  // next invocation skips discovery.
  await writeLedger(ledger);
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
