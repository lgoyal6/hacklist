// Provenance, and deletions that stay deleted.
//
// The end-to-end proof that a deleted record leaves the board, the ICS feed and
// the sync ledger is `scripts/verify-deletion.mjs`, which builds the site twice.
// These are the invariants that hold on every run without a build: that the
// published board can name the input revisions it came from, that a content
// hash answers "did this record change", and that a tombstone is applied rather
// than politely noted.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reconcile } from "../scripts/lib/event-revisions.mjs";
import { Provenance, contentHash, sha256 } from "../scripts/lib/provenance.mjs";
import {
  apply,
  isDeleted,
  readTombstonesStrict,
} from "../scripts/lib/tombstones.mjs";

const board = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);

const HEX64 = /^[0-9a-f]{64}$/;

test("the board names the exact input revisions it was built from", () => {
  const inputs = board.meta.inputs;
  assert.ok(Array.isArray(inputs) && inputs.length > 0, "meta.inputs is missing");
  for (const input of inputs) {
    assert.match(input.sha256, HEX64, `${input.file}: sha256 is not a digest`);
    assert.ok(input.bytes > 0, `${input.file}: zero-length input`);
  }
  const files = inputs.map((i) => i.file);
  assert.equal(new Set(files).size, files.length, "an input is listed twice");
});

// The gate every published event has to pass. Factored out of the board test so
// that a carried-forward event can be run through the same code rather than
// through a copy of it: a copy is what was missing, and it is why two capability
// suites could disagree about the same four events without either going red.
function assertTraceable(board) {
  const byFile = new Map(board.meta.inputs.map((i) => [i.file, i.sha256]));
  for (const event of board.events) {
    const provenance = event.provenance;
    assert.ok(provenance, `${event.url}: no provenance`);
    assert.match(
      provenance.contentSha256,
      HEX64,
      `${event.url}: content hash is not a digest`,
    );
    assert.ok(
      Array.isArray(provenance.inputs) && provenance.inputs.length > 0,
      `${event.url}: no input recorded`,
    );
    for (const input of provenance.inputs) {
      // The failure this catches: the deduplicator and the enricher both return
      // new objects, and an identity-keyed source map dropped 34 of 145 events
      // to "unknown" here.
      assert.notEqual(
        input.sha256,
        null,
        `${event.url}: input ${input.file} has no resolved version`,
      );
      assert.equal(
        input.sha256,
        byFile.get(input.file),
        `${event.url}: input ${input.file} names a version the board does not list`,
      );
    }
    if (provenance.kind !== "carried-forward") {
      // There are two ways onto the board and the tag has to say which one. An
      // event with no kind at all reads as swept to anything switching on it,
      // which is the same wrong answer as an unstamped row, told quietly.
      assert.equal(
        provenance.kind,
        "observed",
        `${event.url}: unrecognised provenance kind`,
      );
      continue;
    }
    // A sweep that cannot reach a listing republishes it rather than dropping
    // the row off every subscription, so the board carries records nobody
    // confirmed today. Those have to say which snapshot they came out of and
    // when it was taken; without the second, "still listed" and "listed three
    // days ago" render identically.
    assert.ok(
      byFile.has(provenance.carriedFrom?.file),
      `${event.url}: carried from a snapshot the board does not list`,
    );
    assert.ok(
      Number.isFinite(Date.parse(provenance.carriedFrom.sweepCompletedAt)),
      `${event.url}: carried from a snapshot with no capture time`,
    );
  }
}

test("every published event traces to a listed input version", () => {
  assert.ok(board.events.length > 0, "expected a published board");
  assertTraceable(board);
});

test("a carried-forward event passes the same trace check as a swept one", () => {
  // The gap that let carry-forward and provenance disagree: this suite had only
  // ever seen events a sweep read, and the carry-forward suite had never seen a
  // provenance stamp, so no test on either side put an unread event through the
  // gate above. Four of them went out unstamped and both suites stayed green.
  const candidate = {
    url: "https://luma.com/held-over",
    title: "Held Over Hack",
    category: "hackathon",
    discoveredVia: "https://luma.com/discover/sf/ai",
    confidence: 90,
    relevance: 80,
    evidence: "prizes, judging, demos",
  };
  const lastSweep = new Provenance();
  lastSweep.record("data/luma-api.json", '{"entries":[]}');
  const snapshot = {
    meta: { sweepCompletedAt: "2026-09-05T07:33:20.745Z" },
    events: [
      {
        url: candidate.url,
        title: candidate.title,
        start: "2026-09-20T17:00:00.000Z",
        end: "2026-09-20T23:00:00.000Z",
        missedSweeps: 0,
        provenance: lastSweep.stamp(["data/luma-api.json"], candidate),
      },
    ],
  };

  // This sweep reads the snapshot and gets nothing else: every source failed.
  const thisSweep = new Provenance();
  const file = "data/history/sweep-2026-09-05T07-33-20-745Z.json";
  const raw = JSON.stringify(snapshot);
  const version = thisSweep.record(file, raw);
  const now = Date.parse("2026-09-06T07:48:27.083Z");
  const { events, changes } = reconcile({
    current: [],
    previous: snapshot.events,
    previousSource: { ...version, capturedAt: snapshot.meta.sweepCompletedAt },
    now,
  });

  assert.equal(changes.carried.length, 1, "expected the event to be carried");
  assertTraceable({ meta: { inputs: thisSweep.manifest() }, events });

  const [carried] = events;
  assert.equal(carried.provenance.kind, "carried-forward");
  // Traced to the snapshot, not re-stamped with an input this sweep never read:
  // the row is real, and saying it came from today's luma-api.json would be a
  // claim that it was seen today.
  assert.deepEqual(carried.provenance.inputs, [{ file, sha256: sha256(raw) }]);
  // It is the record the last sweep published, so it keeps that sweep's content
  // hash rather than being re-identified as a different record.
  assert.equal(carried.provenance.contentSha256, contentHash(candidate));
  assert.equal(carried.provenance.lastConfirmedAt, "2026-09-05T07:33:20.745Z");
  // And the whole point of keeping that timestamp: the staleness of the row is
  // a number the board can work out, rather than something it has to guess.
  const staleForHours =
    (now - Date.parse(carried.provenance.lastConfirmedAt)) / 3_600_000;
  assert.equal(Math.round(staleForHours), 24);
});

