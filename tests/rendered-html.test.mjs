import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const eventsData = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
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

test("events.json only contains upcoming, fully-normalized events", () => {
  const sweepTime = new Date(eventsData.meta.sweepCompletedAt).getTime();
  assert.ok(eventsData.events.length > 0, "expected at least one event");
  const dated = eventsData.events.filter((e) => e.start && e.end);
  assert.ok(
    dated.length >= eventsData.events.length * 0.8,
    "most events should have parsed dates — check the evidence time format",
  );
  const ids = new Set();
  // Scoped to the default view: adjacent events live behind the "Everything"
  // filter, so they are legitimately absent from the first paint.
  for (const event of eventsData.events.filter(
    (candidate) => candidate.category === "hackathon",
  )) {
    assert.match(event.url, /^https:\/\//);
    assert.ok(["luma", "external"].includes(event.platform));
    assert.ok(["hackathon", "adjacent"].includes(event.category));
    assert.ok(!ids.has(event.id), `duplicate event id: ${event.id}`);
    ids.add(event.id);
    assert.ok(event.title.length > 3);
    assert.ok(event.organizer.length > 0);
    assert.ok(event.score >= 0 && event.score <= 100);
    if (event.end) {
      assert.ok(
        new Date(event.end).getTime() >= sweepTime,
        `${event.title} already ended before the sweep`,
      );
    }
  }
});

test("server-renders the ranked event board", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Hacklist/);
  assert.match(html, /What&#x27;s coming up|What.s coming up/);
  assert.match(html, /hackathons/i);
  // Every event must be a real anchor to its own page. The listing is only
  // useful if it goes somewhere, and a styling or markup change should not be
  // able to quietly turn the titles back into plain text.
  // Scoped to the default view: adjacent events live behind the "Everything"
  // filter, so they are legitimately absent from the first paint.
  for (const event of eventsData.events.filter(
    (candidate) => candidate.category === "hackathon",
  )) {
    assert.ok(
      html.includes(`href="${event.url}"`),
      `${event.title} is not hyperlinked on the board`,
    );
  }
});

test("serves an ICS feed with one VEVENT per dated event", async () => {
  const response = await render("/calendar.ics");
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/calendar\b/i,
  );

  const ics = await response.text();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.match(ics, /X-WR-CALNAME:Hacklist SF/);

  // Every event with a date is in the feed. Ones whose time we do not trust go in
  // as all-day entries rather than being withheld — the day is solid, and an
  // all-day row claims no hour.
  const datedEvents = eventsData.events.filter((e) => e.start);
  const vevents = ics.match(/BEGIN:VEVENT/g) ?? [];
  assert.equal(vevents.length, datedEvents.length);
  // Unfold folded lines before checking content.
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  for (const event of datedEvents) {
    assert.ok(
      unfolded.includes(`UID:${event.id}@hacklist-sf`),
      `missing VEVENT for ${event.title}`,
    );
  }
  assert.match(unfolded, /DTSTART;TZID=America\/Los_Angeles:\d{8}T\d{6}/);

  // An event whose hour we do not believe must appear as an all-day entry, never
  // with an invented clock time. Devpost publishes dates and no times at all, so
  // this is the normal case for that source rather than an edge case.
  const unverified = eventsData.events.filter(
    (event) => event.start && (!event.end || event.timeUnverified === true),
  );
  for (const event of unverified) {
    const vevent = unfolded
      .split("BEGIN:VEVENT")
      .find((block) => block.includes(`UID:${event.id}@hacklist-sf`));
    assert.ok(vevent, `missing VEVENT for ${event.title}`);
    assert.match(
      vevent,
      /DTSTART;VALUE=DATE:\d{8}/,
      `${event.title} has an unverified time and must be an all-day entry`,
    );
    assert.doesNotMatch(
      vevent,
      /DTSTART;TZID=/,
      `${event.title} must not claim a clock time`,
    );
    // All-day DTEND is exclusive, so it must be strictly after DTSTART.
    const start = vevent.match(/DTSTART;VALUE=DATE:(\d{8})/)?.[1];
    const end = vevent.match(/DTEND;VALUE=DATE:(\d{8})/)?.[1];
    assert.ok(start && end, `${event.title} needs both all-day bounds`);
    assert.ok(
      Number(end) > Number(start),
      `${event.title} all-day DTEND ${end} must be after DTSTART ${start}`,
    );
  }
});
