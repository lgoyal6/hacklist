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
  for (const event of eventsData.events) {
    assert.match(event.url, /^https:\/\/luma\.com\//);
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
  assert.match(html, /HACKLIST/);
  assert.match(html, /SF signal board/);
  assert.match(html, /ranked events/);
  // The top-ranked event from the generated data must appear on the board.
  assert.ok(
    html.includes(eventsData.events[0].url),
    "top event link missing from rendered board",
  );
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

  const datedEvents = eventsData.events.filter((e) => e.start && e.end);
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
});
