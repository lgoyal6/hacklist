// Tests for collapsing the same event found under two different URLs.
//
// This took five passes to get right, and every wrong version failed in one of
// two directions: publishing one hackathon twice, or merging two real ones into
// a single entry. Both are visible to anyone reading the board.
import assert from "node:assert/strict";
import test from "node:test";

import { isSameEvent, mergeDuplicate, titleFingerprint } from "../scripts/lib/dedupe.mjs";

const TZ = "America/Los_Angeles";
const ev = (over = {}) => ({
  url: "https://luma.com/abc",
  title: "A Hackathon",
  confidence: 90,
  evidence: "Hosted By\nSomeone",
  structuredEvent: {
    startDate: "2026-08-14T16:30:00.000Z",
    endDate: "2026-08-15T00:30:00.000Z",
    location: { city: "San Francisco", name: null },
  },
  ...over,
});
// Resolvers that read straight off the fixtures.
const R = {
  day: (c) => c.__day,
  organizer: (c) => c.__host ?? "",
  area: (c) => c.__area ?? "",
};
const at = (e, day, host, area) => ({ ...e, __day: day, __host: host, __area: area });

test("one title containing the other on the same day is the same event", () => {
  const a = at(ev({ title: "Biopharma Hack Day" }), "2026-08-13", "", "");
  const b = at(ev({ title: "Biopharma Hack Day at AWS" }), "2026-08-13", "", "");
  assert.equal(isSameEvent(a, b, R), "title");
});

test("same organiser, area and day is the same event even when titles diverge", () => {
  // The real pair: containment cannot see these, the host can.
  const a = at(ev({ title: "SF Enterprise HACKATHON" }), "2026-08-14", "devnovate", "SF");
  const b = at(
    ev({ title: "SF Enterprise Innovation Hackathon: 8-Hour Hackathon in San Francisco" }),
    "2026-08-14", "devnovate", "SF",
  );
  assert.equal(isSameEvent(a, b, R), "same host + area + day");
});

test("different days are never the same event, however alike", () => {
  // A recurring series must not collapse into one entry.
  const a = at(ev({ title: "AI Hack Night" }), "2026-08-14", "devnovate", "SF");
  const b = at(ev({ title: "AI Hack Night" }), "2026-08-21", "devnovate", "SF");
  assert.equal(isSameEvent(a, b, R), false);
});

test("same day and organiser but a different area is not the same event", () => {
  const a = at(ev({ title: "Agents Hackathon" }), "2026-08-14", "devnovate", "SF");
  const b = at(ev({ title: "Robotics Jam" }), "2026-08-14", "devnovate", "South Bay");
  assert.equal(isSameEvent(a, b, R), false);
});

test("two different events on one day with no shared host stay separate", () => {
  const a = at(ev({ title: "Mistral Vibe Hackathon" }), "2026-08-23", "mistral", "SF");
  const b = at(ev({ title: "The Fast Hackathon" }), "2026-08-23", "greptile", "SF");
  assert.equal(isSameEvent(a, b, R), false);
});

test("a short shared title fragment is not enough on its own", () => {
  const a = at(ev({ title: "Hack SF" }), "2026-08-14", "", "");
  const b = at(ev({ title: "Hack SF and Beyond, a Very Long Title" }), "2026-08-14", "", "");
  assert.equal(isSameEvent(a, b, R), false, "under the 12-character floor");
});

test("a missing organiser cannot make two events match", () => {
  const a = at(ev({ title: "Alpha Jam" }), "2026-08-14", "", "SF");
  const b = at(ev({ title: "Beta Jam" }), "2026-08-14", "", "SF");
  assert.equal(isSameEvent(a, b, R), false);
});

test("merging keeps the Luma URL, because only that can reach the calendar", () => {
  const lumaRecord = ev({ url: "https://luma.com/qisv9xmg" });
  const external = ev({ url: "https://builder.aws.com/content/x/data-and-ai" });
  assert.equal(mergeDuplicate(external, lumaRecord, TZ).url, "https://luma.com/qisv9xmg");
  assert.equal(mergeDuplicate(lumaRecord, external, TZ).url, "https://luma.com/qisv9xmg");
});

test("merging takes a believable time over an unbelievable one", () => {
  // The real case: Luma said 00:30-01:30, the organiser's page said 09:30-19:00,
  // and the title said "8-Hour". Canonical is not the same as accurate.
  const lumaRecord = ev({
    url: "https://luma.com/qisv9xmg",
    structuredEvent: {
      startDate: "2026-09-11T07:30:00.000Z", // 00:30 local
      endDate: "2026-09-11T08:30:00.000Z", // one hour
      location: { city: "SF", name: null },
    },
  });
  const external = ev({
    url: "https://builder.aws.com/content/x",
    structuredEvent: {
      startDate: "2026-09-11T16:30:00.000Z", // 09:30 local
      endDate: "2026-09-12T02:00:00.000Z", // 19:00 local
      timeSource: "devpost",
      location: { city: "San Francisco", name: "AWS Builder Loft" },
    },
  });
  const merged = mergeDuplicate(lumaRecord, external, TZ);
  assert.equal(merged.url, "https://luma.com/qisv9xmg", "keeps the syncable URL");
  assert.equal(merged.structuredEvent.startDate, "2026-09-11T16:30:00.000Z", "takes the real time");
  assert.equal(merged.structuredEvent.location.name, "AWS Builder Loft", "and the venue");
  assert.match(merged.structuredEvent.timeSource, /via-duplicate/, "records where it came from");
});

test("merging never replaces a believable time with a worse one", () => {
  const good = ev({
    url: "https://luma.com/good",
    structuredEvent: {
      startDate: "2026-09-11T16:30:00.000Z",
      endDate: "2026-09-12T02:00:00.000Z",
      location: { city: "SF", name: "Real Venue" },
    },
  });
  const bad = ev({
    url: "https://builder.aws.com/content/x",
    structuredEvent: {
      startDate: "2026-09-11T07:30:00.000Z",
      endDate: "2026-09-11T08:30:00.000Z",
      location: { city: "SF", name: "Other Venue" },
    },
  });
  const merged = mergeDuplicate(good, bad, TZ);
  assert.equal(merged.structuredEvent.startDate, "2026-09-11T16:30:00.000Z");
  assert.equal(merged.structuredEvent.location.name, "Real Venue", "does not overwrite a venue");
});

test("title fingerprinting ignores case and punctuation", () => {
  assert.equal(titleFingerprint("ROAST MY PR CTF - Win a Mac Mini!"), "roastmyprctfwinamacmini");
  assert.equal(titleFingerprint(null), "");
});
