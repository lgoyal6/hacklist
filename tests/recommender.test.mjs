// The recommender's contract, in tests.
//
// Runs inside test:artifact: no browser, no network, and the whole file is
// milliseconds, because that gate stands between a correct board and its
// deploy and must never be the reason a board is withheld.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fileURLToPath } from "node:url";

import {
  BOARD_DEFAULT_VIEW,
  FEATURE_NAMES,
  RANKING_TIME_EVENT_FIELDS,
  boardVisible,
  candidateOrder,
  draftSeed,
  extractFeatures,
  logLoss,
  productionOrder,
  productionOrderIds,
  rankedList,
  teamDraftInterleave,
  trainLogistic,
  validateModel,
} from "../app/ranking.mjs";
import { trainFromLog } from "../scripts/recommender-train.mjs";
import {
  buildQuery,
  fetchEvents,
} from "../scripts/recommender-export-events.mjs";
import {
  BLOB_COLUMNS,
  DOUBLE_COLUMNS,
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
import {
  groupRenders,
  organicCounts,
  readEventLog,
} from "../scripts/lib/recommender-log.mjs";
import { synthesize } from "../scripts/recommender-synthesize-events.mjs";

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
const FIXTURE = new URL(
  "./fixtures/recommender-synthetic-events.jsonl",
  import.meta.url,
);
const fixtureRows = await readEventLog(FIXTURE);
const ranker = JSON.parse(
  await readFile(new URL("../data/ranker.json", import.meta.url), "utf8"),
);

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

// --- the log, and the synthetic fixture that stands in for one ---

test("the committed fixture is a log the Worker would have accepted", async () => {
  const rows = await readEventLog(FIXTURE);
  assert.ok(rows.length > 1000, `only ${rows.length} rows in the fixture`);
  // readEventLog validates every row against the same schema the endpoint
  // enforces, so reaching here is the assertion. What is left to check is the
  // tagging, because the whole honesty of the evaluation rests on it.
  assert.ok(
    rows.every((row) => row.source === "synthetic"),
    "a fixture row is not tagged synthetic",
  );
  assert.equal(
    organicCounts(rows).impressions,
    0,
    "the synthetic fixture contributed organic impressions",
  );
  assert.equal(organicCounts(rows).interactions, 0);
  assert.equal(organicCounts(rows).clients, 0);
});

test("the fixture carries both a production-only period and a drafted one", () => {
  const renders = groupRenders(fixtureRows);
  const production = renders.filter((render) =>
    render.items.every((item) => item.ranking === "production"),
  );
  const drafted = renders.filter((render) =>
    render.items.some((item) => item.ranking === "candidate"),
  );
  assert.ok(production.length > 20, `only ${production.length} production renders`);
  assert.ok(drafted.length > 20, `only ${drafted.length} drafted renders`);
  // A drafted render must name the model that drafted it, and an undrafted one
  // must not claim a model it never had.
  assert.ok(drafted.every((render) => render.model_version !== null));
  assert.ok(
    renders
      .filter((render) => render.model_version === null)
      .every((render) => render.items.every((item) => item.ranking === "production")),
  );
});

test("a render is one list, split on a repeated rank or a long gap", () => {
  const base = {
    client_id: "AbCdEfGhIjKlMnOpQr",
    session_id: "ZyXwVuTsRqPoNmLkJi",
    locale: "en",
    ranking: "production",
    model_version: null,
    viewport: "wide",
    source: "seeded",
  };
  const impression = (ts, position, event_id) => ({
    ...base,
    type: "impression",
    ts,
    position,
    event_id,
  });
  const renders = groupRenders([
    impression(1_700_000_000_000, 0, "a"),
    impression(1_700_000_000_001, 1, "b"),
    // A repeated rank: one list cannot have two rows at rank 0.
    impression(1_700_000_000_002, 0, "c"),
    impression(1_700_000_000_003, 1, "d"),
    // And a long gap starts another, even with ranks that would have fitted.
    impression(1_700_000_060_000, 2, "e"),
    { ...base, type: "click", ts: 1_700_000_060_500, position: 2, event_id: "e" },
  ]);
  assert.equal(renders.length, 3);
  assert.deepEqual(
    renders.map((render) => render.items.map((item) => item.event_id)),
    [["a", "b"], ["c", "d"], ["e"]],
  );
  // The click belongs to the list that was on screen when it happened.
  assert.deepEqual([...renders[0].clicks.keys()], []);
  assert.deepEqual([...renders[2].clicks.keys()], ["e"]);
});

test("only web traffic is organic, and the rest is counted separately", () => {
  const base = {
    type: "impression",
    ts: 1_700_000_000_000,
    client_id: "AbCdEfGhIjKlMnOpQr",
    session_id: "ZyXwVuTsRqPoNmLkJi",
    locale: "en",
    event_id: "a",
    position: 0,
    ranking: "production",
    model_version: null,
    viewport: "wide",
  };
  const counts = organicCounts([
    { ...base, source: "web" },
    { ...base, source: "web", type: "click", client_id: "QqQqQqQqQqQqQqQqQq" },
    { ...base, source: "dev" },
    { ...base, source: "synthetic" },
    { ...base, source: "seeded" },
    { ...base, source: "replay" },
  ]);
  assert.equal(counts.impressions, 1);
  assert.equal(counts.interactions, 1);
  assert.equal(counts.clients, 2);
  assert.equal(counts.days, 1);
  assert.deepEqual(counts.excluded_rows_by_source, {
    dev: 1,
    synthetic: 1,
    seeded: 1,
    replay: 1,
  });
});

test("the synthesizer is a function of its seed", async () => {
  const small = { seed: 7, days: 4, people: 3, depth: 6 };
  const first = await synthesize(small);
  const second = await synthesize(small);
  assert.deepEqual(first.rows, second.rows);
  const different = await synthesize({ ...small, seed: 8 });
  assert.notDeepEqual(different.rows, first.rows);
});

// --- the ranker, the draft, and what happens without either ---

test("features read only the fields the manifest allows", () => {
  const event = data.events.find((entry) => entry.category === "hackathon");
  const context = {
    asOf: frozenAsOf,
    regionKey: data.meta.defaultRegion,
    defaultRegion: data.meta.defaultRegion,
  };
  const baseline = extractFeatures(event, context);
  assert.equal(baseline.length, FEATURE_NAMES.length);

  // Every field outside the allow-list is moved, including two planted ones
  // that look exactly like the future information a leak would reach for. If a
  // feature is reading any of them, the vector moves and this fails.
  const perturbed = { ...event, futureClicks: 999, clicksAfterImpression: 42 };
  for (const [key, value] of Object.entries(event)) {
    if (RANKING_TIME_EVENT_FIELDS.includes(key)) continue;
    if (typeof value === "string") perturbed[key] = `${value}-moved`;
    else if (typeof value === "number") perturbed[key] = value + 1234;
    else if (typeof value === "boolean") perturbed[key] = !value;
    else perturbed[key] = null;
  }
  assert.deepEqual(
    extractFeatures(perturbed, context),
    baseline,
    "a feature moved when a field it is not allowed to read moved",
  );

  // And a planted future feature is exactly what the detector must catch, so
  // the detection itself is checked here rather than assumed.
  const leaky = (row, ctx) => [...extractFeatures(row, ctx), row.futureClicks ?? 0];
  assert.notDeepEqual(
    leaky(perturbed, context),
    leaky(event, context),
    "a planted future field did not change a leaky extractor, so the perturbation proves nothing",
  );
});

test("the logistic ranker separates a separable set, and does it the same way twice", () => {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    const positive = i % 2 === 0;
    const features = new Array(FEATURE_NAMES.length).fill(0);
    features[0] = positive ? 1 : 0;
    features[1] = positive ? 0 : 1;
    rows.push({ features, label: positive ? 1 : 0, weight: 1 });
  }
  const first = trainLogistic(rows);
  const second = trainLogistic(rows);
  assert.deepEqual(first.weights, second.weights, "training is not deterministic");
  assert.equal(first.bias, second.bias);
  // Order must not matter either: the gradient sums over every row before it
  // steps, so a shuffled set is the same problem.
  const shuffled = trainLogistic([...rows].reverse());
  assert.deepEqual(shuffled.weights, first.weights);
  assert.ok(
    first.weights[0] > first.weights[1],
    "the feature that predicts a click did not outweigh the one that predicts none",
  );
  assert.ok(
    logLoss(rows, first) < 0.5,
    `log loss ${logLoss(rows, first)} on a separable set`,
  );
});

