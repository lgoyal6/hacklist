// Git merge driver for the generated data files that have two writers.
//
// Most of data/ has a single author, but five files are written both by the
// GitHub sweep and by the nightly local pass:
//
//   data/linkedin-seeds.json      search from a datacenter vs a residential IP
//   data/personalized-seeds.json  committed alongside it by the local pass
//   data/luma-api.json            same
//   data/luma-ledger.json         the calendar mirror runs in CI and locally
//   data/luma-tags.json           same
//
// Two writers plus a shared branch means the local pass's push is rejected
// whenever a sweep landed first, so it rebases, and git tries to reconcile
// generated JSON as English prose. For an accumulating list of URLs that
// conflicts essentially every time. It did: the local pass failed to push on
// five of six nights (Aug 14, 15, 16, 18, 19), aborting the rebase each time
// and leaving the seeds committed but stranded. Nothing hard-failed, so the
// only signal was `luma-api: last collected 60h ago` sliding down a list of
// warnings, and three nights of residential-IP collection sat unpushed.
//
// Text-merging these files was never the right operation. They are run metadata
// plus keyed collections that accumulate, so the correct reconciliation is a
// union: keep every record either side discovered, and let the fresher run win
// on the scalars that describe a run. That is what this does.
//
// Git calls it as: merge-seeds.mjs %O %A %B
//   %O  common ancestor   (deliberately unused, see `deletions` below)
//   %A  ours,   during a rebase the branch being replayed onto
//   %B  theirs, the commit being replayed
// The result goes to %A. Exit 0 means resolved; non-zero leaves git to mark a
// normal conflict, which is the right outcome for anything we cannot parse.
//
// Which side is "ours" flips between a merge and a rebase, so nothing here
// depends on it: freshness is decided by the timestamp inside the file.
//
// deletions: a union cannot honour one. If a seed is dropped from one side it
// comes back from the other, and a list that both sides cap can land a few
// entries over it until the next write re-applies the cap. That is the safe
// direction to be wrong in: a stale seed costs one crawl of a URL that is
// re-checked anyway, whereas losing a discovered event is unrecoverable, and
// personalized-seeds.json exists nowhere but that one Mac.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** When this side was written, for deciding which run's scalars survive. */
function stamp(value) {
  for (const key of ["collectedAt", "updatedAt"]) {
    const parsed = Date.parse(value?.[key] ?? "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stable identity of a record, or null if it has none.
 *
 * Every accumulating list in these files is a list of things addressed by URL;
 * the id/slug fallbacks are for the keyed maps that grow the same way.
 */
function identity(value) {
  if (!isPlainObject(value)) return null;
  for (const key of ["url", "id", "slug"]) {
    if (typeof value[key] === "string" && value[key]) return `${key} ${value[key]}`;
  }
  return null;
}

/**
 * Does this array accumulate, or does it describe the run that wrote it?
 *
 * The test is whether every element is addressable. `urls`, `candidates` and
 * `enrichment` entries are, so they union. `problems`, `searchProviders` and
 * `calendarSeeds` are not; each writer regenerates them from its own run, so
 * unioning would pile up one run's errors on another's forever. Note that an
 * empty array passes: that is deliberate, so a side that has collected nothing
 * yet contributes nothing instead of erasing the side that has.
 */
function isRecordList(value) {
  return Array.isArray(value) && value.every((item) => identity(item) !== null);
}

/** Union two record lists: older order first, newer merged over its match. */
function unionRecords(older, newer) {
  const merged = new Map();
  for (const item of older) merged.set(identity(item), item);
  for (const item of newer) {
    const key = identity(item);
    merged.set(key, merged.has(key) ? mergeValue(merged.get(key), item) : item);
  }
  return [...merged.values()];
}

/**
 * Merge one value, with `newer` winning anything that is not a union.
 *
 * Key order follows `older` so the committed diff stays readable: fields keep
 * their positions and only genuinely new ones are appended.
 */
function mergeValue(older, newer) {
  if (Array.isArray(older) && Array.isArray(newer)) {
    return isRecordList(older) && isRecordList(newer)
      ? unionRecords(older, newer)
      : newer;
  }
  if (isPlainObject(older) && isPlainObject(newer)) {
    const merged = { ...older };
    for (const [key, value] of Object.entries(newer)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }
  return newer;
}

/**
 * Reconcile the two sides of a conflicted generated file.
 *
 * Exported for the test; the CLI below is a thin wrapper so the semantics can
 * be checked without staging a real git conflict.
 */
export function mergeSeeds(ours, theirs) {
  const oursStamp = stamp(ours);
  const theirsStamp = stamp(theirs);
  // Ties and missing timestamps resolve to ours, so the result is deterministic
  // rather than dependent on which way round git happened to call us.
  const theirsIsNewer =
    Number.isFinite(theirsStamp) &&
    (!Number.isFinite(oursStamp) || theirsStamp > oursStamp);
  return theirsIsNewer ? mergeValue(ours, theirs) : mergeValue(theirs, ours);
}

/** Parse a side, or null when it is unreadable, which hands git the conflict. */
function readSide(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`merge-seeds: cannot parse ${label} (${path}): ${error.message}`);
    return null;
  }
}

function main() {
  // argv[2] is %O, the common ancestor, unused for the reason given above.
  const [oursPath, theirsPath] = process.argv.slice(3);
  if (!oursPath || !theirsPath) {
    console.error("merge-seeds: usage: merge-seeds.mjs %O %A %B");
    return 2;
  }

  const ours = readSide(oursPath, "ours");
  const theirs = readSide(theirsPath, "theirs");
  // Refusing is the safe failure: git falls back to marking a normal conflict
  // rather than letting us write a guess over somebody's data.
  if (!isPlainObject(ours) || !isPlainObject(theirs)) {
    console.error("merge-seeds: leaving this one to git");
    return 1;
  }

  // Match how the writers format these files, so a merge does not show up as a
  // whole-file rewrite in the next diff.
  const newline = readFileSync(oursPath, "utf8").endsWith("\n") ? "\n" : "";
  writeFileSync(
    oursPath,
    `${JSON.stringify(mergeSeeds(ours, theirs), null, 2)}${newline}`,
  );
  console.error(`merge-seeds: unioned ${oursPath}`);
  return 0;
}

// Only when git runs it: the test imports mergeSeeds directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