test("a merged event records every input it was derived from", () => {
  // The deduplicator merges the same event found on two sites. Naming one of
  // them would make the record wrong rather than incomplete.
  const merged = board.events.filter((e) => e.provenance.inputs.length > 1);
  for (const event of merged) {
    const files = event.provenance.inputs.map((i) => i.file);
    assert.equal(new Set(files).size, files.length, `${event.url}: duplicate input`);
  }
});

test("a content hash tracks the fields the event is derived from", () => {
  const base = {
    url: "https://example.test/a",
    title: "Build Night",
    category: "hackathon",
    discoveredVia: "https://example.test/",
    confidence: 90,
    relevance: 80,
    evidence: "prizes, judging, demos",
  };
  // Same content, different key order: the same record.
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(contentHash(base), contentHash(reordered));

  // A field the event is built from changes the hash.
  assert.notEqual(contentHash(base), contentHash({ ...base, title: "Build Day" }));
  assert.notEqual(contentHash(base), contentHash({ ...base, confidence: 91 }));

  // A field nothing is derived from does not, or every unrelated edit would
  // read as a changed record.
  assert.equal(contentHash(base), contentHash({ ...base, scrapedAt: "now" }));

  // Absent is not the same as empty.
  const withoutEvidence = { ...base };
  delete withoutEvidence.evidence;
  assert.notEqual(contentHash(withoutEvidence), contentHash({ ...base, evidence: "" }));
});

test("an input version is content-addressed, not timestamped", () => {
  const p = new Provenance();
  const a = p.record("data/x.json", '{"candidates":[]}');
  // Recording the same file twice is one input, and the digest is of the bytes.
  const b = p.record("data/x.json", '{"candidates":[{"url":"z"}]}');
  assert.equal(a.sha256, b.sha256, "a second record of one file must not re-version it");
  assert.equal(a.sha256, sha256('{"candidates":[]}'));
  assert.equal(p.manifest().length, 1);
});

test("a delete tombstone removes the record and a redact blanks named fields", () => {
  const events = [
    { url: "https://a.test", title: "A", organizer: "Org A" },
    { url: "https://b.test", title: "B", organizer: "Org B" },
    { url: "https://c.test", title: "C", organizer: "Org C" },
  ];
  const result = apply(events, [
    { url: "https://a.test", action: "delete" },
    { url: "https://b.test", action: "redact", fields: ["organizer"] },
  ]);

  assert.deepEqual(result.events.map((e) => e.url), [
    "https://b.test",
    "https://c.test",
  ]);
  assert.deepEqual(result.deleted, ["https://a.test"]);
  assert.deepEqual(result.redacted, ["https://b.test"]);

  const redacted = result.events.find((e) => e.url === "https://b.test");
  assert.equal(redacted.organizer, "[redacted]");
  assert.equal(redacted.title, "B", "a redaction blanks only the named fields");
  assert.deepEqual(redacted.redacted, ["organizer"]);

  // An untouched event passes through unchanged, by identity.
  assert.equal(result.events.find((e) => e.url === "https://c.test"), events[2]);
});

test("an empty tombstone list changes nothing", () => {
  // The negative half of the test above: `apply` removing things is the
  // tombstones working, not `apply` always dropping rows.
  const events = [{ url: "https://a.test" }];
  const result = apply(events, []);
  assert.equal(result.events, events);
  assert.deepEqual(result.deleted, []);
});

test("isDeleted distinguishes a deletion from a redaction", () => {
  const tombstones = [
    { url: "https://a.test", action: "delete" },
    { url: "https://b.test", action: "redact", fields: ["organizer"] },
  ];
  assert.equal(isDeleted(tombstones, "https://a.test"), true);
  assert.equal(isDeleted(tombstones, "https://b.test"), false);
  assert.equal(isDeleted(tombstones, "https://c.test"), false);
});

test("a malformed tombstone file stops the publisher rather than being ignored", async () => {
  // Treating an unreadable tombstone file as "no deletions" republishes every
  // record ever deleted, which is the one outcome this file exists to prevent.
  const bad = new URL("./fixtures/bad-tombstones.json", import.meta.url);
  await assert.rejects(() => readTombstonesStrict(bad));
  const missing = new URL("./fixtures/no-such-tombstones.json", import.meta.url);
  assert.deepEqual(await readTombstonesStrict(missing), []);
});

test("nothing tombstoned is published", async () => {
  const tombstones = await readTombstonesStrict(
    new URL("../data/tombstones.json", import.meta.url),
  );
  for (const tombstone of tombstones) {
    if (tombstone.action === "redact") continue;
    assert.ok(
      !board.events.some((event) => event.url === tombstone.url),
      `${tombstone.url} is tombstoned and still published`,
    );
  }
});
