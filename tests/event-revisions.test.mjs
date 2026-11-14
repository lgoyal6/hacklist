// Tests for what happens to a calendar entry between sweeps.
//
// The failure these guard against is invisible from the board and obvious on a
// phone: a row that changes when it should not, or disappears when nothing
// happened. The UID is derived from the URL and never moves, so every case here
// is really one question -- does the same entry survive, and does it say the
// right thing.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CANCELLED,
  cancelledByOrganizer,
  reconcile,
} from "../scripts/lib/event-revisions.mjs";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const SOON = "2026-09-20T17:00:00.000Z";
const LATER = "2026-09-27T17:00:00.000Z";

const event = (over = {}) => ({
  id: "abc123",
  url: "https://luma.com/abc123",
  title: "Agents Hackathon",
  organizer: "Someone",
  venue: "GitHub HQ",
  city: "San Francisco",
  start: SOON,
  end: SOON,
  status: "Open",
  prize: "$5,000",
  category: "hackathon",
  ...over,
});

const other = (over = {}) =>
  event({ id: "def456", url: "https://luma.com/def456", title: "Robotics Jam", ...over });

const run = (current, previous, over = {}) =>
  reconcile({ current, previous, now: NOW, ...over });

test("a renamed venue revises the existing entry rather than replacing it", () => {
  const before = [event()];
  const after = [event({ venue: "Frontier Tower" })];
  const { events, changes } = run(after, before);

  assert.equal(events.length, 1);
  // Identity is the URL, so the subscriber's row is updated, not replaced.
  assert.equal(events[0].id, before[0].id);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.updated, [
    {
      url: "https://luma.com/abc123",
      title: "Agents Hackathon",
      fields: { venue: { from: "GitHub HQ", to: "Frontier Tower" } },
    },
  ]);
});

test("a rescheduled event revises the same entry and reports both dates", () => {
  const { events, changes } = run([event({ start: LATER, end: LATER })], [event()]);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "abc123");
  assert.equal(events[0].start, LATER);
  assert.deepEqual(changes.updated[0].fields, {
    start: { from: SOON, to: LATER },
    end: { from: SOON, to: LATER },
  });
});

test("a title change alone is a revision, not a new event", () => {
  const { events, changes } = run(
    [event({ title: "Agents Hackathon (Rescheduled)" })],
    [event()],
  );
  assert.equal(events.length, 1, "one entry, not two");
  assert.deepEqual(changes.added, []);
  assert.equal(changes.updated.length, 1);
});

// Nothing downstream of this can fire unless a sweep is able to decide an event
// was called off, so the decision gets its own case rather than only being
// reached through a status string a test wrote by hand.
test("a cancellation is read from the organizer's own structured data", () => {
  const withStatus = (eventStatus) => ({ structuredEvent: { eventStatus } });
  assert.equal(
    cancelledByOrganizer(withStatus("https://schema.org/EventCancelled")),
    true,
  );
  // Live pages carry the scheduled and postponed values too, and neither is a
  // cancellation. Postponed in particular still has a date the subscriber
  // wants; it is not this function's call to remove it.
  assert.equal(
    cancelledByOrganizer(withStatus("https://schema.org/EventScheduled")),
    false,
  );
  assert.equal(
    cancelledByOrganizer(withStatus("https://schema.org/EventPostponed")),
    false,
  );
  // A candidate from a source with no JSON-LD at all is the common case.
  assert.equal(cancelledByOrganizer(withStatus(null)), false);
  assert.equal(cancelledByOrganizer({}), false);
  assert.equal(cancelledByOrganizer(undefined), false);
});

test("an explicit cancellation stays in the feed, marked", () => {
  const { events, changes } = run([event({ status: CANCELLED })], [event()]);
  // Dropping it would remove the subscriber's row and leave them believing the
  // hackathon is still on. It has to be published saying it is off.
  assert.equal(events.length, 1);
  assert.equal(events[0].status, CANCELLED);
  assert.deepEqual(changes.cancelled, ["https://luma.com/abc123"]);
  assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.updated[0].fields, {
    status: { from: "Open", to: CANCELLED },
  });
});

