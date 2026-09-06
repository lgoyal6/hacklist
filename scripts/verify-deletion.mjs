#!/usr/bin/env node
// Prove a deletion actually happened, on all three surfaces, separately.
//
//   node scripts/verify-deletion.mjs
//
// A record removed from data/events.json has not been deleted. It is still in
// the rendered board, still in the ICS feed subscribers have on their phones,
// and still claimed as synced by the ledger that drives the public Luma
// calendar. So this checks each surface on its own terms rather than checking
// the file the other three are built from:
//
//   index    the rendered board HTML, fetched from the built worker
//   export   the /calendar.ics feed, fetched from the same worker
//   cache    data/luma-ledger.json, the synced/submitted/failures maps
//
// and then the part that makes it a deletion rather than an edit: it re-runs
// the normalizer against the unchanged inputs and checks the record does not
// come back.
//
// Everything is restored at the end, including the history snapshot the
// normalizer writes.

import { spawnSync } from "node:child_process";
import { readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBuilt } from "./lib/fetch-built.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historyDir = resolve(root, "data/history");

const FILES = [
  "data/events.json",
  "data/luma-ledger.json",
  "data/tombstones.json",
  "data/changes.json",
];

const results = [];
function check(surface, phase, expected, actual, detail) {
  const ok = expected === actual;
  results.push({ surface, phase, expected, actual, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${surface.padEnd(8)} ${phase.padEnd(7)} ` +
      `expected=${String(expected).padEnd(7)} actual=${String(actual).padEnd(7)} ${detail ?? ""}`,
  );
  return ok;
}

function run(args) {
  const out = spawnSync("node", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) {
    console.error(out.stdout, out.stderr);
    throw new Error(`${args.join(" ")} exited ${out.status}`);
  }
  return out.stdout;
}

function build() {
  const out = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) {
    console.error(out.stdout, out.stderr);
    throw new Error("build failed");
  }
}

async function ledgerHolds(id) {
  try {
    const ledger = JSON.parse(
      await readFile(resolve(root, "data/luma-ledger.json"), "utf8"),
    );
    return ["synced", "submitted", "failures"].some((map) =>
      Object.hasOwn(ledger[map] ?? {}, id),
    );
  } catch {
    return false;
  }
}

// --- back up ---------------------------------------------------------------
const backups = new Map();
for (const file of FILES) {
  try {
    backups.set(file, await readFile(resolve(root, file), "utf8"));
  } catch {
    backups.set(file, null); // absent; restore by deleting
  }
}
// The normalizer rewrites the snapshot for the current sweep, which already
// exists. Recording only the file *names* would leave that one modified, so the
// contents are held too.
const historyBefore = new Map();
for (const name of await readdir(historyDir)) {
  historyBefore.set(name, await readFile(resolve(historyDir, name), "utf8"));
}

let failed = 0;
try {
  // --- pick a target -------------------------------------------------------
  //
  // It must be present on all three surfaces, or "it is gone afterwards" would
  // prove nothing. So: published, dated (the ICS skips undated events), and
  // already claimed by the ledger.
  const board = JSON.parse(
    await readFile(resolve(root, "data/events.json"), "utf8"),
  );
  const ledger = JSON.parse(
    await readFile(resolve(root, "data/luma-ledger.json"), "utf8"),
  );
  const target = board.events.find(
    (event) => event.start && Object.hasOwn(ledger.synced ?? {}, event.id),
  );
  if (!target) throw new Error("no published, dated, already-synced event to test with");
  console.log(`target: ${target.id}  ${target.url}\n        ${target.title}\n`);

  // --- before --------------------------------------------------------------
  build();
  let ics = fetchBuilt("/calendar.ics");
  let html = fetchBuilt("/");
  if (!check("export", "before", true, ics.includes(target.url), "/calendar.ics")) failed++;
  if (!check("index", "before", true, html.includes(target.url), "rendered board")) failed++;
  if (!check("cache", "before", true, await ledgerHolds(target.id), "luma-ledger.json")) failed++;

  // --- delete --------------------------------------------------------------
  console.log(
    `\n${run([
      "scripts/redact-event.mjs",
      "--url",
      target.url,
      "--reason",
      "verify-deletion.mjs proof run",
    ])}`,
  );

  // --- after ---------------------------------------------------------------
  build();
  ics = fetchBuilt("/calendar.ics");
  html = fetchBuilt("/");
  if (!check("export", "after", false, ics.includes(target.url), "/calendar.ics")) failed++;
  if (!check("index", "after", false, html.includes(target.url), "rendered board")) failed++;
  if (!check("cache", "after", false, await ledgerHolds(target.id), "luma-ledger.json")) failed++;

  // The feed must still be a feed. A deletion that empties the calendar would
  // pass every check above.
  const remaining = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  if (!check("export", "after", true, remaining > 0, `${remaining} other events still published`))
    failed++;

  // --- durability ----------------------------------------------------------
  //
  // The inputs still contain the candidate. Re-run the real normalizer and
  // check the tombstone holds.
  console.log("\nre-running the normalizer against unchanged inputs...");
  run(["scripts/normalize-events.mjs"]);
  const republished = JSON.parse(
    await readFile(resolve(root, "data/events.json"), "utf8"),
  );
  if (
    !check(
      "reingest",
      "after",
      false,
      republished.events.some((event) => event.url === target.url),
      `normalizer published ${republished.events.length} events`,
    )
  )
    failed++;
  if (
    !check(
      "reingest",
      "after",
      true,
      republished.events.length > 0,
      "the board is not simply empty",
    )
  )
    failed++;
} finally {
  // --- restore -------------------------------------------------------------
  for (const [file, content] of backups) {
    const path = resolve(root, file);
    if (content === null) await rm(path, { force: true });
    else await writeFile(path, content);
  }
  for (const name of await readdir(historyDir)) {
    const path = resolve(historyDir, name);
    if (!historyBefore.has(name)) await unlink(path);
    else if ((await readFile(path, "utf8")) !== historyBefore.get(name)) {
      await writeFile(path, historyBefore.get(name));
    }
  }
  console.log("\nrestored data/ to its previous state");
}

console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} checks passed`,
);
process.exit(failed === 0 ? 0 : 1);
