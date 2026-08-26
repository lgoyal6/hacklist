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
  mlhSchedule,
  parseDevpostDates,
  recoverTimeRange,
} from "../scripts/lib/event-dates.mjs";
import {
  createPacer,
  isThrottled,
  linksFromHtml,
  looksLikeRefusal,
  structuredEventsFromHtml,
  visibleText,
} from "../scripts/lib/page-http.mjs";
import { brightDataSearch, linksFromSerpHtml, serpResults } from "../scripts/lib/serp.mjs";
import { isMisconfiguration } from "../scripts/lib/source-health.mjs";
import {
  areaForCity,
  buildPatterns,
  localCitySet,
  namesHackathonFormat,
  namesUnservedRegion,
  placeTerms,
  regionsOf,
  resolveRegion,
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
// Every pass that can put something on the board, so a published event can be
// checked against the listing it came from.
const candidateFiles = await Promise.all(
  [
    "discovery-output.json",
    "luma-api.json",
    "yc-candidates.json",
    "devpost-candidates.json",
  ].map(async (name) => {
    try {
      return JSON.parse(
        await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"),
      );
    } catch {
      return {}; // optional input; absent until that pass has run
    }
  }),
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

test("a location resolves to the region that actually serves its city", () => {
  // The state cannot decide this. Southern California is California, so once
  // there is more than one Californian region a state test says nothing, and the
  // old check passed Los Angeles as local to the Bay Area board.
  assert.equal(resolveRegion({ city: "San Francisco", region: "CA" }, config), "bay-area");
  assert.equal(resolveRegion({ city: "Oakland", region: "California" }, config), "bay-area");
  // Both boards are in California, which is the whole reason the city decides.
  assert.equal(resolveRegion({ city: "San Diego", region: "CA" }, config), "san-diego");
  assert.equal(resolveRegion({ city: "La Jolla", region: "California" }, config), "san-diego");
  assert.equal(resolveRegion({ city: "Carlsbad", region: "CA" }, config), "san-diego");
  assert.equal(resolveRegion({ city: "Los Angeles", region: "CA" }, config), null);
  assert.equal(resolveRegion({ city: "New York", region: "NY" }, config), null);
  // A state is not a place. Assigning "CA, USA" to whichever region asked first
  // would be a guess, so it resolves to nothing and the caller decides.
  assert.equal(resolveRegion({ city: null, region: "CA" }, config), null);
  assert.equal(resolveRegion(null, config), null);
});

test("an event's own region outranks place terms found in its page text", () => {
  // The Seoul case, exactly as it arrived: schema.org said South Korea while the
  // host blurb said "Singapore, Tokyo, Seoul, and San Francisco Bay Area", and
  // the blurb won. The region has to be able to end that argument.
  assert.equal(
    namesUnservedRegion({ name: "Seoul, South Korea", city: null, region: "Seoul" }, config),
    true,
  );
  assert.equal(namesUnservedRegion({ city: "New York", region: "NY" }, config), true);

  // Both spellings the sources actually use for the metro we serve.
  assert.equal(
    namesUnservedRegion({ city: "San Francisco", region: "California" }, config),
    false,
  );
  assert.equal(namesUnservedRegion({ city: "Oakland", region: "CA" }, config), false);
  assert.equal(namesUnservedRegion({ region: " CA " }, config), false);

  // No region is not a claim about anywhere. Refusing these would drop online
  // hackathons and every listing that names only a venue.
  for (const location of [
    null,
    undefined,
    { name: "Online Event", city: null, region: null },
    { name: "TBD - South Bay", city: null, region: null },
    { name: "Frontier Tower @ 14th Floor", city: null, region: null },
  ]) {
    assert.equal(namesUnservedRegion(location, config), false, JSON.stringify(location));
  }
});

test("no published event came from a listing that named a foreign region", () => {
  // The city on a published event can be a guess; the region on the candidate
  // behind it is the source's own words. Checking the published city alone is
  // what let a Seoul hackathon through -- it was published as "San Francisco".
  const locations = new Map();
  for (const file of candidateFiles) {
    for (const candidate of file.candidates ?? []) {
      const location = candidate.structuredEvent?.location;
      if (location && !locations.has(candidate.url)) {
        locations.set(candidate.url, location);
      }
    }
  }
  for (const event of board.events) {
    const location = locations.get(event.url);
    if (!location) continue; // no structured location to check it against
    assert.ok(
      !namesUnservedRegion(location, config),
      `${event.title} is published in ${event.city} but its listing says ` +
        `region ${location.region}`,
    );
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

// --- one vocabulary, shared by every pass -----------------------------------
// These were four separate regexes that had drifted: the sweep required word
// boundaries and the shared scorer did not, so the same page scored 52 in one
// and 94 in the other and reaching the board depended on which pass found it.

test("the vocabulary matches plurals but still respects word boundaries", () => {
  // A calendar describing itself as running "Hackathons" is the text that a
  // boundary-only pattern could not see.
  assert.equal(patterns.candidate.test("Hackathons, all around the world."), true);
  assert.equal(patterns.candidate.test("a hackathon for you"), true);
  // Boundaries still hold, which is the reason the sweep had them.
  assert.equal(patterns.candidate.test("hackathonic nonsense"), false);
  assert.equal(patterns.candidate.test("running a marathon"), false);
  // The "-a-thon" shape, with its required separator.
  assert.equal(patterns.candidate.test("AI Valley Dog-a-thon"), true);
});

test('a standalone "hack" is a format word in a name and not in prose', () => {
  for (const name of [
    "Himalaya Robotics Hack",
    "Open Model Hack - Gradient x Google Deepmind",
    "Mango Hacks",
    "FutureForge Hacks",
  ]) {
    assert.equal(namesHackathonFormat(name, patterns), true, name);
  }
  // Not a format claim: a possessive, a compound, and a verb in body text.
  for (const name of ["Hacker's Book Club", "Showerhacks", "HackwithSF"]) {
    assert.equal(namesHackathonFormat(name, patterns), false, name);
  }
  // Body text is judged by the narrower vocabulary, so prose using "hack" as a
  // verb cannot manufacture a hackathon.
  assert.equal(patterns.candidate.test("you can hack on anything"), false);
  assert.equal(patterns.candidate.test("growth hacks for founders"), false);
});

test("the score penalty knows a format word from an ordinary one", () => {
  // The long list is a format gate and is broad enough to contain plain verbs.
  // Driving the score with it cost a real event: this title lost 30 points for
  // the word "talk" and was released from the board at 48 against a bar of 54,
  // while the sweep scored the same page 78.
  const talky = scoreCandidate(
    "The Next Interface Hackathon: Rethink how we talk to AI",
    "San Francisco, CA\nBuild an agent, demo it, prizes for the top three.",
    patterns,
  );
  assert.equal(talky.signals.negativeTitleEvidence, false);
  assert.ok(talky.confidence >= 54, `confidence ${talky.confidence}`);

  // A name that really does state a non-hackathon format still pays.
  const conf = scoreCandidate(
    "MITAI Conference 2026: Age of Agency",
    "San Francisco, CA\nTalks and panels on agentic AI.",
    patterns,
  );
  assert.equal(conf.signals.negativeTitleEvidence, true);

  // The broad list is still available to callers that gate on format.
  assert.equal(patterns.negativeTitle.test("An Evening of Talks"), true);
});

test("a hackathon named without the word scores over the publishing bar", () => {
  // The exact regression: this page never says "hackathon", and scored 52
  // against a bar of 54 while its own name said Hack.
  const scored = scoreCandidate(
    "Himalaya Robotics Hack",
    [
      "San Francisco, CA",
      "Over two days, teams will tackle the real engineering problems of",
      "extreme-conditions robotics. Prizes awarded by our judges.",
    ].join("\n"),
    patterns,
  );
  assert.equal(scored.signals.directHackathonTerm, true);
  assert.ok(
    scored.confidence >= 54,
    `confidence ${scored.confidence} is still under the bar`,
  );
});

// --- reading a Luma page without a browser ---------------------------------
// Both the sweep and the calendar pass now read Luma over HTTP, so these two
// gotchas are load-bearing: a page's own hydration JSON must not become
// evidence, and an event card's title lives in an attribute rather than in text.

test("script and style content is not visible text", () => {
  const html = `<html><body>
    <h1>Himalaya Robotics Hack</h1>
    <script id="__NEXT_DATA__" type="application/json">
      {"description":"a hackathon hackathon hackathon","tracking":"hackathon"}
    </script>
    <style>.hackathon { color: red }</style>
    <p>Two days of robotics.</p>
  </body></html>`;
  const text = visibleText(html);
  assert.match(text, /Himalaya Robotics Hack/);
  assert.match(text, /Two days of robotics\./);
  // __NEXT_DATA__ is a hundred kilobytes of JSON on a real Luma page and would
  // match anything the classifier looks for.
  assert.ok(
    !/hackathon/i.test(text),
    `hydration JSON leaked into visible text: ${text}`,
  );
});

test("entities are decoded rather than left as markup", () => {
  assert.equal(visibleText("<p>Ben &amp; Co &#39;26 &nbsp;build</p>").trim(), "Ben & Co '26 build");
});

test("an event card's title is read from aria-label when its text is blank", () => {
  // Luma's real markup: the anchor's only child is a non-breaking space.
  const html =
    '<a aria-label="Agent Forge AI Hackathon Seoul" class="event-link" href="/agentforgeseoul">&nbsp;</a>' +
    '<a href="/other">Plain text link</a>';
  const links = linksFromHtml(html);
  assert.deepEqual(
    links.map((link) => [link.href, link.text]),
    [
      ["/agentforgeseoul", "Agent Forge AI Hackathon Seoul"],
      ["/other", "Plain text link"],
    ],
  );
});

test("JSON-LD events are found through an ItemList and keep their address", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "ItemList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: {
          "@type": "Event",
          "@id": "https://luma.com/qa11srwr",
          name: "Himalaya Robotics Hack",
          startDate: "2026-08-29T09:00:00.000-07:00",
          location: {
            "@type": "Place",
            name: "San Francisco",
            address: {
              "@type": "PostalAddress",
              addressLocality: "San Francisco",
              addressRegion: "California",
            },
          },
          offers: [{ "@type": "Offer", availability: "https://schema.org/InStock" }],
        },
      },
    ],
  })}</script>`;
  const events = structuredEventsFromHtml(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "Himalaya Robotics Hack");
  assert.equal(events[0].url, "https://luma.com/qa11srwr");
  assert.deepEqual(events[0].location, {
    name: "San Francisco",
    city: "San Francisco",
    region: "California",
  });
  assert.equal(events[0].offerAvailability, "https://schema.org/InStock");
});

test("a rate limit served as 200 is a failure, not an empty page", () => {
  // Luma's real behaviour: HTTP 200, 34KB of well-formed HTML, no JSON-LD. Read
  // as content it silently costs a page its dates, which is how four real
  // hackathons reached the board with no start time at all.
  assert.ok(
    looksLikeRefusal({
      title: "Rate Limit Hit · Luma",
      bodyText: "Rate Limit Hit",
      structuredEvents: [],
    }),
  );
  // A challenge page whose title gives nothing away still says so in its body.
  assert.ok(
    looksLikeRefusal({
      title: "Luma",
      bodyText: "Just a moment while we verify you are human",
      structuredEvents: [],
    }),
  );
  // A real event page is never mistaken for one, even if its copy happens to
  // mention limits.
  assert.equal(
    looksLikeRefusal({
      title: "HackwithSF · Luma",
      bodyText: "Spots are limited. Too many requests to attend.",
      structuredEvents: [{ name: "HackwithSF" }],
    }),
    null,
  );
});

test("throttling is recognised whether it is disguised or honest", () => {
  // Both shapes are real: Luma sends a 200 with a rate-limit page under light
  // pressure and an honest 429 under heavy pressure. Counting only the first is
  // what let a sweep report zero refusals while a third of its reads failed.
  assert.equal(isThrottled(new Error("refused: Rate Limit Hit · Luma")), true);
  assert.equal(isThrottled(new Error("HTTP 429")), true);
  assert.equal(isThrottled(new Error("HTTP 503")), true);
  assert.equal(isThrottled(new Error("HTTP 404")), false);
  assert.equal(isThrottled(new Error("not HTML (application/pdf)")), false);
});

test("the pacer slows down when it is told it is being throttled", () => {
  const pace = createPacer(100, { maxIntervalMs: 800 });
  assert.equal(pace.interval(), 100);
  assert.equal(pace.backOff(), 200);
  assert.equal(pace.backOff(), 400);
  assert.equal(pace.backOff(), 800);
  // Capped, so a bad run cannot stall the sweep entirely.
  assert.equal(pace.backOff(), 800);
});

test("a malformed JSON-LD block does not lose a good one beside it", () => {
  const html =
    '<script type="application/ld+json">{ not json }</script>' +
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Event",
      name: "HackwithSF",
      url: "https://luma.com/tt7dtxvf",
    })}</script>`;
  const events = structuredEventsFromHtml(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "HackwithSF");
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