test("a model artifact is accepted only when it is a model for this board", () => {
  assert.ok(validateModel(ranker), "the committed artifact is not valid");
  assert.equal(validateModel(null), null);
  assert.equal(validateModel(undefined), null);
  assert.equal(validateModel({}), null);
  assert.equal(validateModel("a model, honestly"), null);
  assert.equal(validateModel({ ...ranker, model_version: "" }), null);
  assert.equal(validateModel({ ...ranker, bias: "high" }), null);
  assert.equal(validateModel({ ...ranker, weights: [1, 2] }), null);
  assert.equal(
    validateModel({ ...ranker, weights: ranker.weights.map(() => Number.NaN) }),
    null,
  );
  // A model trained on a different feature list is not a model for this board,
  // however well it scored wherever it came from.
  assert.equal(
    validateModel({
      ...ranker,
      feature_names: [...ranker.feature_names].reverse(),
    }),
    null,
  );
});

test("a team draft is a real interleaving: every item once, seeded, both teams", () => {
  const ordered = productionOrder(data, { asOf: frozenAsOf });
  const model = validateModel(ranker);
  const context = {
    asOf: frozenAsOf,
    regionKey: data.meta.defaultRegion,
    defaultRegion: data.meta.defaultRegion,
  };
  const candidate = candidateOrder(ordered, model, context);
  assert.deepEqual(
    [...candidate].map((event) => event.id).sort(),
    ordered.map((event) => event.id).sort(),
    "the candidate ordering is not a permutation of the same set",
  );

  const seeds = [1, 2, 3, 99, 20260909];
  let sawCandidateFirst = false;
  let sawProductionFirst = false;
  for (const seed of seeds) {
    const drafted = teamDraftInterleave(ordered, candidate, seed);
    assert.equal(drafted.length, ordered.length, "the draft lost or gained rows");
    const ids = drafted.map((entry) => entry.event.id);
    assert.equal(new Set(ids).size, ids.length, "an event was drafted twice");
    assert.deepEqual([...ids].sort(), ordered.map((event) => event.id).sort());
    assert.ok(drafted.every((entry) => ["production", "candidate"].includes(entry.team)));
    // Team sizes never differ by more than one: that is what makes a click a
    // fair vote rather than a reflection of who got more slots.
    const counts = { production: 0, candidate: 0 };
    for (const entry of drafted) {
      counts[entry.team] += 1;
      assert.ok(
        Math.abs(counts.production - counts.candidate) <= 1,
        `teams drifted to ${counts.production} versus ${counts.candidate}`,
      );
    }
    if (drafted[0].team === "candidate") sawCandidateFirst = true;
    if (drafted[0].team === "production") sawProductionFirst = true;

    // Same seed, same draft.
    assert.deepEqual(
      teamDraftInterleave(ordered, candidate, seed).map((entry) => entry.team),
      drafted.map((entry) => entry.team),
    );
  }
  assert.ok(
    sawCandidateFirst && sawProductionFirst,
    "the coin that decides who picks first never came down both ways",
  );
});

