// Tests for the discovery logic most likely to publish something wrong.
//
// The board's own tests check the published output. These check the reasoning
// that produces it: the date arithmetic that turns a source's idea of "when" into
// a time we are willing to print. That is where the real bugs live — Y
// Combinator's placeholder timestamps and Devpost's date-only strings both
// looked fine until they were read closely.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isSuspectSchedule,
  parseDevpostDates,
  recoverTimeRange,
} from "../scripts/lib/event-dates.mjs";
import { linksFromSerpHtml, serpResults } from "../scripts/lib/serp.mjs";
import {
  buildPatterns,
  localCitySet,
  resolveCity,
  scoreCandidate,
} from "../scripts/lib/candidate-score.mjs";

const config = JSON.parse(
  await readFile(new URL("../config/discovery.json", import.meta.url), "utf8"),
);
const patterns = buildPatterns(config);
const localCities = localCitySet(config);
const TZ = "America/Los_Angeles";

/** What the clock says in Pacific for a given instant, with a full year. */
function pacific(ms) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

test("Devpost single-day dates span that whole local day", () => {
  const parsed = parseDevpostDates("Aug 04, 2026", TZ);
  assert.ok(parsed, "should parse");
  assert.match(pacific(parsed.startUtc), /^8\/4\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^8\/4\/2026, 11:59 PM$/);
});

test("Devpost within-month ranges cover first to last day", () => {
  const parsed = parseDevpostDates("Sep 26 - 27, 2026", TZ);
  assert.ok(parsed);
  assert.match(pacific(parsed.startUtc), /^9\/26\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^9\/27\/2026, 11:59 PM$/);
});

test("Devpost cross-month ranges keep both months", () => {
  const parsed = parseDevpostDates("Jul 26 - Aug 14, 2026", TZ);
  assert.ok(parsed);
  assert.match(pacific(parsed.startUtc), /^7\/26\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^8\/14\/2026, 11:59 PM$/);
});

test("a year-crossing Devpost range puts the start in the previous year", () => {
  // Devpost prints the end date's year, so "Dec - Jan, 2027" starts in 2026.
  const parsed = parseDevpostDates("Dec 28 - Jan 03, 2027", TZ);
  assert.ok(parsed);
  assert.match(pacific(parsed.startUtc), /^12\/28\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^1\/3\/2027, 11:59 PM$/);
});

test("a backwards Devpost range collapses to one day rather than inverting", () => {
  // Real data: "Jul 28 - 26, 2026". An inverted range would be dropped by the
  // normalizer entirely, losing the event.
  const parsed = parseDevpostDates("Jul 28 - 26, 2026", TZ);
  assert.ok(parsed, "should still yield a usable day");
  assert.ok(parsed.endUtc > parsed.startUtc, "must not invert");
  assert.match(pacific(parsed.startUtc), /^7\/28\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^7\/28\/2026, 11:59 PM$/);
});

test("Devpost dates that are not a recognized shape are refused, not guessed", () => {
  for (const raw of ["", "coming soon", "TBD", "2026-08-04", "Augustus 4, 2026", null]) {
    assert.equal(parseDevpostDates(raw, TZ), null, `should refuse ${JSON.stringify(raw)}`);
  }
});

test("Devpost ranges survive a DST boundary without drifting an hour", () => {
  // 8 March 2026 is a spring-forward Sunday in the US.
  const parsed = parseDevpostDates("Mar 07 - 09, 2026", TZ);
  assert.ok(parsed);
  assert.match(pacific(parsed.startUtc), /^3\/7\/2026, 12:00 AM$/);
  assert.match(pacific(parsed.endUtc), /^3\/9\/2026, 11:59 PM$/);
});