test("a blank BRIGHTDATA_SERP_ZONE falls back rather than being sent as empty", async () => {
  // An unset GitHub secret interpolates to "", not undefined, so `??` let it
  // through and every CI sweep sent zone:"" and got 400 `"zone" is not allowed
  // to be empty`. The search leg exits 0 by design, so this failed in silence.
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ organic: [] }),
    };
  };

  const previous = process.env.BRIGHTDATA_SERP_ZONE;
  try {
    process.env.BRIGHTDATA_SERP_ZONE = "";
    await brightDataSearch("hackathon sf", { apiKey: "test", fetchImpl, attempts: 1 });
    assert.equal(sent[0].zone, "serp_api", "blank env zone must fall back to the default");

    process.env.BRIGHTDATA_SERP_ZONE = "my_zone";
    await brightDataSearch("hackathon sf", { apiKey: "test", fetchImpl, attempts: 1 });
    assert.equal(sent[1].zone, "my_zone", "a real env zone must still win");

    await brightDataSearch("hackathon sf", {
      apiKey: "test",
      fetchImpl,
      attempts: 1,
      zone: "explicit_zone",
    });
    assert.equal(sent[2].zone, "explicit_zone", "an explicit zone must still win");

    await brightDataSearch("hackathon sf", { apiKey: "test", fetchImpl, attempts: 1, zone: "" });
    assert.equal(sent[3].zone, "my_zone", "an explicitly blank zone is absent, not empty");
  } finally {
    if (previous === undefined) delete process.env.BRIGHTDATA_SERP_ZONE;
    else process.env.BRIGHTDATA_SERP_ZONE = previous;
  }
});

