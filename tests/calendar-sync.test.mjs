// Tests for the decisions the Luma calendar sync makes.
//
// The browser driving itself cannot be unit-tested, but the logic underneath it
// can, and that logic is where the expensive mistakes live: match too loosely and
// an event is never added because the sync thinks it is already there; match too
// strictly and it is added twice. Both happened during development.
import assert from "node:assert/strict";
import test from "node:test";

import {
  eventSlug,
  isOnCalendar,
  reconcile,
  titleOnCalendar,
} from "../scripts/lib/calendar-match.mjs";
import { markSynced, pendingEvents } from "../scripts/lib/luma-queue.mjs";

const luma = (slug, title = "A Hackathon") => ({
  id: slug,
  url: `https://luma.com/${slug}`,
  title,
  platform: "luma",
});
const external = (host, title) => ({
  id: `external-${host}`,
  url: `https://${host}`,
  title,
  platform: "external",
});

test("a Luma event is identified by its slug, an external one is not", () => {
  assert.equal(eventSlug(luma("abc123")), "abc123");
  assert.equal(eventSlug(external("showerhacks.devpost.com", "Shower Hacks")), null);
  assert.equal(eventSlug({ url: "https://events.ycombinator.com/x" }), null);
  assert.equal(eventSlug({ url: "not a url" }), null);
});

test("Luma events match on slug and ignore titles entirely", () => {
  const state = { slugs: new Set(["abc123"]), titles: new Set(["Something Else"]) };
  assert.equal(isOnCalendar(luma("abc123", "Renamed On Luma"), state), true);
  assert.equal(isOnCalendar(luma("zzz999", "Something Else"), state), false);
});

test("external events match on title, since they have no slug", () => {
  const state = {
    slugs: new Set(),
    titles: new Set(["The Fast Hackathon: Build the Future of Software Engineering"]),
  };
  const event = external(
    "events.ycombinator.com/thefasthackathon",
    "The Fast Hackathon: Build the Future of Software Engineering",
  );
  assert.equal(isOnCalendar(event, state), true);
});

test("a truncated calendar row still matches its event", () => {
  // Luma's rows are clipped, so the row text is a prefix of the real title.
  const state = {
    slugs: new Set(),
    titles: new Set(["DevNetwork [API + Cloud + AI] Hackath"]),
  };
  const event = external("x.devpost.com", "DevNetwork [API + Cloud + AI] Hackathon 2026");
  assert.equal(isOnCalendar(event, state), true);
});

test("a short title does not match everything on the calendar", () => {
  // Without a length floor this is the bug that makes the sync believe the whole
  // board is already synced and quietly add nothing, forever.
  const titles = new Set([
    "Some Completely Unrelated Long Event Title",
    "Another Totally Different Long Title Here",
  ]);
  assert.equal(titleOnCalendar(titles, "Hack"), false);
  assert.equal(titleOnCalendar(titles, "AI"), false);
  assert.equal(titleOnCalendar(titles, ""), false);
});

test("title matching ignores case and punctuation but not content", () => {
  const titles = new Set(["ROAST MY PR CTF - Win a Mac Mini!"]);
  assert.equal(titleOnCalendar(titles, "roast my pr ctf — win a mac mini"), true);
  assert.equal(titleOnCalendar(titles, "ROAST MY PR CTF - Win a Mac Studio!"), false);
});

test("reconcile adopts an event that is on the calendar but unrecorded", () => {
  // This is how an event added by hand stops being retried every single run.
  const ledger = { synced: {}, failures: {} };
  const events = [luma("abc123")];
  const state = { slugs: new Set(["abc123"]), titles: new Set() };
  const { adopted, cleared } = reconcile(ledger, events, state, { markSynced });
  assert.equal(adopted, 1);
  assert.equal(cleared, 0);
  assert.ok(ledger.synced["abc123"], "should now be recorded");
  assert.equal(pendingEvents(events, ledger).length, 0, "and no longer pending");
});

test("reconcile un-records an event that is no longer on the calendar", () => {
  // The other direction matters just as much: a deleted event has to become
  // pending again rather than being skipped forever on a stale record.
  const ledger = {
    synced: { abc123: { url: "https://luma.com/abc123", title: "A Hackathon" } },
    failures: {},
  };
  const events = [luma("abc123")];
  const state = { slugs: new Set(), titles: new Set() };
  const { adopted, cleared } = reconcile(ledger, events, state, { markSynced });
  assert.equal(cleared, 1);
  assert.equal(adopted, 0);
  assert.equal(pendingEvents(events, ledger).length, 1, "should be pending again");
});

test("reconcile adopts external events too, by title", () => {
  // Before external events were matched by title they were skipped here entirely,
  // so one added by hand was retried on every run for ever.
  const ledger = { synced: {}, failures: {} };
  const events = [external("showerhacks.devpost.com", "Shower Hacks Bay Area 2026")];
  const state = { slugs: new Set(), titles: new Set(["Shower Hacks Bay Area 2026"]) };
  const { adopted } = reconcile(ledger, events, state, { markSynced });
  assert.equal(adopted, 1);
  assert.equal(ledger.synced["external-showerhacks.devpost.com"].method, "luma-ui-external");
});

test("reconcile leaves a correctly-recorded event alone", () => {
  const ledger = { synced: { abc123: { url: "x", title: "y" } }, failures: {} };
  const state = { slugs: new Set(["abc123"]), titles: new Set() };
  const { adopted, cleared } = reconcile(ledger, [luma("abc123")], state, { markSynced });
  assert.equal(adopted, 0);
  assert.equal(cleared, 0);
});
