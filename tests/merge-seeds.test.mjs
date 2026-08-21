// Tests for the union merge driver on the generated data files.
//
// The failure it exists to prevent is silent in both directions, which is why
// it is tested rather than eyeballed: merge too eagerly and a run's errors and
// counts pile up on another's, merge too timidly and a night of residential-IP
// seeds is thrown away by the side that happens to be newer. Neither shows up
// as a broken build, only as a board that quietly stops finding events.
import assert from "node:assert/strict";
import test from "node:test";

import { mergeSeeds } from "../scripts/merge-seeds.mjs";

const seed = (url, over = {}) => ({ url, promising: true, ...over });
const CI = "2026-08-19T15:30:00.000Z";
const LOCAL = "2026-08-20T03:30:00.000Z";

test("keeps the seeds only one side found", () => {
  const ci = { collectedAt: CI, urls: [seed("a"), seed("b")] };
  const local = { collectedAt: LOCAL, urls: [seed("b"), seed("c")] };
  const merged = mergeSeeds(ci, local);
  assert.deepEqual(
    merged.urls.map((u) => u.url),
    ["a", "b", "c"],
    "the union, in the older side's order with new entries appended",
  );
});

test("unions the same way whichever side git calls ours", () => {
  const ci = { collectedAt: CI, urls: [seed("a")] };
  const local = { collectedAt: LOCAL, urls: [seed("z")] };
  // Rebase and merge hand these over in opposite orders; freshness is decided
  // by the timestamp inside the file precisely so the result cannot depend on it.
  assert.deepEqual(mergeSeeds(ci, local), mergeSeeds(local, ci));
});

test("the fresher run wins the fields that describe a run", () => {
  const ci = { collectedAt: CI, queriesRun: 3, pagesRead: 12, urls: [] };
  const local = { collectedAt: LOCAL, queriesRun: 2, pagesRead: 20, urls: [] };
  const merged = mergeSeeds(ci, local);
  assert.equal(merged.collectedAt, LOCAL);
  assert.equal(merged.queriesRun, 2);
  assert.equal(merged.pagesRead, 20);
});

test("one run's problems do not accumulate onto another's", () => {
  // These lists are regenerated per run, so unioning them would report an error
  // that has already been fixed. This is the check that failed the first draft.
  const ci = { collectedAt: CI, problems: [{ stage: "index", error: "403" }] };
  const local = { collectedAt: LOCAL, problems: [] };
  assert.deepEqual(mergeSeeds(ci, local).problems, []);
  assert.deepEqual(mergeSeeds(local, ci).problems, []);
});

test("an empty list never erases the side that has collected something", () => {
  // A blocked run writes `urls: []`. If that side is newer, taking it wholesale
  // would drop every seed the other side holds.
  const collected = { collectedAt: CI, urls: [seed("a"), seed("b")] };
  const blocked = { collectedAt: LOCAL, urls: [] };
  assert.deepEqual(mergeSeeds(collected, blocked).urls.map((u) => u.url), ["a", "b"]);
});

test("merges the record itself when both sides found the same URL", () => {
  const older = {
    collectedAt: CI,
    urls: [seed("a", { context: "from linkedin", promising: false })],
  };
  const newer = { collectedAt: LOCAL, urls: [seed("a", { promising: true })] };
  const [record] = mergeSeeds(older, newer).urls;
  assert.equal(record.promising, true, "the fresher judgement wins");
  assert.equal(record.context, "from linkedin", "and nothing else is lost");
});

test("unions the keyed maps the ledger and the feed accumulate", () => {
  const older = {
    updatedAt: CI,
    synced: { one: { at: CI }, two: { at: CI } },
    enrichment: { "https://luma.com/x": { guests: 40 } },
  };
  const newer = {
    updatedAt: LOCAL,
    synced: { two: { at: LOCAL }, three: { at: LOCAL } },
    enrichment: { "https://luma.com/y": { guests: 10 } },
  };
  const merged = mergeSeeds(older, newer);
  assert.deepEqual(Object.keys(merged.synced), ["one", "two", "three"]);
  assert.equal(merged.synced.two.at, LOCAL, "the fresher entry wins a collision");
  assert.deepEqual(Object.keys(merged.enrichment), [
    "https://luma.com/x",
    "https://luma.com/y",
  ]);
});

test("resolves deterministically when neither side has a usable timestamp", () => {
  const a = { urls: [seed("a")] };
  const b = { urls: [seed("b")] };
  assert.deepEqual(mergeSeeds(a, b), mergeSeeds(a, b));
  assert.deepEqual(mergeSeeds(a, b).urls.map((u) => u.url), ["b", "a"]);
});
