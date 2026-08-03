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
export function formatQueueReport(pending, ledger) {
  if (!pending.length) {
    return `All ${Object.keys(ledger.synced).length} published events are on the calendar. Nothing pending.`;
  }
  const lines = [
    `${pending.length} event${pending.length === 1 ? "" : "s"} pending for the Hacklist SF Luma calendar:`,
    "",
  ];
  for (const event of pending) {
    const failure = ledger.failures[event.id];
    lines.push(`  ${event.dateLabel.padEnd(7)}${event.title}`);
    lines.push(`  ${" ".repeat(7)}${event.url}`);
    if (failure) {
      lines.push(
        `  ${" ".repeat(7)}last attempt failed (${failure.attempts}x): ${failure.message}`,
      );
    }
    lines.push("");
  }
  lines.push("Add each URL via the calendar's Add Event button on Luma.");
  return lines.join("\n");
}
