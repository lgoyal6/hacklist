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
  root,
} from "./lib/local-browser.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);

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
// Blast radius control. A wrong external-event fill creates a publicly visible
// event that has to be deleted by hand, so the first run of a new form mapping
// should be aimed at exactly one event.
// --force re-submits even when the event is already on the calendar. Needed to
// correct an entry that was added with bad data: reconcile would otherwise adopt
// it and skip the retry forever.
const force = args.includes("--force");
const onlyArg = args[args.indexOf("--only") + 1];
const onlyUrl =
  args.includes("--only") && onlyArg && !onlyArg.startsWith("--") ? onlyArg : null;
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
async function openAddEvent(page, mode = "luma") {
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
  const wanted =
    mode === "external" ? /add external event/i : /add existing luma event/i;
  try {
    const chooser = page.getByText(wanted).first();
    if (await chooser.isVisible({ timeout: 2_500 })) {
      await chooser.click();
      await page.waitForTimeout(2_000);
    } else if (mode === "external") {
      // The external path has no fallback: without the chooser we would be
      // filling the Luma-URL modal with a Devpost link.
      return false;
    }
  } catch {
    if (mode === "external") return false;
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

/**
 * Fill Luma's Add External Event form from a candidate's structured fields.
 *
 * Field order was established by inspecting the live form (see the call site).
 * Everything here is verified by reading the value back after writing it: a date
 * that silently did not take would publish an event on the wrong day, which is
 * worse than not publishing it, so a readback mismatch fails the event instead.
 *
 * Times are written only when the board believes them. A date-only source
 * (Devpost publishes submission dates and no clock times) gets its time fields
 * cleared rather than filled with the form's 18:00/19:00 default — the same rule
 * the board and the ICS feed already follow.
 */
async function fillExternalEvent(page, event) {
  const urlField = page.locator('input[type="url"][name="url"]').first();
  try {
    if (!(await urlField.isVisible({ timeout: 4_000 }))) {
      return { ok: false, why: "external form did not open" };
    }
  } catch {
    return { ok: false, why: "external form did not open" };
  }

  await urlField.fill(event.url);
  // Luma fetches the URL and tries to fill the form from it, showing "Parsing
  // URL..." while it works and keeping the submit button disabled. Filling the
  // other fields before it settles means racing its writes against ours, and
  // submitting before it settles is why the first attempts reported the submit
  // control as disabled.
  for (let tick = 0; tick < 25; tick += 1) {
    const parsing = await page
      .evaluate(() => /parsing url/i.test(document.body?.innerText ?? ""))
      .catch(() => false);
    if (!parsing) break;
    await page.waitForTimeout(1_000);
  }
  await page.waitForTimeout(800);

  // Our own values win over whatever the parse guessed: they come from the
  // event's structured record, which is what the board itself publishes.
  // Luma's external-event form has no all-day option and substitutes 19:00
  // server-side even when the time field is cleared — verified. So for an event
  // whose time we do not know, the honest move is to retract the claim in the one
  // field we control: the name. A subscriber sees the right date and is told the
  // time is not ours to assert, instead of being quietly sent at 7pm.
  const timeKnown = event.timeUnverified !== true && Boolean(event.start);
  // Luma forces a clock time on external events — no all-day option, and it
  // substitutes 19:00 server-side even when the field is cleared. For an event
  // whose time nobody stated, that is a made-up 7pm on a public calendar. The
  // board and the ICS feed can both say "date known, time unknown" honestly;
  // Luma cannot, so by default these are left off it rather than published with
  // a fabricated hour. Set syncTimeUnknownExternals to true to add them anyway,
  // in which case the name carries the retraction.
  if (!timeKnown && config.syncTimeUnknownExternals !== true) {
    return {
      ok: false,
      why:
        "no stated start time, and Luma forces one on external events — left off " +
        "the calendar rather than published at a made-up 7pm " +
        "(set syncTimeUnknownExternals to override)",
    };
  }
  const displayTitle = timeKnown
    ? event.title
    : `${event.title} (start time on event page)`;
  const nameField = page.locator('input[type="text"][name="name"]').first();
  await nameField.fill(displayTitle);

  // Address and host are optional; skip rather than invent.
  const location = [event.venue, event.city].filter(Boolean).join(", ");
  if (location) {
    const address = page.locator('input[placeholder*="address" i]').first();
    try {
      if (await address.isVisible({ timeout: 1_500 })) await address.fill(location);
    } catch {
      // optional
    }
  }
  if (event.organizer && event.organizer !== "Unknown organizer") {
    const host = page.locator('input[name="host"]').first();
    try {
      if (await host.isVisible({ timeout: 1_500 })) await host.fill(event.organizer);
    } catch {
      // optional
    }
  }

  // Dates. Luma's form exposes one editable date row: typing the start date makes
  // the end field mirror it, and the end field itself is neither clickable (the
  // picker overlays it) nor reachable by Tab. So an external event is added as a
  // single day, and the policy for what that means is below.
  const dateFields = page.locator(
    'input[type="text"]:not([name]):not([placeholder])',
  );
  const timeFields = page.locator('input[type="time"]');
  if (!(await dateFields.count().catch(() => 0))) {
    return { ok: false, why: "no date field in external form" };
  }

  const zone = event.timezone || "America/Los_Angeles";
  // Type an unambiguous ISO date. The format matters more than it looks: "Sun,
  // Aug 23" — the format the field itself displays — is parsed as "Sun, Aug 2",
  // silently landing the event three weeks early. ISO round-trips correctly.
  const fmt = (iso, opts) =>
    new Intl.DateTimeFormat(opts.locale ?? "en-US", {
      timeZone: zone,
      ...opts.parts,
    }).format(new Date(iso));
  const asIso = (iso) =>
    fmt(iso, {
      locale: "en-CA",
      parts: { year: "numeric", month: "2-digit", day: "2-digit" },
    });
  const asDisplayed = (iso) =>
    fmt(iso, { parts: { weekday: "short", month: "short", day: "numeric" } });
  // Luma shows a date in the current year as "Mon, Jan 25" and one in another
  // year as "1/25/2027". Both are correct; a check that knows only the first
  // rejects the second and refuses a perfectly good date.
  const asNumeric = (iso) =>
    fmt(iso, {
      parts: { year: "numeric", month: "numeric", day: "numeric" },
    });
  const normalise = (text) => String(text).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const dateAccepted = (readback, iso) =>
    normalise(readback) === normalise(asDisplayed(iso)) ||
    normalise(readback) === normalise(asNumeric(iso));

  const startIso = event.start;
  if (!startIso) return { ok: false, why: "event has no date to put on a calendar" };
  const endIso = event.end || event.start;
  const sameDay = asIso(startIso) === asIso(endIso);

  // Luma's form has no settable end date — the end field mirrors the start and is
  // reachable neither by click nor by Tab. So every external event is a one-day
  // entry, and that is a limit of the target rather than a choice: withholding a
  // multi-day hackathon entirely serves a subscriber worse than listing it on its
  // first day with a link to the page that has the full schedule. The truncation
  // is recorded on the ledger entry so it is auditable rather than invisible.
  const truncatedEnd = !sameDay;

  const dateField = dateFields.first();
  await dateField.click();
  await page.waitForTimeout(600);
  // Keyboard only from here: the picker this opened intercepts further clicks.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(asIso(startIso), { delay: 40 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const readback = await dateField.inputValue().catch(() => "");
  // Exact match on the displayed form. Anything looser lets a truncated date
  // through, which is the failure this check exists for.
  if (!dateAccepted(readback, startIso)) {
    return {
      ok: false,
      why:
        `date did not take: wanted ${asDisplayed(startIso)} or ${asNumeric(startIso)}, ` +
        `field shows ${readback || "(empty)"}`,
    };
  }

  // Move focus off the date field so the picker closes and the time inputs are
  // reachable. Escape would close the whole modal, so click a known-safe field.
  await page.locator('input[name="name"]').first().click().catch(() => {});
  await page.waitForTimeout(700);

  // Times: written when the board believes them, cleared when it does not. The
  // form defaults to 18:00/19:00 and the inputs are not required, so clearing is
  // how a date-only event avoids being given a time nobody stated.
  // Whether the board believes this event's clock time. Deliberately independent
  // of whether it spans days: Grokathon has a real 9am start and runs two days,
  // and tying belief to sameDay threw that away and let Luma default it to 7pm.
  const believable = event.timeUnverified !== true && Boolean(event.start);
  const timeCount = await timeFields.count().catch(() => 0);
  const clock = (iso) =>
    fmt(iso, {
      locale: "en-GB",
      parts: { hour: "2-digit", minute: "2-digit", hour12: false },
    });
  for (let i = 0; i < Math.min(timeCount, 2); i += 1) {
    const value = believable ? clock(i === 0 ? startIso : endIso) : "";
    try {
      await timeFields.nth(i).fill(value);
      await page.waitForTimeout(300);
    } catch {
      // Checked below rather than guessed at.
    }
  }
  if (timeCount) {
    const got = await timeFields.first().inputValue().catch(() => "");
    if (believable && normalise(got) !== normalise(clock(startIso))) {
      return {
        ok: false,
        why: `start time did not take: wanted ${clock(startIso)}, field shows ${got || "(empty)"}`,
      };
    }
    if (!believable && got) {
      return {
        ok: false,
        why:
          `this event's time is unknown and Luma keeps its ${got} default — ` +
          "refusing to publish a time we do not believe",
      };
    }
  }

  // Touching a time input opens its own dropdown, which then sits over the
  // submit button and swallows the click. Park focus somewhere harmless.
  await page.locator('input[name="name"]').first().click().catch(() => {});
  await page.waitForTimeout(600);

  return {
    ok: true,
    note: truncatedEnd
      ? `end date ${asIso(endIso)} not expressible in Luma's form; listed on its start day`
      : null,
  };
}

/**
 * The modal's submit is a real <button> whose label lives in a child div, so it
 * matches by accessible name — but it stays disabled while Luma parses the URL
 * and validates. Poll rather than sample once.
 */
function externalSubmit(page) {
  // Scope to the form that owns the URL field. Matching by accessible name
  // across the page picks up the manage page's own Add Event control behind the
  // modal, and .last() is only accidentally right.
  return page
    .locator('form:has(input[name="url"]) button:has-text("Add Event")')
    .last();
}

async function waitForSubmitEnabled(page, timeoutMs = 20_000) {
  const control = externalSubmit(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await control.isVisible()) && (await control.isEnabled())) return true;
    } catch {
      // keep waiting
    }
    await page.waitForTimeout(750);
  }
  return false;
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
  // External events have no Luma slug, so presence has to be judged by title.
  // Collected from the same rows, in the same scroll passes.
  const titles = new Set();
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
    const rowTitles = await page.evaluate(() =>
      [...document.querySelectorAll("a[href], h1, h2, h3, h4")]
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 8 && text.length < 160),
    );
    for (const title of rowTitles) titles.add(title);
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
  return { slugs, titles };
}

