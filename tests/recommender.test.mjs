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
import {
  EVENT_FIELDS,
  FEED_EVENT_ID,
  LOCALES,
  MAX_BATCH,
  MAX_BODY_BYTES,
  ORGANIC_SOURCE,
  fromQueryRow,
  toDataPoint,
  validateBatch,
  validateEvent,
} from "../app/telemetry-schema.mjs";
import {
  EVENTS_PATH,
  handleEventsRequest,
  nullSink,
  sinkFor,
} from "../worker/events-endpoint.mjs";
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

// --- what may be logged ---

const NOW = 1789000000000;

/** A row that must always be accepted, so a rejection test proves one thing. */
const goodEvent = (overrides = {}) => ({
  type: "impression",
  ts: NOW - 1000,
  client_id: "AbCdEfGhIjKlMnOpQr",
  session_id: "ZyXwVuTsRqPoNmLkJi",
  locale: "en",
  event_id: "coreweavehacks",
  position: 3,
  ranking: "production",
  model_version: null,
  viewport: "wide",
  source: "web",
  ...overrides,
});

const post = (body, init = {}) =>
  new Request(`http://localhost${EVENTS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

test("the schema accepts a well-formed row", () => {
  const result = validateEvent(goodEvent(), { now: NOW });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Object.keys(result.event).sort(), [...EVENT_FIELDS].sort());
});

test("the schema is a closed list, so an unknown field is a rejection", () => {
  for (const extra of ["referrer", "screen", "notes", "utm_source"]) {
    const result = validateEvent(goodEvent({ [extra]: "x" }), { now: NOW });
    assert.equal(result.ok, false, `${extra} was accepted`);
    assert.match(result.reason, /unknown field|personal field/);
  }
});

test("a field that looks like personal data is refused by name", () => {
  const named = {
    ip: "203.0.113.4",
    email: "someone@example.com",
    userAgent: "Mozilla/5.0",
    user_agent: "Mozilla/5.0",
    name: "A Person",
    referer: "https://example.com/",
    cookie: "session=1",
    city: "San Francisco",
    latitude: "37.77",
    fingerprint: "abc123",
  };
  for (const [field, value] of Object.entries(named)) {
    const result = validateEvent(goodEvent({ [field]: value }), { now: NOW });
    assert.equal(result.ok, false, `${field} was accepted`);
    assert.match(
      result.reason,
      /rejected personal field/,
      `${field} was refused, but not as personal data: ${result.reason}`,
    );
  }
});

test("no field of the schema is optional, and none of them is a person", () => {
  for (const field of EVENT_FIELDS) {
    const row = goodEvent();
    delete row[field];
    const result = validateEvent(row, { now: NOW });
    assert.equal(result.ok, false, `${field} may be omitted`);
    assert.match(result.reason, new RegExp(`missing field: ${field}`));
  }
  // The list itself is the privacy guarantee, so it is asserted, not described.
  assert.deepEqual(
    [...EVENT_FIELDS],
    [
      "type",
      "ts",
      "client_id",
      "session_id",
      "locale",
      "event_id",
      "position",
      "ranking",
      "model_version",
      "viewport",
      "source",
    ],
  );
});

test("every value is checked, not just its presence", () => {
  const bad = [
    ["type", "pageview"],
    ["ts", "yesterday"],
    ["ts", NOW + 3600000],
    ["ts", 12],
    ["client_id", "short"],
    ["client_id", "has spaces in it here"],
    ["session_id", ""],
    ["locale", "de"],
    ["event_id", "a".repeat(200)],
    ["position", -1],
    ["position", 1.5],
    ["position", 5000],
    ["ranking", "winner"],
    ["model_version", "has spaces"],
    ["viewport", "medium"],
    ["source", "prod"],
  ];
  for (const [field, value] of bad) {
    const result = validateEvent(goodEvent({ [field]: value }), { now: NOW });
    assert.equal(result.ok, false, `${field}=${String(value)} was accepted`);
  }
});

test("a save is about the feed, and says so rather than naming an event", () => {
  const result = validateEvent(
    goodEvent({ type: "save", event_id: FEED_EVENT_ID, ranking: "none", position: 0 }),
    { now: NOW },
  );
  assert.equal(result.ok, true, result.reason);
});

test("the schema's locales are the board's locales", async () => {
  const source = await readFile(
    new URL("../app/i18n/index.ts", import.meta.url),
    "utf8",
  );
  const declared = source.match(/export const LOCALES = \[([^\]]+)\]/)[1];
  const parsed = [...declared.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...LOCALES], parsed);
});

test("a batch is capped, and only 'events' may be at the top level", () => {
  const many = { events: Array.from({ length: MAX_BATCH + 1 }, () => goodEvent()) };
  const capped = validateBatch(many, { now: NOW });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /exceeds the cap/);

  assert.equal(validateBatch({ events: [] }, { now: NOW }).ok, false);
  assert.equal(
    validateBatch({ events: [goodEvent()], meta: {} }, { now: NOW }).ok,
    false,
  );
  assert.equal(validateBatch([goodEvent()], { now: NOW }).ok, false);
  assert.equal(
    validateBatch({ events: Array.from({ length: MAX_BATCH }, () => goodEvent()) }, { now: NOW }).ok,
    true,
  );
});

test("the endpoint answers 204 and writes one data point per event", async () => {
  const written = [];
  const response = await handleEventsRequest(
    post({ events: [goodEvent(), goodEvent({ type: "click", position: 0 })] }),
    {},
    { now: NOW, sink: { write: (point) => written.push(point) } },
  );
  assert.equal(response.status, 204);
  assert.equal(written.length, 2);
  assert.deepEqual(written[0].indexes, ["AbCdEfGhIjKlMnOpQr"]);
  assert.equal(written[0].blobs.length, 9);
  assert.equal(written[0].doubles.length, 2);
});

test("the endpoint refuses what it should refuse", async () => {
  const cases = [
    [new Request(`http://localhost${EVENTS_PATH}`), 405],
    [post("not json at all"), 400],
    [post({ events: [goodEvent({ ip: "203.0.113.4" })] }), 400],
    [post({ events: [{}] }), 400],
    [
      post(
        { events: [goodEvent()] },
        { headers: { "content-type": "text/html" } },
      ),
      415,
    ],
  ];
  for (const [request, status] of cases) {
    const response = await handleEventsRequest(request, {}, { now: NOW });
    assert.equal(response.status, status, await response.text());
  }
});