test("a source that temporarily disappears does not cancel the event", () => {
  const before = [event(), other()];
  // One page 429'd; the other read fine.
  const { events, changes } = run([other()], before);

  assert.equal(events.length, 2, "the unread event is still published");
  const carriedOver = events.find((e) => e.url === "https://luma.com/abc123");
  assert.equal(carriedOver.status, "Open", "absence is not a cancellation");
  assert.equal(carriedOver.title, "Agents Hackathon");
  assert.equal(carriedOver.missedSweeps, 1);
  assert.deepEqual(changes.removed, [], "nothing was removed");
  assert.deepEqual(changes.cancelled, []);
  assert.deepEqual(changes.carried, [
    { url: "https://luma.com/abc123", missedSweeps: 1 },
  ]);
  // A carried event was not read, so it cannot have revised anything.
  assert.deepEqual(changes.updated, []);
});

test("an event that comes back is confirmed again and its counter resets", () => {
  const missedOnce = run([], [event()]).events;
  assert.equal(missedOnce[0].missedSweeps, 1);
  const { events, changes } = run([event()], missedOnce);
  assert.equal(events[0].missedSweeps, 0);
  assert.deepEqual(changes.added, [], "it was never gone, so it is not new");
  assert.deepEqual(changes.carried, []);
});

test("an event nobody has seen for too long is eventually dropped", () => {
  let published = [event()];
  const seen = [];
  for (let sweep = 1; sweep <= 4; sweep += 1) {
    const result = run([], published, { maxMissedSweeps: 3 });
    published = result.events;
    seen.push({ sweep, published: published.length, removed: result.changes.removed.length });
  }
  assert.deepEqual(seen, [
    { sweep: 1, published: 1, removed: 0 },
    { sweep: 2, published: 1, removed: 0 },
    { sweep: 3, published: 1, removed: 0 },
    // Held for three sweeps, then let go: carrying a stale row forever is its
    // own wrong answer.
    { sweep: 4, published: 0, removed: 1 },
  ]);
});

test("an event whose date has passed is dropped rather than carried", () => {
  const past = event({ start: "2026-08-01T17:00:00.000Z", end: "2026-08-01T23:00:00.000Z" });
  const { events, changes } = run([], [past]);
  assert.deepEqual(events, []);
  assert.deepEqual(changes.removed, [past.url]);
  // It ran; that is not a cancellation and must not be reported as one.
  assert.deepEqual(changes.cancelled, []);
});

test("a sweep that read nothing does not wipe the board", () => {
  const board = [event(), other(), event({ id: "ghi", url: "https://luma.com/ghi" })];
  const { events, changes } = run([], board);
  assert.equal(events.length, 3);
  assert.deepEqual(changes.removed, []);
  assert.equal(changes.carried.length, 3);
  for (const published of events) assert.equal(published.missedSweeps, 1);
});

test("a partial sweep keeps what it read and holds what it missed", () => {
  const board = [event(), other()];
  const { events } = run([event({ venue: "Frontier Tower" })], board);
  const byUrl = new Map(events.map((e) => [e.url, e]));
  assert.equal(byUrl.get("https://luma.com/abc123").venue, "Frontier Tower");
  assert.equal(byUrl.get("https://luma.com/def456").venue, "GitHub HQ");
  assert.equal(byUrl.get("https://luma.com/def456").missedSweeps, 1);
});

test("two sources describing one event produce one calendar entry", () => {
  // Same URL, so the same UID: publishing both would put two identical rows on
  // every subscription.
  const fromLuma = event({ prize: "$5,000", venue: "GitHub HQ" });
  const fromDevpost = event({ prize: "$5,000 USD", venue: null });
  const { events, changes } = run([fromLuma, fromDevpost], []);
  assert.equal(events.length, 1);
  assert.equal(events[0].venue, "GitHub HQ", "the first, which sorted highest, wins");
  assert.deepEqual(changes.duplicates, ["https://luma.com/abc123"]);
});

test("importing the same sweep twice changes nothing", () => {
  const first = run([event(), other()], [event(), other()]);
  const second = run([event(), other()], first.events);
  assert.deepEqual(second.events, first.events);
  assert.deepEqual(second.changes.added, []);
  assert.deepEqual(second.changes.updated, []);
  assert.deepEqual(second.changes.removed, []);
  assert.deepEqual(second.changes.carried, []);
});

test("a genuinely new event is added rather than treated as a revision", () => {
  const { events, changes } = run([event(), other()], [event()]);
  assert.equal(events.length, 2);
  assert.deepEqual(changes.added, ["https://luma.com/def456"]);
  assert.deepEqual(changes.updated, []);
});