test("a misconfigured search leg is told apart from a blocked one", () => {
  // The health gate fails on the first kind and only warns on the second. It
  // used to do neither: it read the cumulative seed count instead of the
  // recorded problems, so four days of 400 `"zone" is not allowed to be empty`
  // were reported as "search: 24 seeds via brightdata".
  for (const error of [
    "brightdata HTTP 401: Auth method is not supported",
    "brightdata HTTP 400: Request validation failed",
    '"zone" is not allowed to be empty',
  ]) {
    assert.ok(isMisconfiguration({ error }), `should fail the run: ${error}`);
  }

  // Blocked, throttled, or merely unlucky — expected on a CI runner, and it
  // fixes itself. Failing on these would cry wolf twice a day.
  for (const error of [
    "HTTP 403",
    "brightdata expect_body: empty body",
    "brightdata HTTP 429 failed_query_rejected",
    "brightdata: AbortError timeout",
    "HTTP 502",
  ]) {
    assert.ok(!isMisconfiguration({ error }), `should only warn: ${error}`);
  }

  // Both file shapes, plus nothing at all.
  assert.ok(isMisconfiguration("brightdata HTTP 401: Auth method is not supported"));
  assert.ok(!isMisconfiguration(undefined));
  assert.ok(!isMisconfiguration({}));
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

// --- two regions, one board -------------------------------------------------

test("an area name means one place across every region", () => {
  // areaForCity searches every region, and the board prints an area on its own
  // ("Peninsula", "North County"), so a name used by two regions would be wrong
  // on the page as well as ambiguous here.
  const seen = new Map();
  for (const [key, region] of Object.entries(regionsOf(config))) {
    for (const area of Object.keys(region.areas ?? {})) {
      assert.ok(
        !seen.has(area),
        `area "${area}" is declared by both ${seen.get(area)} and ${key}`,
      );
      seen.set(area, key);
    }
  }
});

test("a city is claimed by exactly one region", () => {
  const owner = new Map();
  for (const [key, region] of Object.entries(regionsOf(config))) {
    for (const cities of Object.values(region.areas ?? {})) {
      for (const city of cities) {
        const lower = city.toLowerCase();
        assert.ok(
          !owner.has(lower),
          `"${city}" is claimed by both ${owner.get(lower)} and ${key}`,
        );
        owner.set(lower, key);
      }
    }
  }
});

test("place terms are the regions' own cities, not a second list", () => {
  const terms = placeTerms(config);
  assert.ok(terms.includes("san francisco"));
  assert.ok(terms.includes("san diego"));
  assert.ok(terms.includes("la jolla"));
  assert.equal(terms.length, localCities.size);
  // Longest first, so a city that is a prefix of another cannot win the match.
  const lengths = terms.map((term) => term.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
  // And the pattern built from them still finds a city inside a longer string.
  assert.equal(patterns.place.test("Rancho Bernardo Inn, San Diego, CA"), true);
});

test("an area belongs to the region that declared it", () => {
  assert.equal(areaForCity("San Francisco", config), "SF");
  assert.equal(areaForCity("Oceanside", config), "North County");
  assert.equal(areaForCity("Chula Vista", config), "South County");
  // Not a city any region names: no area to give it, and the caller decides.
  assert.equal(areaForCity("Austin", config), null);
  assert.equal(areaForCity(null, config), null);
});

test("every published event is filed under the region that serves its city", () => {
  for (const event of board.events) {
    assert.ok(event.region, `${event.title} has no region`);
    assert.ok(
      regionsOf(config)[event.region],
      `${event.title} is filed under unknown region ${event.region}`,
    );
    if (!event.city) continue; // no city: filed under the default region
    assert.equal(
      resolveRegion({ city: event.city }, config),
      event.region,
      `${event.title} is in ${event.city} but filed under ${event.region}`,
    );
  }
});

// --- MLH's timestamps, which are days as often as they are times ------------

test("an MLH timestamp with junk seconds becomes the day MLH prints", () => {
  // Diamondhacks, verbatim from MLH's 2027 season, which prints "APR 04 - 05".
  // Read as an instant in Pacific it is 6:11pm on 3 April: a day early, at a
  // time nobody stated.
  const schedule = mlhSchedule("2027-04-04T01:11:11Z", "2027-04-05T23:59:59Z", TZ);
  assert.equal(schedule.dateOnly, true);
  assert.equal(pacific(schedule.startMs), "4/4/2027, 12:00 AM");
  assert.equal(pacific(schedule.endMs), "4/5/2027, 11:59 PM");
});

test("an MLH timestamp on the minute is left as the time it states", () => {
  // DataHacks and Hard Hack, also verbatim. Both are real starts, and the
  // normalizer's own early-hour guard is what judges them from here.
  const data = mlhSchedule("2026-04-18T12:00:00Z", "2026-04-19T21:00:00Z", TZ);
  assert.equal(data.dateOnly, false);
  assert.equal(data.startMs, Date.parse("2026-04-18T12:00:00Z"));
  const hard = mlhSchedule("2026-01-24T14:45:00Z", "2026-01-25T19:00:00Z", TZ);
  assert.equal(hard.dateOnly, false);
  assert.equal(pacific(hard.startMs), "1/24/2026, 6:45 AM");
});

test("an MLH event with no readable start is refused rather than guessed", () => {
  assert.equal(mlhSchedule(null, null, TZ), null);
  assert.equal(mlhSchedule("not a date", "2027-04-05T23:59:59Z", TZ), null);
});
