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

// Luma's admin flow is three steps, not one: "Add Event" opens a chooser
// (Create New / Add Existing Luma Event / Add External Event), the chosen mode
// opens a modal with a URL field, and the URL must be staged before the modal's
// own Add Event button becomes usable.
async function openAddEvent(page) {
  // Match on accessible name, not visible text: once the calendar has events
  // the roomy empty-state button is replaced by a plus icon whose only label is
  // an aria-label.
  const openers = [
    page.getByRole("button", { name: /^add event$/i }),
    page.getByRole("link", { name: /^add event$/i }),
    page.getByText("Add Event", { exact: true }),
    page.getByRole("button", { name: /add event/i }),
  ];
  let opened = false;
  for (const locator of openers) {
    try {
      const control = locator.first();
      if (await control.isVisible({ timeout: 2_000 })) {
        await control.click();
        opened = true;
        break;
      }
    } catch {
      // try the next locator
    }
  }
  if (!opened) return false;
  await page.waitForTimeout(1_800);

  // The chooser is expected but not required: if a future layout opens the URL
  // modal directly, carry on and let the URL field decide.
  try {
    const chooser = page
      .getByText("Add Existing Luma Event", { exact: false })
      .first();
    if (await chooser.isVisible({ timeout: 2_500 })) {
      await chooser.click();
      await page.waitForTimeout(2_000);
    }
  } catch {
    // no chooser on screen
  }
  return true;
}

/**
 * Fill the URL and stage it. The staging control is found by document position
 * relative to the input, never by label: the modal also lists "Suggested
 * Events" whose plus buttons expose the same accessible name, and clicking one
 * of those would silently add somebody else's event.
 */
async function fillEventUrl(page, url) {
  const field = page.locator('input[type="url"]').first();
  try {
    if (!(await field.isVisible({ timeout: 3_000 }))) return false;
  } catch {
    return false;
  }
  await field.fill(url);
  await page.waitForTimeout(1_000);

  await field.press("Enter");
  await page.waitForTimeout(1_500);

  // If Enter did not stage it, click the button immediately following the input.
  const stillHasText = await field.inputValue().catch(() => "");
  if (stillHasText) {
    try {
      await field.locator("xpath=following::button[1]").click({ timeout: 3_000 });
      await page.waitForTimeout(1_500);
    } catch {
      // Fall through: the confirm step will report if nothing was staged.
    }
  }
  return true;
}

async function confirmSubmission(page) {
  // The modal's submit is the last "Add Event" in the DOM; the earlier ones
  // belong to the page behind it.
  const control = page.getByRole("button", { name: /^add event$/i }).last();
  try {
    if (!(await control.isVisible({ timeout: 3_000 }))) return false;
    if (!(await control.isEnabled())) return false;
    await control.click();
    await page.waitForTimeout(3_000);
    return true;
  } catch {
    return false;
  }
}

function eventSlug(event) {
  try {
    const url = new URL(event.url);
    if (url.hostname !== "luma.com") return null;
    return url.pathname.replace(/^\/+|\/+$/g, "") || null;
  } catch {
    return null;
  }
}

/**
 * The set of event slugs actually listed on the calendar — ground truth.
 *
 * Read from the event rows' own links rather than by searching page text or
 * HTML: the admin page embeds hydration data and suggested-event payloads that
 * mention slugs which are not on the calendar, which previously produced
 * confident sync records for events that were never added.
 */
async function harvestCalendarSlugs(page) {
  const slugs = new Set();
  // Read after every small scroll step. Luma virtualizes the event list, so
  // scrolling to the bottom and reading once unmounts the earlier rows and
  // silently reports only the last screenful.
  const readVisible = async () => {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")]
        .map((anchor) => anchor.getAttribute("href") ?? "")
        .map((href) => href.match(/^\/([a-z0-9][a-z0-9._-]{3,})$/i)?.[1])
        .filter(Boolean),
    );
    for (const slug of found) {
      if (!/^(home|discover|create|signin|signup|pricing|help|settings)$/i.test(slug)) {
        slugs.add(slug);
      }
    }
  };
  const collect = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await readVisible();
    for (let i = 0; i < 20; i++) {
      const atEnd = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, window.innerHeight * 0.75);
        return window.scrollY === before;
      });
      await page.waitForTimeout(600);
      await readVisible();
      if (atEnd) break;
    }
  };

  await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  await collect();
  // Anything whose start time has passed moves to Past, so both tabs count.
  try {
    const past = page.getByText("Past", { exact: true }).first();
    if (await past.isVisible({ timeout: 2_000 })) {
      await past.click();
      await page.waitForTimeout(3_000);
      await collect();
    }
  } catch {
    // single-tab layout
  }
  return slugs;
}

/**
 * Make the ledger agree with the calendar, in both directions: adopt events
 * that are present but unrecorded, and un-sync records whose event is not
 * actually there so they become pending again instead of being skipped forever.
 */
