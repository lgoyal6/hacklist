// What is actually on a Luma calendar, read from Luma's own public API.
//
// The sync used to answer this by scrolling the admin page and reading the rows
// it could see. That list is virtualized, so a row far enough down it is never
// mounted and never read -- and "I did not see it" was treated as "it is not
// there". For a Luma-hosted event that is merely a wasted retry, because Luma
// refuses a duplicate submission and says so. For an external event there is no
// such refusal: every retry adds another copy. That is how the Bay Area calendar
// ended up with eight copies of SF Hacks and three of DeveloperWeek 2027, both
// of them events far enough in the future to sit at the bottom of a 69-row list.
//
// api.lu.ma/calendar/get-items answers exactly, in one request, from any
// address, with no key. It is the same endpoint the sync already used to read
// back stored start times; it just was not trusted with the question that
// mattered.
const API = "https://api.lu.ma";
const TIMEOUT_MS = 20_000;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "hacklist" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * The calendar's api_id, from whatever URL the ledger recorded.
 *
 * A calendar resolved from the signed-in Calendars list is recorded as
 * luma.com/calendar/manage/cal-..., which carries the id already. One added by
 * hand with `--calendar https://luma.com/<slug>` is recorded by its slug, and
 * only api.lu.ma/url can turn that into an id.
 */
export async function calendarApiId(recordedUrl) {
  if (!recordedUrl) return null;
  const direct = recordedUrl.match(/cal-[A-Za-z0-9]+/)?.[0];
  if (direct) return direct;
  let slug;
  try {
    slug = new URL(recordedUrl).pathname
      .replace(/^\/+/, "")
      .replace(/\/manage.*$/, "");
  } catch {
    return null;
  }
  if (!slug) return null;
  try {
    const resolved = await getJson(`${API}/url?url=${encodeURIComponent(slug)}`);
    return resolved?.data?.calendar?.api_id ?? resolved?.data?.api_id ?? null;
  } catch {
    return null;
  }
}

/** One page after another until the feed runs out. */
async function items(calendarId, period) {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${API}/calendar/get-items`);
    url.searchParams.set("calendar_api_id", calendarId);
    url.searchParams.set("pagination_limit", "100");
    url.searchParams.set("period", period);
    if (cursor) url.searchParams.set("pagination_cursor", cursor);
    const body = await getJson(url);
    const batch = body.entries ?? [];
    entries.push(...batch);
    if (!batch.length || !body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return entries;
}

/** Fold API entries into the shape isOnCalendar() already reads. */
export function stateFromEntries(entries) {
  const slugs = new Set();
  const titles = new Set();
  const startsByName = new Map();
  for (const entry of entries) {
    const event = entry.event ?? {};
    if (event.url) slugs.add(String(event.url));
    if (event.name) {
      titles.add(String(event.name));
      const key = String(event.name).replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (key) startsByName.set(key, event.start_at ?? null);
    }
  }
  return { slugs, titles, startsByName };
}

/**
 * Everything on the calendar, upcoming and past.
 *
 * Past matters as much as future: an event whose start has gone by moves tabs,
 * and a reconcile that only looked forward would un-record it and offer it
 * again.
 */
export async function readCalendarState(calendarId) {
  const entries = [
    ...(await items(calendarId, "future")),
    ...(await items(calendarId, "past")),
  ];
  return { ...stateFromEntries(entries), entryCount: entries.length };
}