test("scoring agrees with the sweep on an obvious hackathon", () => {
  const scored = scoreCandidate(
    "The Fast Hackathon: Build the Future of Software Engineering",
    "Hosted By\nGreptile\nSan Francisco, CA\nprizes include a YC interview\njudging at 5pm\nbuild the next generation of developer tools",
    patterns,
  );
  assert.equal(scored.signals.directHackathonTerm, true);
  assert.equal(scored.signals.buildEvidence, true);
  assert.equal(scored.signals.competitionEvidence, true);
  assert.equal(scored.signals.sfBayAreaEvidence, true);
  assert.ok(scored.confidence >= 90, `confidence ${scored.confidence} should be high`);
});

test("scoring penalizes a conference that only mentions a hackathon in passing", () => {
  const conference = scoreCandidate(
    "MITAI Conference 2026: Age of Agency",
    "Hosted By\nMIT\nSan Francisco, CA\npanel discussions and networking",
    patterns,
  );
  const hackathon = scoreCandidate(
    "AI Infra Summit Hackathon",
    "Hosted By\nlablab\nSan Francisco, CA\nbuild and ship, prizes, judging",
    patterns,
  );
  assert.ok(
    conference.confidence < hackathon.confidence,
    `conference ${conference.confidence} should score below hackathon ${hackathon.confidence}`,
  );
});

test("city resolution keeps configured cities and refuses unknown ones", () => {
  assert.equal(
    resolveCity("San Francisco, California, United States", config, localCities, patterns),
    "San Francisco",
  );
  assert.equal(resolveCity("Santa Clara, CA, USA", config, localCities, patterns), "Santa Clara");
  // A venue name alone must not resolve — guessing puts an event in the wrong city.
  assert.equal(resolveCity("AWS Builder Loft", config, localCities, patterns), null);
  assert.equal(resolveCity("Detroit, MI, USA", config, localCities, patterns), null);
  assert.equal(resolveCity("", config, localCities, patterns), null);
});

// --- the YC placeholder-time recovery --------------------------------------

test("YC's midnight placeholder is judged not credible", () => {
  // The real record for Greptile's Fast Hackathon: local midnight, 3h long,
  // while the copy says 12pm-6pm.
  const start = Date.parse("2026-08-23T07:00:00.000Z");
  const end = Date.parse("2026-08-24T10:00:00.000Z"); // long, so only the hour is suspect
  assert.equal(isSuspectSchedule(start, end, TZ), true, "midnight start is suspect");
});

test("a short duration alone is enough to distrust a schedule", () => {
  const start = Date.parse("2026-08-23T17:00:00.000Z"); // 10am local
  const end = Date.parse("2026-08-23T18:00:00.000Z"); // one hour
  assert.equal(isSuspectSchedule(start, end, TZ), true);
});

test("a credible YC schedule is left alone", () => {
  const start = Date.parse("2026-08-23T16:00:00.000Z"); // 9am local
  const end = Date.parse("2026-08-24T04:00:00.000Z"); // 12 hours
  assert.equal(isSuspectSchedule(start, end, TZ), false);
});

test("the stated range is recovered from real YC event copy", () => {
  const description =
    "Greptile is hosting its second Fast Hackathon at YC in San Francisco on " +
    "Sunday, August 23rd.\n\n**When:** Sunday August 23rd 12pm-6pm \n\n" +
    "* 12 pm doors open \n* 12:30 pm opening remarks";
  const anchor = Date.parse("2026-08-23T07:00:00.000Z");
  const recovered = recoverTimeRange(description, anchor, TZ);
  assert.ok(recovered, "should recover a range");
  assert.equal(pacific(recovered.startUtc), "8/23/2026, 12:00 PM");
  assert.equal(pacific(recovered.endUtc), "8/23/2026, 6:00 PM");
  assert.equal(recovered.matched, "12pm-6pm");
  assert.equal(
    isSuspectSchedule(recovered.startUtc, recovered.endUtc, TZ),
    false,
    "the recovered schedule must itself be credible",
  );
});

