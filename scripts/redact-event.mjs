#!/usr/bin/env node
// Delete or redact one published event, everywhere it exists.
//
//   node scripts/redact-event.mjs --url https://luma.com/abc123 --reason "duplicate"
//   node scripts/redact-event.mjs --url https://... --redact organizer,venue --reason "..."
//
// A deletion that only edits data/events.json is not a deletion. The board is
// rebuilt from that file, so the site and the ICS feed do follow it, but two
// other things do not:
//
//   - the **sync ledger**, data/luma-ledger.json, which remembers that the
//     event was pushed to the public Luma calendar. Leaving the entry there
//     means the calendar keeps showing the event and nothing will ever retry or
//     reconcile it, because the ledger says it is done.
//   - the **next sweep**, which finds the same page and republishes the record.
//
// So this writes a tombstone first, then removes the record from the board and
// from the ledger. The tombstone is what the publisher reads on every run.
//
// It does not touch data/history/. Those snapshots are the record of what the
// board said at a past time; rewriting them would make the change log lie about
// its own past. See the retention note in the README.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contentHash } from "./lib/provenance.mjs";
import {
  TOMBSTONE_FILE,
  readTombstonesStrict,
  writeTombstones,
} from "./lib/tombstones.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const url = arg("url");
const reason = arg("reason");
const redactFields = arg("redact");

if (!url || !reason) {
  console.error(
    "usage: redact-event.mjs --url <url> --reason <text> [--redact field,field]\n" +
      "  --reason is required: a deletion with no recorded reason cannot be " +
      "reviewed later.",
  );
  process.exit(2);
}

const action = redactFields ? "redact" : "delete";
const fields = redactFields ? redactFields.split(",").map((f) => f.trim()) : [];

// --- the board (what the site and the ICS feed are built from) -------------
const eventsPath = resolve(root, "data/events.json");
const board = JSON.parse(await readFile(eventsPath, "utf8"));
const target = board.events.find((event) => event.url === url);
if (!target) {
  console.error(`No published event with url ${url}. Nothing to do.`);
  process.exit(1);
}

// --- the tombstone --------------------------------------------------------
//
// Written before anything is removed. If the process dies here the record is
// still published and the next run deletes it; the other order would delete it
// once and let the next sweep bring it back.
const tombstonePath = resolve(root, TOMBSTONE_FILE);
const tombstones = await readTombstonesStrict(tombstonePath);
const existing = tombstones.findIndex((t) => t.url === url);
const tombstone = {
  url,
  id: target.id,
  action,
  fields,
  reason,
  redactedAt: new Date().toISOString(),
  // The hash of what was removed, so the deletion can be audited without
  // keeping the deleted content. It identifies the record; it does not
  // reconstruct it.
  contentSha256: target.provenance?.contentSha256 ?? contentHash(target),
};
if (existing === -1) tombstones.push(tombstone);
else tombstones[existing] = tombstone;
await writeTombstones(tombstonePath, tombstones);

// --- remove from the board ------------------------------------------------
const REDACTED = "[redacted]";
if (action === "delete") {
  board.events = board.events.filter((event) => event.url !== url);
} else {
  for (const event of board.events) {
    if (event.url !== url) continue;
    for (const field of fields) event[field] = REDACTED;
    event.redacted = fields;
  }
}
board.meta.publishedCount = board.events.length;
board.meta.hackathonCount = board.events.filter(
  (event) => event.category === "hackathon",
).length;
board.meta.adjacentCount = board.events.filter(
  (event) => event.category === "adjacent",
).length;
await writeFile(eventsPath, `${JSON.stringify(board, null, 2)}\n`);

// --- remove from the sync ledger ------------------------------------------
//
// Only for a deletion. A redaction leaves a real event on the calendar; the
// ledger entry stays true and removing it would make the next sync offer the
// event a second time.
const ledgerPath = resolve(root, "data/luma-ledger.json");
let ledgerHits = 0;
if (action === "delete") {
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    for (const map of ["synced", "submitted", "failures"]) {
      if (ledger[map] && Object.hasOwn(ledger[map], target.id)) {
        delete ledger[map][target.id];
        ledgerHits += 1;
      }
    }
    if (ledgerHits) {
      await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(
  `${action}d ${url}\n` +
    `  tombstone: ${TOMBSTONE_FILE} (${tombstones.length} total)\n` +
    `  board:     data/events.json now publishes ${board.events.length} event(s)\n` +
    `  ledger:    ${ledgerHits} entr${ledgerHits === 1 ? "y" : "ies"} removed\n` +
    (action === "delete"
      ? "  calendar:  the Luma calendar still holds this event; the ledger no " +
        "longer claims it is synced, so it is visible to reconciliation. " +
        "Removing it from Luma itself is a manual step.\n"
      : ""),
);
