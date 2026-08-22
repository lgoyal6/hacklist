// Filling Luma's "Add External Event" form.
//
// Separated from the sync so it can be driven against a controlled page in
// tests. This is the code that produced every wrong row on the calendar, and
// each awkward detail below is a measurement against the live form rather than
// a guess:
//
//   * `format` is required in the request body; the date field looks like a
//     picker but also parses typed text.
//   * The format of that text matters enormously. "Sun, Aug 23" — the format the
//     field itself displays — is parsed as "Sun, Aug 2", silently landing the
//     event three weeks early. ISO round-trips. Hence the readback check.
//   * Luma shows a date in the current year as "Mon, Jan 25" and one in another
//     year as "1/25/2027". A check that knows only the first rejects a good date.
//   * Escape closes the whole modal, so the picker is dismissed by moving focus.
//   * The end date mirrors the start and is reachable by neither click nor Tab, so
//     an external event is necessarily a one-day entry.
//   * There is no all-day option and Luma substitutes 19:00 server-side even when
//     the time field is cleared, so an event whose time nobody stated is refused
//     rather than published at a made-up hour.
import { isSuspectSchedule } from "./event-dates.mjs";

/**
 * Can this external event be added truthfully, under the current policy?
 *
 * Split out of the fill so the queue can ask before opening a form. Discovering
 * it mid-form meant every declined event was recorded as a failure and retried
 * forever: five of them had accumulated 10 to 38 attempts each, opening five
 * forms a night to reach the same conclusion, and permanently occupying the
 * failure count that is supposed to signal something is broken.
 *
 * A decline is a policy outcome, not a failure, and asking up front also means
 * flipping syncTimeUnknownExternals takes effect immediately rather than having
 * to invalidate stored state.
 */
export function canFillExternal(event, { syncTimeUnknownExternals = false } = {}) {
  const timeKnown = event.timeUnverified !== true && Boolean(event.start);
  if (timeKnown || syncTimeUnknownExternals === true) return { ok: true };
  return {
    ok: false,
    why:
      "no stated start time, and Luma forces one on external events — left off " +
      "the calendar rather than published at a made-up 7pm " +
      "(set syncTimeUnknownExternals to override)",
  };
}

export async function fillExternalEvent(page, event, options = {}) {
  const { timezone = "America/Los_Angeles", syncTimeUnknownExternals = false } = options;
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
  // Still checked here: the fill must stay correct on its own, since it is also
  // driven directly by tests. The queue asks first so this is normally moot.
  const allowed = canFillExternal(event, { syncTimeUnknownExternals });
  if (!allowed.ok) return allowed;
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
  // ControlOrMeta, not Meta: this ran on a Mac during development and Meta+a is
  // macOS select-all. On the Linux runner it does nothing, so the typed date
  // appended to the default instead of replacing it and every date silently came
  // out as today — which is exactly how five events failed the first CI run.
  await page.keyboard.press("ControlOrMeta+a");
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