test("a draft is the same for one client on one day, and not across days", () => {
  const ordered = productionOrder(data, { asOf: frozenAsOf });
  const model = validateModel(ranker);
  const context = {
    asOf: frozenAsOf,
    regionKey: data.meta.defaultRegion,
    defaultRegion: data.meta.defaultRegion,
  };
  const candidate = candidateOrder(ordered, model, context);
  const draft = (client, day) =>
    teamDraftInterleave(ordered, candidate, draftSeed(client, day)).map(
      (entry) => `${entry.event.id}:${entry.team}`,
    );
  assert.deepEqual(
    draft("AbCdEfGhIjKlMnOpQr", "2026-09-09"),
    draft("AbCdEfGhIjKlMnOpQr", "2026-09-09"),
    "the same client saw two different drafts on the same day",
  );
  assert.notDeepEqual(
    draft("AbCdEfGhIjKlMnOpQr", "2026-09-09"),
    draft("AbCdEfGhIjKlMnOpQr", "2026-09-10"),
  );
  assert.notDeepEqual(
    draft("AbCdEfGhIjKlMnOpQr", "2026-09-09"),
    draft("ZyXwVuTsRqPoNmLkJi", "2026-09-09"),
  );
});

test("no client id and no artifact are the same answer: the production order", () => {
  const ordered = productionOrder(data, { asOf: frozenAsOf });
  const context = {
    asOf: frozenAsOf,
    regionKey: data.meta.defaultRegion,
    defaultRegion: data.meta.defaultRegion,
  };
  const expected = manifest.production_ordering.snapshot;

  // Cold start: a reader with no stored identity has no draft seed. On this
  // board that is also a reader with no history, because history is the
  // localStorage record.
  const cold = rankedList({
    visible: ordered,
    model: validateModel(ranker),
    clientId: null,
    dayKey: "2026-09-09",
    context,
  });
  assert.deepEqual(cold.rows.map((entry) => entry.event.id), expected);
  assert.ok(cold.rows.every((entry) => entry.team === "production"));
  assert.equal(cold.ordering, "production");
  assert.equal(cold.chronological, true);

  // Missing artifact: the build carries no model, so there is nothing to draft
  // against. Same rows, same order, and it says so rather than guessing.
  for (const absent of [null, undefined, {}, { model_version: "x" }]) {
    const fallback = rankedList({
      visible: ordered,
      model: validateModel(absent),
      clientId: "AbCdEfGhIjKlMnOpQr",
      dayKey: "2026-09-09",
      context,
    });
    assert.deepEqual(fallback.rows.map((entry) => entry.event.id), expected);
    assert.equal(fallback.ordering, "production");
    assert.equal(fallback.modelVersion, null);
  }

  // And with both, it really does draft, so the two branches above are not
  // passing because nothing ever interleaves.
  const drafted = rankedList({
    visible: ordered,
    model: validateModel(ranker),
    clientId: "AbCdEfGhIjKlMnOpQr",
    dayKey: "2026-09-09",
    context,
  });
  assert.equal(drafted.ordering, "interleaved");
  assert.equal(drafted.chronological, false);
  assert.ok(drafted.rows.some((entry) => entry.team === "candidate"));
  assert.notDeepEqual(drafted.rows.map((entry) => entry.event.id), expected);
});

