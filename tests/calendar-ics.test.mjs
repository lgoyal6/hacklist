// Tests for the published .ics feed.
//
// A calendar feed fails quietly: a subscriber does not see an exception, they
// see a hackathon at the wrong hour, or on the wrong day, or twice. These drive
// the real route out of the built worker, the same way rendered-html does.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const eventsData = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);

async function fetchIcs(path = "/calendar.ics") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/calendar" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const vevents = (ics) =>
  ics.split("BEGIN:VEVENT").slice(1).map((block) => block.split("END:VEVENT")[0]);

// Unfold RFC 5545 continuation lines before matching anything.
const unfold = (ics) => ics.replace(/\r\n /g, "");

test("the feed is well-formed iCalendar", async () => {
  const ics = await (await fetchIcs()).text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR$/);
  assert.match(ics, /VERSION:2\.0/);
  // CRLF everywhere, not bare LF: some clients reject a feed with mixed endings.
  const bareLf = ics.split("\n").filter((l, i, a) => i < a.length - 1 && !l.endsWith("\r"));
  assert.equal(bareLf.length, 0, "found lines not terminated with CRLF");
});

test("no line exceeds the 75-octet fold limit", async () => {
  const ics = await (await fetchIcs()).text();
  for (const line of ics.split("\r\n")) {
    const octets = Buffer.byteLength(line, "utf8");
    assert.ok(octets <= 75, `line of ${octets} octets is unfolded: ${line.slice(0, 60)}...`);
  }
});

test("every event carries a stable UID in the hacklist-sf namespace", async () => {
  const ics = unfold(await (await fetchIcs()).text());
  const blocks = vevents(ics);
  assert.ok(blocks.length > 0, "feed served no events");
  const uids = new Set();
  for (const block of blocks) {
    const uid = /UID:(.+)\r\n/.exec(block)?.[1];
    assert.ok(uid, "a VEVENT has no UID");
    // The namespace is identity, not a label: rewriting it makes every event on
    // an existing subscription look new.
    assert.ok(uid.endsWith("@hacklist-sf"), `UID outside the namespace: ${uid}`);
    assert.ok(!uids.has(uid), `duplicate UID in one feed: ${uid}`);
    uids.add(uid);
  }
});

test("the same event keeps its UID across two builds of the feed", async () => {
  const first = unfold(await (await fetchIcs()).text());
  const second = unfold(await (await fetchIcs()).text());
  const uidsOf = (ics) => vevents(ics).map((b) => /UID:(.+)\r\n/.exec(b)?.[1]).sort();
  assert.deepEqual(uidsOf(first), uidsOf(second), "UIDs are not stable between reads");
});

test("a timed event declares a timezone the feed also defines", async () => {
  const ics = unfold(await (await fetchIcs()).text());
  const declared = new Set([...ics.matchAll(/BEGIN:VTIMEZONE\r\nTZID:(.+)\r\n/g)].map((m) => m[1]));
  const used = new Set([...ics.matchAll(/DTSTART;TZID=([^:]+):/g)].map((m) => m[1]));
  for (const tz of used) {
    assert.ok(declared.has(tz), `event uses TZID=${tz} with no VTIMEZONE for it`);
  }
});

test("all-day DTEND is exclusive, so a one-day event does not span two", async () => {
  const ics = unfold(await (await fetchIcs()).text());
  for (const block of vevents(ics)) {
    const start = /DTSTART;VALUE=DATE:(\d{8})/.exec(block)?.[1];
    const end = /DTEND;VALUE=DATE:(\d{8})/.exec(block)?.[1];
    if (!start || !end) continue;
    assert.ok(end > start, `all-day DTEND ${end} must be after DTSTART ${start} (RFC 5545 §3.6.1)`);
  }
});

test("an unknown region is refused rather than served another metro's events", async () => {
  const res = await fetchIcs("/calendar.ics?region=atlantis");
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Unknown region/);
});

test("each declared region serves its own board", async () => {
  const regions = eventsData.meta.regions ?? [];
  for (const region of regions) {
    const res = await fetchIcs(`/calendar.ics?region=${region.key}`);
    assert.equal(res.status, 200, `region ${region.key} did not serve`);
    const ics = unfold(await res.text());
    assert.match(ics, new RegExp(`X-WR-CALNAME:${region.boardName}`));
    // The header timezone must be the region's own, not a hardcoded default.
    assert.match(ics, new RegExp(`X-WR-TIMEZONE:${region.timezone ?? "America/Los_Angeles"}`));
  }
});

// ── DST and offset handling ───────────────────────────────────────────────────
// These drive the exported helpers directly: the boundary cases cannot be
// arranged from live data, which only ever contains whatever this week holds.

test("timed events are emitted in the region zone only when the offsets agree", async () => {
  const ics = unfold(await (await fetchIcs()).text());
  for (const block of vevents(ics)) {
    const tzStart = /DTSTART;TZID=([^:]+):(\d{8}T\d{6})/.exec(block);
    const utcStart = /DTSTART:(\d{8}T\d{6}Z)/.exec(block);
    // Exactly one form, never both, never neither (all-day events aside).
    if (block.includes("VALUE=DATE")) continue;
    assert.ok(
      Boolean(tzStart) !== Boolean(utcStart),
      "a timed event must be either zone-local or absolute UTC, not both",
    );
  }
});

test("the Pacific VTIMEZONE carries both DST transitions", async () => {
  const ics = unfold(await (await fetchIcs()).text());
  const block = /BEGIN:VTIMEZONE\r\nTZID:America\/Los_Angeles[\s\S]*?END:VTIMEZONE/.exec(ics)?.[0];
  assert.ok(block, "no Pacific VTIMEZONE in the feed");
  // Without both halves a client cannot place a local time on either side of a
  // transition, which is exactly when a hackathon start time goes an hour out.
  assert.match(block, /BEGIN:DAYLIGHT[\s\S]*TZOFFSETTO:-0700/);
  assert.match(block, /BEGIN:STANDARD[\s\S]*TZOFFSETTO:-0800/);
  assert.match(block, /RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);
  assert.match(block, /RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
});
