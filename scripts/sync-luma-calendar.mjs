// Adds every published upcoming event to a Luma calendar so people can follow
// Hacklist SF on Luma itself. Requires LUMA_API_KEY — a calendar-scoped key
// from a calendar with Luma Plus (Settings -> Options -> API). Without the
// key this script exits quietly so the pipeline can always include it.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env.LUMA_API_KEY;

if (!apiKey) {
  console.log("LUMA_API_KEY not set; skipping Luma calendar sync.");
  process.exit(0);
}

const API = "https://public-api.luma.com";
const headers = {
  "x-luma-api-key": apiKey,
  "content-type": "application/json",
};

const { events } = JSON.parse(
  await readFile(resolve(root, "data/events.json"), "utf8"),
);

const statePath = resolve(root, "data/luma-sync.json");
let synced = new Set();
try {
  synced = new Set(JSON.parse(await readFile(statePath, "utf8")).synced);
} catch {
  // first sync
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDuration = (start, end) => {
  let seconds = Math.max(
    60,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000),
  );
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  const time = `${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}`;
  return `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
};
let added = 0;
let failed = 0;

for (const event of events) {
  const slug = event.id;
  if (synced.has(slug)) continue;

  let body;
  if (event.platform === "external") {
    if (!event.start || !event.end) {
      console.warn(`external event ${slug} has no complete schedule; skipping.`);
      failed += 1;
      continue;
    }
    body = {
      platform: "external",
      url: event.url,
      name: event.title,
      start_at: event.start,
      duration_interval: isoDuration(event.start, event.end),
      timezone: event.timezone,
      geo_address_json: null,
      host: event.organizer,
    };
  } else {
    const lookupResponse = await fetch(
      `${API}/v1/entities/lookup?slug=${encodeURIComponent(slug)}`,
      { headers },
    );
    if (!lookupResponse.ok) {
      console.warn(
        `lookup failed for ${slug}: ${lookupResponse.status} ${await lookupResponse.text()}`,
      );
      failed += 1;
      continue;
    }
    const { entity } = await lookupResponse.json();
    if (entity?.type !== "event" || !entity.event?.id) {
      console.warn(`slug ${slug} did not resolve to an event; skipping.`);
      failed += 1;
      continue;
    }

    const eventId = entity.event.id;
    body = {
      platform: "luma",
      ...(eventId.startsWith("evt-")
        ? { event_api_id: eventId }
        : { event_id: eventId }),
    };
  }
  const addResponse = await fetch(`${API}/v1/calendars/events/add`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (addResponse.ok) {
    synced.add(slug);
    added += 1;
    console.log(`added to Luma calendar: ${event.title}`);
  } else {
    const text = await addResponse.text();
    // "already listed" style responses are success for our purposes
    if (/already/i.test(text)) {
      synced.add(slug);
      console.log(`already on Luma calendar: ${event.title}`);
    } else {
      console.warn(`add failed for ${slug}: ${addResponse.status} ${text}`);
      failed += 1;
    }
  }
  await sleep(600); // stay well under API rate limits
}

await writeFile(
  statePath,
  `${JSON.stringify({ synced: [...synced].sort() }, null, 2)}\n`,
);
console.log(
  `Luma sync complete: ${added} added, ${failed} failed, ${synced.size} total tracked.`,
);