test("a range running past midnight lands on the next day", () => {
  const anchor = Date.parse("2026-08-23T07:00:00.000Z");
  const recovered = recoverTimeRange("doors 8pm - 1am, bring a laptop", anchor, TZ);
  assert.ok(recovered);
  assert.equal(pacific(recovered.startUtc), "8/23/2026, 8:00 PM");
  assert.equal(pacific(recovered.endUtc), "8/24/2026, 1:00 AM");
});

test("copy that states no time range recovers nothing rather than inventing one", () => {
  const anchor = Date.parse("2026-08-23T07:00:00.000Z");
  for (const copy of ["Join us on Sunday!", "starts at noon", "", null]) {
    assert.equal(recoverTimeRange(copy, anchor, TZ), null, `should refuse ${JSON.stringify(copy)}`);
  }
});

// --- published output invariants the new sources could break ---------------

const board = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);

test("every published event has a time we are willing to stand behind", () => {
  for (const event of board.events) {
    if (!event.start) continue;
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: event.timezone ?? TZ, hour: "2-digit", hour12: false })
        .format(new Date(event.start))
        .replace(/\D/g, ""),
    ) % 24;
    if (hour < 6) {
      assert.equal(
        event.timeUnverified,
        true,
        `${event.title} starts at ${hour}:00 local and must be marked timeUnverified`,
      );
      assert.equal(
        event.dateDetail,
        "Time on event page",
        `${event.title} must not print a time it does not believe`,
      );
    }
  }
});

test("no published event is placed in a city outside the configured areas", () => {
  const allowed = localCitySet(config);
  for (const event of board.events) {
    if (!event.city) continue; // a region-only location is honest about itself
    assert.ok(
      allowed.has(event.city.toLowerCase()),
      `${event.title} is placed in ${event.city}, which is not a configured local city`,
    );
  }
});

// --- reading a search response ---------------------------------------------
// Bright Data's response shape depends on which zone the account has, and the
// search leg is worthless if it only understands one of them.

test("a SERP-API JSON response yields links and snippets", () => {
  const body = JSON.stringify({
    organic: [
      { link: "https://luma.com/abc123", title: "AI Hackathon", description: "SF, prizes" },
      { url: "https://luma.com/def456", title: "Buildathon" },
    ],
  });
  const results = serpResults(body);
  assert.equal(results.length, 2);
  assert.equal(results[0].link, "https://luma.com/abc123");
  assert.match(results[0].text, /AI Hackathon/);
  assert.equal(results[1].link, "https://luma.com/def456", "must accept url as well as link");
});

test("a Web Unlocker HTML response still yields links", () => {
  const html = `
    <a href="https://www.google.com/search?q=next">Next</a>
    <a href="/url?q=https%3A%2F%2Fluma.com%2Fhack1&amp;sa=U">Hack One</a>
    <a href="https://luma.com/hack2">Hack Two</a>
    <img src="https://www.gstatic.com/x.png">
    <a href="https://fonts.googleapis.com/css">font</a>`;
  const results = serpResults(html);
  const links = results.map((r) => r.link);
  assert.ok(links.includes("https://luma.com/hack1"), "should decode /url?q= wrappers");
  assert.ok(links.includes("https://luma.com/hack2"), "should keep direct hrefs");
  // Google's own domains are chrome, not results.
  assert.ok(!links.some((l) => /google|gstatic/.test(l)), `leaked Google links: ${links}`);
});

test("an empty or junk search response yields nothing rather than throwing", () => {
  for (const input of ["", "not json at all", "<html><body>no results</body></html>", "{}"]) {
    assert.deepEqual(serpResults(input), [], `should be empty for ${JSON.stringify(input.slice(0, 20))}`);
  }
});

test("SERP link extraction does not duplicate a link found both ways", () => {
  const html = `<a href="/url?q=https%3A%2F%2Fluma.com%2Fsame">a</a><a href="https://luma.com/same">b</a>`;
  const links = linksFromSerpHtml(html);
  assert.equal(links.filter((l) => l === "https://luma.com/same").length, 1);
});
