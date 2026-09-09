// The recommender's contract, in tests.
//
// Runs inside test:artifact: no browser, no network, and the whole file is
// milliseconds, because that gate stands between a correct board and its
// deploy and must never be the reason a board is withheld.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOARD_DEFAULT_VIEW,
  boardVisible,
  productionOrder,
  productionOrderIds,
} from "../app/ranking.mjs";
import { buildManifest } from "../scripts/recommender-freeze.mjs";

const data = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(
    new URL("../results/recommender-manifest.json", import.meta.url),
    "utf8",
  ),
);
const frozenAsOf = Date.parse(manifest.production_ordering.as_of);

// --- the frozen ordering ---

test("the frozen snapshot is what productionOrder returns on the committed board", () => {
  assert.deepEqual(
    productionOrderIds(data, { asOf: frozenAsOf }),
    manifest.production_ordering.snapshot,
    "the production ordering moved after the manifest was frozen; that is a new experiment, not an edit to this one",
  );
});

test("the manifest still describes the committed board", async () => {
  const rebuilt = await buildManifest();
  assert.equal(
    rebuilt.production_ordering.events_file_sha256,
    manifest.production_ordering.events_file_sha256,
    "data/events.json changed under a frozen manifest",
  );
  assert.equal(
    rebuilt.production_ordering.snapshot_sha256,
    manifest.production_ordering.snapshot_sha256,
  );
  assert.deepEqual(rebuilt.features.names, manifest.features.names);
});

test("the snapshot is the default region's hackathons and nothing else", () => {
  const ids = new Set(manifest.production_ordering.snapshot);
  const defaultRegion = data.meta.defaultRegion;
  for (const event of data.events) {
    if (!ids.has(event.id)) continue;
    assert.equal(event.category, "hackathon", `${event.id} is not a hackathon`);
    assert.equal(
      event.region ?? defaultRegion,
      defaultRegion,
      `${event.id} is not in the default region`,
    );
  }
});

test("the ordering is chronological, with ties left in the data file's order", () => {
  const ordered = productionOrder(data, { asOf: frozenAsOf });
  const position = new Map(data.events.map((event, index) => [event.id, index]));
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1].start ?? "9999";
    const current = ordered[i].start ?? "9999";
    const compared = previous.localeCompare(current);
    assert.ok(compared <= 0, `${ordered[i].id} sorts before ${ordered[i - 1].id}`);
    if (compared === 0) {
      assert.ok(
        position.get(ordered[i - 1].id) < position.get(ordered[i].id),
        `a start-date tie between ${ordered[i - 1].id} and ${ordered[i].id} did not keep the data file's order`,
      );
    }
  }
});

test("a later render drops finished events and reorders nothing", () => {
  // The board's list depends on the render instant. What must not depend on it
  // is the ORDER: a render an hour later, or a year later, is the frozen
  // sequence with some prefix of finished events removed. That is what makes
  // one committed snapshot a fair description of every future first paint.
  for (const shiftDays of [0.5, 7, 400]) {
    const later = productionOrderIds(data, {
      asOf: frozenAsOf + shiftDays * 86400000,
    });
    const frozen = manifest.production_ordering.snapshot;
    let cursor = 0;
    for (const id of later) {
      const found = frozen.indexOf(id, cursor);
      assert.ok(
        found >= 0,
        `${id} appears ${shiftDays} days later but is not in the frozen order at or after position ${cursor}`,
      );
      cursor = found + 1;
    }
  }
});

test("boardVisible is what the views and the search actually filter with", () => {
  const region = data.meta.regions.find(
    (entry) => entry.key === data.meta.defaultRegion,
  );
  const call = (overrides) =>
    boardVisible(data.events, {
      regionKey: region.key,
      coreArea: region.coreArea,
      defaultRegion: data.meta.defaultRegion,
      view: BOARD_DEFAULT_VIEW,
      query: "",
      asOf: frozenAsOf,
      ...overrides,
    });

  const everything = call({ view: "everything" });
  const hackathons = call({});
  assert.ok(
    everything.length >= hackathons.length,
    "the Everything view shows fewer events than the Hackathons view",
  );
  assert.ok(
    call({ view: "open" }).every((event) =>
      ["Open", "Approval"].includes(event.status),
    ),
  );
  assert.ok(call({ view: "prizes" }).every((event) => event.prize.includes("$")));
  assert.ok(
    call({ view: "city" }).every((event) => event.area === region.coreArea),
  );
  const needle = hackathons[0].title.slice(0, 8).toLowerCase();
  assert.ok(
    call({ query: needle }).length > 0,
    "searching for an event's own title finds nothing",
  );
  assert.equal(call({ query: "zzz-nothing-matches-this" }).length, 0);
});

// --- the page renders that ordering ---

test("the server-rendered board is the frozen ordering, minus what has finished", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();

  // The order the page actually printed, read back off the listing.
  const byUrl = new Map(data.events.map((event) => [event.url, event.id]));
  const rendered = [
    ...html.matchAll(/<h4><a href="([^"]+)" target="_blank"/g),
  ]
    .map((match) => byUrl.get(match[1].replaceAll("&amp;", "&")))
    .filter(Boolean);
  assert.ok(rendered.length > 0, "no event links found in the rendered board");

  const frozen = manifest.production_ordering.snapshot;
  let cursor = 0;
  for (const id of rendered) {
    const found = frozen.indexOf(id, cursor);
    assert.ok(
      found >= 0,
      `the page rendered ${id} out of the frozen production order`,
    );
    cursor = found + 1;
  }
});
