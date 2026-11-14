// Deletions that survive the next sweep.
//
// Removing an event from data/events.json deletes nothing. The sweep runs twice
// a day, finds the same page, and republishes it; the record is back within
// twelve hours. A deletion has to be a fact the pipeline reads, not an absence
// it will refill, so it is recorded as a tombstone and applied on every run.
//
// Two kinds, because they answer different requests:
//
//   - **delete** drops the event entirely. Used when the record should not
//     exist: a duplicate, or something listed in error.
//   - **redact** keeps the row and blanks the named fields. Used when the event
//     is real and public but one field must go, and where removing the whole
//     row would silently change a count someone is relying on.
//
// The tombstone stores the content hash of what was removed. That is what makes
// the deletion auditable later without keeping the deleted content around: you
// can prove a given record was the one tombstoned, and you cannot reconstruct
// it from the tombstone.

import { readFile, writeFile } from "node:fs/promises";

export const TOMBSTONE_FILE = "data/tombstones.json";

/** Values a redaction writes in place of the removed field. */
const REDACTED = "[redacted]";

export async function readTombstones(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed.tombstones) ? parsed.tombstones : [];
  } catch {
    // No file yet means nothing has been deleted. An unreadable file is the
    // same shape of answer and would be a bad reason to fail a sweep, but it
    // must not be silent: a corrupted tombstone file republishing deleted
    // records is the failure this module exists to prevent.
    return [];
  }
}

/**
 * Strict read for callers that must not proceed on a guess.
 *
 * The publisher uses this one: publishing with an unreadable tombstone file
 * would resurrect every deleted record at once.
 */
export async function readTombstonesStrict(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.tombstones)) {
    throw new Error(`${path}: "tombstones" must be an array`);
  }
  return parsed.tombstones;
}

export async function writeTombstones(path, tombstones) {
  const ordered = [...tombstones].sort((a, b) => a.url.localeCompare(b.url));
  await writeFile(path, `${JSON.stringify({ tombstones: ordered }, null, 2)}\n`);
}

/** Index tombstones by the URL they apply to. A URL has at most one. */
export function index(tombstones) {
  return new Map(tombstones.map((t) => [t.url, t]));
}

/**
 * Apply tombstones to a list of events.
 *
 * Deletions drop the event. Redactions blank the named fields in place. An
 * event with no tombstone passes through untouched, by identity, so a caller
 * can tell whether anything was applied at all.
 */
export function apply(events, tombstones) {
  const byUrl = index(tombstones);
  if (byUrl.size === 0) return { events, deleted: [], redacted: [] };
  const deleted = [];
  const redacted = [];
  const kept = [];
  for (const event of events) {
    const tombstone = byUrl.get(event.url);
    if (!tombstone) {
      kept.push(event);
      continue;
    }
    if (tombstone.action === "redact") {
      const copy = { ...event };
      for (const field of tombstone.fields ?? []) copy[field] = REDACTED;
      copy.redacted = tombstone.fields ?? [];
      kept.push(copy);
      redacted.push(event.url);
      continue;
    }
    deleted.push(event.url);
  }
  return { events: kept, deleted, redacted };
}

/** True when this URL must not be published at all. */
export function isDeleted(tombstones, url) {
  const tombstone = index(tombstones).get(url);
  return Boolean(tombstone) && tombstone.action !== "redact";
}