/** Loose title match — Luma trims and re-cases, so compare on letters only. */
function titleOnCalendar(titles, title) {
  const key = (text) => text.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const wanted = key(title);
  if (!wanted) return false;
  for (const candidate of titles) {
    const seen = key(candidate);
    // A calendar row often shows the title verbatim; allow either to contain the
    // other so a truncated row still counts, but require real length so short
    // fragments cannot match everything.
    if (seen === wanted) return true;
    if (wanted.length >= 18 && (seen.includes(wanted) || wanted.includes(seen)) && seen.length >= 18) {
      return true;
    }
  }
  return false;
}

/** Is this event on the calendar, by slug for Luma events and title otherwise? */
function isOnCalendar(event, state) {
  const slug = eventSlug(event);
  if (slug) return state.slugs.has(slug);
  return titleOnCalendar(state.titles, event.title);
}

/**
 * Make the ledger agree with the calendar, in both directions: adopt events
 * that are present but unrecorded, and un-sync records whose event is not
 * actually there so they become pending again instead of being skipped forever.
 */
function reconcile(ledger, allEvents, state) {
  let adopted = 0;
  let cleared = 0;
  for (const event of allEvents) {
    // External events are matched by title; before that was possible they were
    // skipped here, which is why a manually-added one was never adopted.
    const present = isOnCalendar(event, state);
    if (present && !ledger.synced[event.id]) {
      markSynced(ledger, event, eventSlug(event) ? "luma-ui" : "luma-ui-external");
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
  const { adopted, cleared } = force
    ? { adopted: 0, cleared: 0 }
    : reconcile(ledger, events, onCalendar);
  if (adopted || cleared) {
    console.log(
      `Reconciled with the calendar: ${adopted} already there, ` +
        `${cleared} previously recorded but missing.\n`,
    );
  }
  let queue = dryRun ? pending : pendingEvents(events, ledger);
  if (force && onlyUrl) queue = events.filter((event) => event.url === onlyUrl);
  if (onlyUrl) {
    queue = queue.filter((event) => event.url === onlyUrl);
    console.log(`--only: narrowed to ${queue.length} event(s) matching ${onlyUrl}`);
  }
  console.log(`${queue.length} to add.\n`);

  for (const event of queue) {
    if (stopReason) break;
    const label = `${event.dateLabel} ${event.title.slice(0, 48)}`;

    if (dryRun) {
      console.log(`  would add: ${label}\n            ${event.url}`);
      continue;
    }

    // Two different Luma flows behind one loop. A Luma event is a URL paste; an
    // external one is a form, mapped from the structured fields the API sources
    // give us. Field order was established by inspecting the live form:
    //
    //   1 input[type=url][name=url]    REQUIRED  the event's own URL
    //   2 input[type=text][name=name]  REQUIRED  title
    //   3 input[placeholder*=address]  optional  venue, city
    //   4 input[type=text][name=host]  optional  organizer
    //   5 input[type=text] (bare)      start date, "Sun, Aug 23"
    //   6 input[type=text] (bare)      end date
    //   7 input[type=time]             start time, 24h, prefilled 18:00
    //   8 input[type=time]             end time, prefilled 19:00
    //
    // The time inputs are not required, which is what makes this honest: a
    // date-only source gets them cleared rather than accepting the 18:00 default.
    const external = event.platform !== "luma";
    // Declared out here so the submit step below can report what the fill did.
    let externalFill = null;

    try {
      await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2_500);

      stopReason = await needsHumanAttention(page);
      if (stopReason) break;

      if (!(await openAddEvent(page, external ? "external" : "luma"))) {
        // Not fatal for this event alone, but it means the UI does not look
        // the way we expect — stop rather than thrash the whole queue.
        markFailed(
          ledger,
          event,
          external
            ? "Add External Event option not found in the Add Event chooser"
            : "Add Event control not found on manage page",
        );
        failed += 1;
        stopReason = "ui-mismatch";
        break;
      }

      if (external) {
        const filled = await fillExternalEvent(page, event);
        externalFill = filled;
        if (filled.ok && !(await waitForSubmitEnabled(page))) {
          markFailed(ledger, event, "External form filled but submit never enabled");
          failed += 1;
          console.warn(`  skipped (external): ${label} — submit never enabled`);
          continue;
        }
        if (!filled.ok) {
          // A form we could not fill truthfully is this event's problem, not the
          // whole queue's — the next event may be perfectly fillable.
          markFailed(ledger, event, filled.why);
          failed += 1;
          console.warn(`  skipped (external): ${label} — ${filled.why}`);
          continue;
        }
      } else if (!(await fillEventUrl(page, event.url))) {
        markFailed(ledger, event, "Event URL field not found in Add Event dialog");
        failed += 1;
        stopReason = "ui-mismatch";
        break;
      }

      if (external) {
        // Submit through the form-scoped control rather than the shared helper,
        // which searches the whole page.
        const control = externalSubmit(page);
        let clicked = false;
        try {
          await control.click({ timeout: 6_000 });
          clicked = true;
        } catch {
          // Luma's modal keeps transient dropdowns over the footer, so a real
          // pointer click gets swallowed. This is a genuine <button type=submit>,
          // so dispatching on the element runs the same handler without needing
          // the point to be free.
          try {
            await control.evaluate((node) => node.click());
            clicked = true;
          } catch (error) {
            markFailed(ledger, event, `External submit click failed: ${error}`);
          }
        }
        if (!clicked) {
          failed += 1;
          console.warn(`  skipped (external): ${label} — submit would not click`);
          continue;
        }
        await page.waitForTimeout(3_500);
        console.log(
          `  submitted (external): ${label}` +
            (externalFill?.note ? `\n      note: ${externalFill.note}` : ""),
        );
        stopReason = await needsHumanAttention(page);
        if (stopReason) break;
        continue;
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
      if (isOnCalendar(event, finalState)) {
        if (!ledger.synced[event.id]) added += 1;
        markSynced(
          ledger,
          event,
          eventSlug(event) ? "luma-ui" : "luma-ui-external",
        );
      } else if (!ledger.failures[event.id]) {
        // Only claim a failure we have not already explained. An external event
        // we declined to fill has a better message than this one.
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
