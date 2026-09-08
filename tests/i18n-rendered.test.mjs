// What localization is allowed to change, and what it must never touch.
//
// The board reads in English at / and in Spanish at /es. The words move; the
// events, their identities, their instants and the feed people subscribe to do
// not. Each test here is one clause of that contract, rendered through the
// same built worker the deploy serves.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatEventDate, zoneParts } from "../app/i18n/dates.mjs";

const eventsData = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);
const en = JSON.parse(
  await readFile(new URL("../app/i18n/en.json", import.meta.url), "utf8"),
);
const es = JSON.parse(
  await readFile(new URL("../app/i18n/es.json", import.meta.url), "utf8"),
);

async function render(path, headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

const defaultRegion = eventsData.meta.defaultRegion;
const regionOf = (event) => event.region ?? defaultRegion;
function isUpcoming(event) {
  const over = Date.parse(event.end ?? event.start ?? "");
  return !Number.isFinite(over) || over >= Date.now();
}

/** A minimal translator over a raw catalog, for driving dates.mjs directly. */
const translatorOf = (catalog) => (key, vars) => {
  let text = catalog[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

test("the Spanish board is Spanish chrome around unchanged events", async () => {
  const response = await render("/es");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<html[^>]*lang="es"/);
  // Spanish chrome, spot-checked across the page: subscribe block, filters,
  // search, footer.
  for (const key of [
    "masthead.subscribe",
    "subscribe.title",
    "subscribe.body",
    "views.everything",
    "listing.title",
    "listing.searchPlaceholder",
    "footer.backToTop",
  ]) {
    assert.ok(
      html.includes(es[key]),
      `/es is missing the Spanish for ${key}: ${JSON.stringify(es[key])}`,
    );
  }
  // And none of the English it replaces.
  assert.ok(!html.includes(en["subscribe.title"]), "English chrome leaked into /es");

  // Titles and organizer copy are data, not chrome: they appear exactly as the
  // organizer wrote them, hyperlinked to the same event pages as the English
  // board. No authoritative translation exists, so nothing may be translated.
  for (const event of eventsData.events.filter(
    (candidate) =>
      candidate.category === "hackathon" &&
      isUpcoming(candidate) &&
      regionOf(candidate) === defaultRegion,
  )) {
    assert.ok(
      html.includes(`href="${event.url}"`),
      `${event.title} is not hyperlinked on the Spanish board`,
    );
  }
});

test("the English board at / is untouched by the second language existing", async () => {
  const html = await (await render("/")).text();
  assert.match(html, /<html[^>]*lang="en"/);
  assert.ok(html.includes(en["subscribe.title"]));
  assert.ok(!html.includes(es["subscribe.title"]));
});

test("an unknown locale falls back to the English board, stated as English", async () => {
  // A page in the wrong language is read once and corrected in one click, so
  // /fr serves English rather than a dead end - and the <html lang> must say
  // what was actually rendered, not what the URL asked for.
  for (const path of ["/fr", "/de", "/xx"]) {
    const response = await render(path);
    assert.equal(response.status, 200, `${path} did not serve`);
    const html = await response.text();
    assert.match(html, /<html[^>]*lang="en"/, `${path} misstates its language`);
    assert.ok(
      html.includes(en["subscribe.title"]),
      `${path} did not fall back to English chrome`,
    );
    assert.ok(
      !html.includes(es["subscribe.title"]),
      `${path} served Spanish for a locale nobody defined`,
    );
  }
});

test("no internal message key appears as copy in either locale", async () => {
  for (const path of ["/", "/es"]) {
    const html = await (await render(path)).text();
    // Dotted keys are not words, so the blunt check holds: a raw key must not
    // be anywhere in the document, as copy, as an attribute, or in the flight
    // payload.
    for (const key of Object.keys(en)) {
      assert.ok(!html.includes(key), `${path} contains the raw key ${key}`);
    }
  }
});

test("the calendar feed is one artifact: byte-identical whatever language asks", async () => {
  // The feed is what people subscribe to. If locale could reach it, switching
  // language would fork subscriptions; so the same bytes must come back for
  // any Accept-Language, on every region's feed.
  for (const region of eventsData.meta.regions) {
    const path =
      region.key === defaultRegion
        ? "/calendar.ics"
        : `/calendar.ics?region=${region.key}`;
    const asEnglish = await (
      await render(path, { accept: "text/calendar", "accept-language": "en-US,en;q=0.9" })
    ).text();
    const asSpanish = await (
      await render(path, { accept: "text/calendar", "accept-language": "es-ES,es;q=0.9" })
    ).text();
    assert.ok(
      asEnglish === asSpanish,
      `${path} served different bytes for different Accept-Language headers`,
    );
    // Event identity in particular: the same UIDs, in the same order.
    const uids = (ics) => ics.replace(/\r\n[ \t]/g, "").match(/^UID:.*$/gm) ?? [];
    assert.deepEqual(uids(asSpanish), uids(asEnglish));
  }
});

test("both boards name the same feed, so switching language cannot mint a second subscription", async () => {
  const english = await (await render("/")).text();
  const spanish = await (await render("/es")).text();
  // The server snapshot prints the path itself in the subscribe block.
  for (const [name, html] of [["/", english], ["/es", spanish]]) {
    assert.ok(
      html.includes('<code title="/calendar.ics">'),
      `${name} does not present the shared /calendar.ics feed`,
    );
  }
  // And no locale-scoped feed exists to subscribe to by accident.
  assert.ok(!spanish.includes("/es/calendar.ics"), "the Spanish board invented its own feed");
  const response = await render("/es/calendar.ics", { accept: "text/calendar" });
  assert.notEqual(response.status, 200, "/es/calendar.ics must not serve a second feed");
});

test("the unknown-region refusal, the one human sentence the feed says, follows the reader's language", async () => {
  const inEnglish = await render("/calendar.ics?region=atlantis");
  assert.equal(inEnglish.status, 404);
  assert.match(await inEnglish.text(), /Unknown region "atlantis"/);

  const inSpanish = await render("/calendar.ics?region=atlantis", {
    "accept-language": "es-ES,es;q=0.9",
  });
  assert.equal(inSpanish.status, 404);
  const body = await inSpanish.text();
  assert.match(body, /Región desconocida "atlantis"/);
  // Still naming every real region, or the mistyped URL is a dead end.
  for (const region of eventsData.meta.regions) {
    assert.ok(body.includes(region.key), `Spanish 404 does not mention ${region.key}`);
  }
});

test("a locale changes the words of a date, never the instant, across a DST boundary", () => {
  const zone = "America/Los_Angeles";
  // Around the 2026 transitions: spring forward (Mar 8, 02:00 -> 03:00) and
  // fall back (Nov 1, 02:00 -> 01:00). Each ISO instant below is absolute;
  // both locales must place it at the identical wall clock in the zone.
  const instants = [
    "2026-03-08T01:59:00-08:00", // last PST minute before the jump
    "2026-03-08T03:00:00-07:00", // first PDT minute after it
    "2026-11-01T01:30:00-07:00", // 1:30 the first time (PDT)
    "2026-11-01T01:30:00-08:00", // 1:30 the second time (PST) - a different instant
    "2026-11-01T09:00:00-08:00",
  ];
  for (const iso of instants) {
    const utcMs = Date.parse(iso);
    const inEnglish = zoneParts(utcMs, zone, "en");
    const inSpanish = zoneParts(utcMs, zone, "es");
    for (const field of ["year", "month", "day", "hour", "minute"]) {
      assert.equal(
        inSpanish[field],
        inEnglish[field],
        `${iso}: locales disagree on ${field} (en=${inEnglish[field]}, es=${inSpanish[field]})`,
      );
    }
  }
  // The two 1:30s are genuinely different instants that share a wall clock:
  // that is the DST fold, and both locales must preserve it rather than
  // collapsing it through UTC or the host zone.
  const first = Date.parse("2026-11-01T01:30:00-07:00");
  const second = Date.parse("2026-11-01T01:30:00-08:00");
  assert.equal(second - first, 3600000);
  for (const locale of ["en", "es"]) {
    assert.equal(zoneParts(first, zone, locale).hour, 1, `${locale} lost the fold`);
    assert.equal(zoneParts(second, zone, locale).hour, 1, `${locale} lost the fold`);
  }

  // And a rendered event that spans the boundary: same day count, same start
  // day, in both languages.
  const spanning = {
    start: "2026-10-31T09:00:00-07:00",
    end: "2026-11-01T17:00:00-08:00",
    timezone: zone,
    timeUnverified: false,
  };
  const asEnglish = formatEventDate(spanning, "en", translatorOf(en));
  const asSpanish = formatEventDate(spanning, "es", translatorOf(es));
  assert.equal(asEnglish.label, "OCT 31");
  assert.equal(asSpanish.label, "31 OCT");
  assert.match(asEnglish.detail, /2 days$/);
  assert.match(asSpanish.detail, /2 días$/);
});

test("English date rendering reproduces the normalizer's precomputed strings exactly", () => {
  // Two implementations describe the same schedule: the normalizer writes
  // dateLabel/dateDetail into events.json, and app/i18n/dates.mjs renders the
  // board's. This holds them together over every event on the live board, so
  // neither can drift without turning a run red.
  const t = translatorOf(en);
  for (const event of eventsData.events) {
    const rendered = formatEventDate(event, "en", t);
    assert.equal(
      rendered.label,
      event.dateLabel,
      `${event.id}: label diverged from the normalizer`,
    );
    assert.equal(
      rendered.detail,
      event.dateDetail,
      `${event.id}: detail diverged from the normalizer`,
    );
  }
});