function reconcile(ledger, allEvents, onCalendar) {
  let adopted = 0;
  let cleared = 0;
  for (const event of allEvents) {
    const slug = eventSlug(event);
    if (!slug) continue;
    const present = onCalendar.has(slug);
    if (present && !ledger.synced[event.id]) {
      markSynced(ledger, event, "luma-ui");
      adopted += 1;
    } else if (!present && ledger.synced[event.id]) {
      delete ledger.synced[event.id];
      cleared += 1;
    }
  }
  return { adopted, cleared };
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
    // Probe by accessible name, matching how the control is actually clicked:
    // on a non-empty calendar the button is an icon with only an aria-label, so
    // a body-text check would wrongly reject a working admin page.
    const hasControl =
      (await page
        .getByRole("button", { name: /add event/i })
        .count()
        .catch(() => 0)) > 0 ||
      (await page.evaluate(() =>
        /add event|submit event/i.test(document.body?.innerText ?? ""),
      ));
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

  // Start from what is really on the calendar, so a stale or wrong ledger
  // cannot cause either a duplicate add or a permanent skip.
  const onCalendar = await harvestCalendarSlugs(page);
  const { adopted, cleared } = reconcile(ledger, events, onCalendar);
  if (adopted || cleared) {
    console.log(
      `Reconciled with the calendar: ${adopted} already there, ` +
        `${cleared} previously recorded but missing.\n`,
    );
  }
  const queue = dryRun ? pending : pendingEvents(events, ledger);
  console.log(`${queue.length} to add.\n`);

  for (const event of queue) {
    if (stopReason) break;
    const label = `${event.dateLabel} ${event.title.slice(0, 48)}`;

    if (dryRun) {
      console.log(`  would add: ${label}\n            ${event.url}`);
      continue;
    }

    // Luma's "Add External Event" path is a full event form rather than a URL
    // paste, so it is left to a human instead of half-filled by guesswork.
    //
    // That reasoning is now weaker than it was: the API-shaped sources give us
    // every field this form wants as structured data, and external events are a
    // third of the board since Devpost and Y Combinator were added, so the
    // by-hand backlog only grows. The form was inspected read-only on
    // 2026-08-04; in DOM order it is:
    //
    //   1 input[type=url][name=url]    REQUIRED  ph "https://eventbrite.com/e/some-event"
    //   2 input[type=text][name=name]  REQUIRED  ph "Happy Hour Drinks"
    //   3 input[type=text]             optional  ph "What’s the address?"
    //   4 input[type=text][name=host]  optional  ph "Friends of the City"
    //   5 input[type=text]             start date, e.g. "Tue, Aug 4"; a
    //                                  "GMT-07:00" zone control sits beside it
    //   6 input[type=text]             end date, same format
    //   7 input[type=time]             start time, 24h, prefilled "18:00"
    //   8 input[type=time]             end time, 24h, prefilled "19:00"
    //
    // The two time inputs are NOT required, which is the part that matters: a
    // Devpost event has a trustworthy date and no clock time, and leaving those
    // blank is how it gets added without inventing one. Whether Luma accepts
    // them cleared, and whether field 5 is typeable or opens a picker, still
    // needs a live attempt — and a wrong attempt creates a publicly visible
    // event on the calendar, so it is not something to guess at unattended.
    if (event.platform !== "luma") {
      markFailed(
        ledger,
        event,
        "External event: needs Luma's Add External Event form, add by hand",
      );
      failed += 1;
      console.warn(`  skipped (external): ${label}`);
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

      // Luma rejects a repeat submission with "already been submitted", which
      // is confirmation the event is on the calendar, not a failure.
      const alreadyThere = await page
        .evaluate(() =>
          /already been submitted|already on this calendar/i.test(
            document.body?.innerText ?? "",
          ),
        )
        .catch(() => false);
      if (alreadyThere) {
        console.log(`  already on calendar: ${label}`);
      }

      stopReason = await needsHumanAttention(page);
      if (stopReason) break;

      // Submitted. Whether it stuck is settled by the final harvest below,
      // not by reading this page — Luma takes a moment to list a new event,
      // so checking here reports failures that are really just latency.
      console.log(`  submitted: ${label}`);
    } catch (error) {
      markFailed(ledger, event, error instanceof Error ? error.message : error);
      failed += 1;
      console.warn(`  failed: ${label} — ${error}`);
    }
  }

  if (!dryRun && queue.length) {
    console.log("\nConfirming against the calendar...");
    await page.waitForTimeout(5_000);
    const finalState = await harvestCalendarSlugs(page);
    for (const event of queue) {
      const slug = eventSlug(event);
      if (slug && finalState.has(slug)) {
        if (!ledger.synced[event.id]) added += 1;
        markSynced(ledger, event, "luma-ui");
      } else if (event.platform === "luma") {
        markFailed(ledger, event, "Submitted but never appeared on the calendar");
      }
    }
    failed = Object.keys(ledger.failures).length;
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