test("the committed artifact says what it was trained on", () => {
  assert.match(ranker.model_version, /^syn-/, "a synthetic model is not marked syn-");
  assert.equal(ranker.log.organic_rows, 0);
  assert.deepEqual(Object.keys(ranker.log.rows_by_source), ["synthetic"]);
  assert.match(ranker.honesty, /synthetic/i);
  assert.match(ranker.position_bias.status, /assumed, not measured/);
});

test("training the committed artifact again produces the committed artifact", async () => {
  const { artifact } = await trainFromLog(fileURLToPath(FIXTURE));
  assert.deepEqual(artifact, ranker, "data/ranker.json is not what its own log trains");
});

// --- the export pass ---

test("the export asks the SQL API only for the columns the schema declares", () => {
  const query = buildQuery(30);
  assert.match(query, /FROM hacklist_events/);
  assert.match(query, /FORMAT JSON/);
  for (let i = 1; i <= BLOB_COLUMNS.length; i += 1) {
    assert.ok(query.includes(`blob${i}`), `blob${i} is not selected`);
  }
  // The SELECT list is exactly the declared columns and nothing else. Analytics
  // Engine also stores the index and a per-request _sample_interval, and the
  // dataset carries a timestamp; none of them is selected, so nothing outside
  // the eleven declared fields can reach a local file.
  const selected = query
    .slice("SELECT ".length, query.indexOf(" FROM "))
    .split(",")
    .map((column) => column.trim());
  assert.deepEqual(selected, [
    ...BLOB_COLUMNS.map((name, i) => `blob${i + 1}`),
    ...DOUBLE_COLUMNS.map((name, i) => `double${i + 1}`),
  ]);
});

test("the export validates on the way out as well as on the way in", async () => {
  const good = {
    blob1: "impression",
    blob2: "AbCdEfGhIjKlMnOpQr",
    blob3: "ZyXwVuTsRqPoNmLkJi",
    blob4: "en",
    blob5: "coreweavehacks",
    blob6: "candidate",
    blob7: "syn-1",
    blob8: "wide",
    blob9: "web",
    double1: 1789000000000,
    double2: 4,
  };
  // A row written by an older client than this checkout describes: kept in the
  // dataset for three months, and refused here rather than parsed hopefully.
  const stale = { ...good, blob1: "pageview" };
  const fetchImpl = async (url, init) => {
    assert.match(url, /analytics_engine\/sql$/);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer token-value");
    return new Response(JSON.stringify({ data: [good, stale] }), { status: 200 });
  };
  const { events, rejected } = await fetchEvents({
    accountId: "acc",
    token: "token-value",
    days: 7,
    fetchImpl,
  });
  assert.equal(events.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(events[0].type, "impression");
  assert.equal(events[0].source, "web");
  assert.equal(events[0].position, 4);
  assert.deepEqual(Object.keys(events[0]).sort(), [...EVENT_FIELDS].sort());
});

test("a failed export says so without printing the token", async () => {
  const fetchImpl = async () =>
    new Response("token-value is not authorized", {
      status: 403,
      statusText: "Forbidden",
    });
  await assert.rejects(
    () => fetchEvents({ accountId: "acc", token: "token-value", days: 7, fetchImpl }),
    (error) => {
      assert.match(error.message, /403 Forbidden/);
      assert.ok(
        !error.message.includes("token-value"),
        "the error carries the token",
      );
      return true;
    },
  );
});
