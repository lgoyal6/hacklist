// Parsers for DEV's challenge index and challenge pages, kept apart from the
// pass so they can be tested against fixed markup without a network.

export function decode(text) {
  return String(text ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every challenge card on the index, current and past. */
export function parseListing(html) {
  const out = new Map();
  const card =
    /<a[^>]+class="challenge-index-card challenge-index-card--(\w+)"[^>]*href="(https:\/\/dev\.to\/challenges\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html ?? "").matchAll(card)) {
    const [, state, url, body] = m;
    if (out.has(url)) continue;
    const title = decode(
      (body.match(/challenge-index-card__title">([\s\S]*?)<\/h3>/) ?? [])[1],
    );
    const subtitle = decode(
      (body.match(/challenge-index-card__subtitle">([\s\S]*?)<\/p>/) ?? [])[1],
    );
    const status = decode(
      (body.match(/challenge-index-card__status[^"]*">([\s\S]*?)<\/span>/) ?? [])[1],
    );
    if (!title) continue;
    out.set(url, { url, state, title, subtitle, status });
  }
  return [...out.values()];
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "September 18, 2026" or "Sep 18, 2026" to {year, month, day}. */
export function parseDate(text) {
  const m = String(text ?? "").match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (month < 0) return null;
  return { year: Number(m[3]), month: month + 1, day: Number(m[2]) };
}

/**
 * The "Key Dates" sidebar and the prize. The prize is read only from a figure
 * written next to the word "prize" ("$2,500 in prizes"), not the largest figure
 * on the page, so a sponsor's pricing or a credits offer is never read as it.
 */
export function parseDetail(html) {
  const text = decode(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  const start = parseDate((text.match(/Contest start:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i) ?? [])[1]);
  const due = parseDate((text.match(/Submissions due:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i) ?? [])[1]);
  let prize = 0;
  const near = /\$\s?([\d,]+)\s*(k)?\s+(?:in\s+)?(?:cash\s+)?prizes?/gi;
  for (const m of text.matchAll(near)) {
    const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1e3 : 1);
    if (Number.isFinite(n)) prize = Math.max(prize, n);
  }
  return { start, due, prize, text: text.slice(0, 1200) };
}
