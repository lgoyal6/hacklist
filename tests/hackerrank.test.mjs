// HackerRank's pages state dates as prose and hide event URLs in an attribute.
// These pin the parsing against text copied from the live pages on Oct 15 2026.
import assert from "node:assert/strict";
import test from "node:test";

import { engageDates, pageText, promotedEvents, titleOf } from "../scripts/lib/hackerrank.mjs";

const MICRO1 =
  "Registration closes on October 30, 7:00 AM (GMT) Event About Company FAQs Register " +
  "Registration closes on October 30, 7:00 AM (GMT) micro1 Eval Hackathon Event Timeline " +
  "Registration Ends October 30, 7:00 AM (GMT) Register Eval Building Challenge Build your own eval " +
  "October 30, 7:15 AM (GMT) Duration: 9 Days, 22 Hours Event Details";

test("an Engage challenge runs from the start nearest its duration, not the registration close", () => {
  const dates = engageDates(MICRO1, new Date("2026-10-15T00:00:00Z"));
  assert.equal(dates.start.toISOString(), "2026-10-30T07:15:00.000Z");
  assert.equal(dates.end.toISOString(), "2026-11-09T05:15:00.000Z");
});

test("a PM start and an hours-only duration both read", () => {
  const dates = engageDates("Challenge November 2, 5:30 PM (GMT) Duration: 24 Hours", new Date("2026-10-15T00:00:00Z"));
  assert.equal(dates.start.toISOString(), "2026-11-02T17:30:00.000Z");
  assert.equal(dates.end.toISOString(), "2026-11-03T17:30:00.000Z");
});

test("a start long past rolls to next year, and no duration means no dates", () => {
  const dates = engageDates("January 5, 9:00 AM (GMT) Duration: 2 Days", new Date("2026-10-15T00:00:00Z"));
  assert.equal(dates.start.toISOString(), "2027-01-05T09:00:00.000Z");
  assert.equal(engageDates("October 30, 7:15 AM (GMT) and nothing else"), null);
});

test("promoted cards yield only Engage event URLs, once each", () => {
  const html =
    '<div class="promoted-contest-v2__card container" data-analytics="ContestPromoted" data-attr1="https://www.hackerrank.com/event/micro1-eval-hackathon">' +
    '<div class="promoted-contest-v2__card container" data-attr1="https://www.hackerrank.com/event/micro1-eval-hackathon">' +
    '<div class="promoted-contest-v2__card" data-attr1="https://evil.example/event/x">';
  assert.deepEqual(promotedEvents(html), ["https://www.hackerrank.com/event/micro1-eval-hackathon"]);
});

test("titles drop HackerRank's suffix and entities decode", () => {
  assert.equal(titleOf("<title>micro1 Eval Hackathon : HackerRank Engage</title>"), "micro1 Eval Hackathon");
  assert.equal(titleOf("<title>HackerRank Orchestrate | 24-Hour Hackathon</title>"), "HackerRank Orchestrate | 24-Hour Hackathon");
  assert.equal(pageText("<p>A &amp; B</p><script>x()</script><p>it&#x27;s</p>"), "A & B it's");
});
