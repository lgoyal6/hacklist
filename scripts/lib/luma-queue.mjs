// Pending-event queue for the free Luma calendar sync.
//
// The ledger records only sync bookkeeping. Event details are always read from
// data/events.json so there is one source of truth and no drift.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./local-browser.mjs";

export const ledgerPath = resolve(root, "data/luma-ledger.json");
export const eventsPath = resolve(root, "data/events.json");

export async function readEvents() {
  const { events, meta } = JSON.parse(await readFile(eventsPath, "utf8"));
  return { events, meta };
}

export async function readLedger() {
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    return {
      calendar: ledger.calendar ?? null,
      synced: ledger.synced ?? {},
      failures: ledger.failures ?? {},
    };
  } catch {
    return { calendar: null, synced: {}, failures: {} };
  }
}

export async function writeLedger(ledger) {
  const ordered = {
    calendar: ledger.calendar ?? null,
    updatedAt: new Date().toISOString(),
    synced: Object.fromEntries(
      Object.entries(ledger.synced).sort(([a], [b]) => a.localeCompare(b)),
    ),
    failures: Object.fromEntries(
      Object.entries(ledger.failures).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(ledgerPath, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Pending = published events that have never been confirmed on the calendar.
 * A previous failure leaves an event pending, so retries happen naturally.
 */
export function pendingEvents(events, ledger) {
  return events.filter((event) => !ledger.synced[event.id]);
}

export function markSynced(ledger, event, method) {
  ledger.synced[event.id] = {
    url: event.url,
    title: event.title,
    syncedAt: new Date().toISOString(),
    method,
  };
  delete ledger.failures[event.id];
}

export function markFailed(ledger, event, message) {
  const previous = ledger.failures[event.id];
  ledger.failures[event.id] = {
    url: event.url,
    title: event.title,
    lastAttemptAt: new Date().toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
    message: String(message).slice(0, 300),
  };
}

/**
 * Human-readable fallback: if the automation cannot run, this is the list to
 * paste into Luma's Add Event box by hand.
 */
export function formatQueueReport(pending, ledger, { syncTimeUnknownExternals = false } = {}) {
  if (!pending.length) {
    return `All ${Object.keys(ledger.synced).length} published events are on the calendar. Nothing pending.`;
  }
  // Split by why an event is waiting, because the two halves need different
  // things. A Luma event is just waiting its turn and the next run adds it. An
  // external one will never be added by the current automation at all: Luma's
  // "Add External Event" is a whole event form, not a URL paste, so the sync
  // skips it. Lumping them together hid that, and it stopped being a rounding
  // error once Devpost and Y Combinator became sources.
  const auto = pending.filter((event) => event.platform === "luma");
  const manual = pending.filter(
    (event) =>
      event.platform !== "luma" &&
      (syncTimeUnknownExternals ||
        !(event.timeUnverified === true || !event.start)),
  );
  // Nothing is declined once the override is on: they go in with the caveat in
  // the title instead.
  const declined = syncTimeUnknownExternals
    ? []
    : pending.filter(
        (event) =>
          event.platform !== "luma" &&
          (event.timeUnverified === true || !event.start),
      );

  const lines = [
    `${pending.length} event${pending.length === 1 ? "" : "s"} pending for the Hacklist SF Luma calendar.`,
    "",
  ];
  const describe = (event) => {
    const failure = ledger.failures[event.id];
    lines.push(`  ${event.dateLabel.padEnd(7)}${event.title}`);
    lines.push(`  ${" ".repeat(7)}${event.url}`);
    // A policy decline is not a failed attempt, and printing it as "failed 36x"
    // reads as something broken that needs chasing.
    const declinedForTime =
      !syncTimeUnknownExternals &&
      event.platform !== "luma" &&
      (event.timeUnverified === true || !event.start);
    if (declinedForTime) {
      lines.push(
        `  ${" ".repeat(7)}declined: no stated start time, which Luma's external ` +
          "form would publish as 7pm",
      );
    } else if (failure) {
      lines.push(
        `  ${" ".repeat(7)}last attempt failed (${failure.attempts}x): ${failure.message}`,
      );
    }
    lines.push("");
  };

  if (auto.length) {
    lines.push(`${auto.length} will be added automatically by the next sync:`, "");
    auto.forEach(describe);
  }
  if (manual.length) {
    lines.push(
      `${manual.length} will be added through Luma's Add External Event form:`,
      "",
    );
    manual.forEach(describe);
  }
  if (declined.length) {
    lines.push(
      `${declined.length} declined on purpose: no source stated a start time, and`,
      "Luma's external-event form has no all-day option and fills in 7pm. These are",
      "on the site and in the ICS feed. Set syncTimeUnknownExternals to add them",
      "anyway, with the title carrying the caveat:",
      "",
    );
    declined.forEach(describe);
  }
  lines.push(
    auto.length
      ? "Luma URLs go in via the calendar's Add Event button; the rest need Add External Event."
      : "These need the calendar's Add External Event form.",
  );
  return lines.join("\n");
}