test("an oversized body is refused on its claim and again on its bytes", async () => {
  const lying = post(
    { events: [goodEvent()] },
    { headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) } },
  );
  assert.equal((await handleEventsRequest(lying, {}, { now: NOW })).status, 413);

  const actuallyHuge = post(`{"events":[${"0".repeat(MAX_BODY_BYTES + 10)}]}`);
  assert.equal(
    (await handleEventsRequest(actuallyHuge, {}, { now: NOW })).status,
    413,
  );
});

test("no binding means no storage and still a 204, with no flag in between", async () => {
  assert.equal(sinkFor(undefined), nullSink);
  assert.equal(sinkFor({}), nullSink);
  assert.equal(sinkFor({ EVENTS: {} }), nullSink);
  assert.equal(sinkFor({ EVENTS: { writeDataPoint() {} } }).kind, "analytics-engine");

  const response = await handleEventsRequest(post({ events: [goodEvent()] }), {}, { now: NOW });
  assert.equal(response.status, 204);
});

test("a data point survives the round trip through the SQL API's column names", () => {
  const event = goodEvent({ type: "click", model_version: "syn-1", source: ORGANIC_SOURCE });
  const point = toDataPoint(event);
  const row = { index1: point.indexes[0] };
  point.blobs.forEach((value, i) => {
    row[`blob${i + 1}`] = value;
  });
  point.doubles.forEach((value, i) => {
    row[`double${i + 1}`] = value;
  });
  assert.deepEqual(fromQueryRow(row), event);

  // And a model_version of null round-trips as null, not as the empty string.
  const anonymous = goodEvent();
  const blank = toDataPoint(anonymous);
  const blankRow = {};
  blank.blobs.forEach((value, i) => {
    blankRow[`blob${i + 1}`] = value;
  });
  blank.doubles.forEach((value, i) => {
    blankRow[`double${i + 1}`] = value;
  });
  assert.equal(fromQueryRow(blankRow).model_version, null);
});

test("the built Worker serves the endpoint, and stores through the binding", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `events-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const written = [];
  const env = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    EVENTS: { writeDataPoint: (point) => written.push(point) },
  };

  const ok = await worker.fetch(post({ events: [goodEvent({ ts: Date.now() })] }), env, ctx);
  assert.equal(ok.status, 204);
  assert.equal(written.length, 1);

  const refused = await worker.fetch(
    post({ events: [goodEvent({ ts: Date.now(), email: "a@b.co" })] }),
    env,
    ctx,
  );
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /rejected personal field: email/);
  assert.equal(written.length, 1, "a refused batch still wrote something");
});
