// Parsing for HackerRank's pages, kept apart from the fetching so it can be
// tested without the network. See scripts/discover-hackerrank.mjs.
const BASE = "https://www.hackerrank.com";

export function pageText(html) {
  return String(html ?? "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const titleOf = (html) =>
  ((html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s*[:|]\s*HackerRank( Engage)?\s*$/i, "")
    .trim();

/** Event URLs from the promoted cards on /contests. */
export function promotedEvents(html) {
  const urls = new Set();
  for (const m of String(html ?? "").matchAll(/promoted-contest-v2__card[^>]*data-attr1="([^"]+)"/g)) {
    if (m[1].startsWith(`${BASE}/event/`)) urls.add(m[1]);
  }
  return [...urls];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Engage pages give the challenge start as "October 30, 7:15 AM (GMT)" followed
 * by "Duration: 9 Days, 22 Hours", with no year. The start nearest before the
 * duration is the one that belongs to it; the registration close comes earlier
 * on the page with the same shape. A start that has already passed by more than
 * the duration is next year's.
 */
export function engageDates(text, now = new Date()) {
  const duration = text.match(/Duration:\s*(?:(\d+)\s*Days?)?[,\s]*(?:(\d+)\s*Hours?)?/i);
  if (!duration || (!duration[1] && !duration[2])) return null;
  const before = text.slice(0, duration.index);
  const starts = [...before.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(GMT\)/gi)];
  const last = starts.at(-1);
  if (!last) return null;
  let hour = Number(last[3]) % 12;
  if (/pm/i.test(last[5])) hour += 12;
  const month = MONTHS.indexOf(last[1].toLowerCase());
  const lengthMs = ((Number(duration[1] ?? 0) * 24) + Number(duration[2] ?? 0)) * 3_600_000;
  let start = new Date(Date.UTC(now.getUTCFullYear(), month, Number(last[2]), hour, Number(last[4])));
  if (start.getTime() + lengthMs < now.getTime()) {
    start = new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(last[2]), hour, Number(last[4])));
  }
  return { start, end: new Date(start.getTime() + lengthMs) };
}

