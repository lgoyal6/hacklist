// Reading a page over plain HTTP, in the shape the sweep's browser extractor
// returns.
//
// Why this exists: for luma.com the headless browser is a liability, not an
// asset. Lightpanda renders the page chrome and stops -- luma.com/qa11srwr is
// 163KB of HTML and 1,725 characters of innerText, with the entire "About
// Event" body missing, the one place the word "hackathon" appears (ten times).
// That cost the classifier its evidence and left a real hackathon scoring 52
// against a threshold of 54. It is not a timing problem: the rendered text is
// byte-identical at a 350ms settle and at 8s.
//
// The same document over `fetch` arrives complete in about 0.3s, which is both
// faster than the browser and strictly more content. So Luma pages are read
// this way and the browser is kept for sources that genuinely need script
// execution.
//
// Deliberately not a DOM. A real parser would be more correct and would also be
// a dependency; the sweep only needs visible text, anchors and JSON-LD, and
// those survive regex extraction from Luma's server-rendered markup.

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const LD_JSON =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const ATTR = (name) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const HREF = ATTR("href");
const ARIA_LABEL = ATTR("aria-label");
const TITLE_ATTR = ATTR("title");

const ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const known = ENTITIES[name.toLowerCase()] ?? ENTITIES[name];
    if (known !== undefined) return known;
    if (/^#x/i.test(name)) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (/^#/.test(name)) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

const attr = (raw, pattern) => {
  const match = raw.match(pattern);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  return value ? decodeEntities(value).trim() : null;
};

/** Tag-stripped text, the nearest honest equivalent of document.body.innerText. */
export function visibleText(html) {
  return decodeEntities(
    html
      // Script and style content is not visible text, and __NEXT_DATA__ alone
      // would otherwise add a hundred kilobytes of JSON to every page's
      // "evidence" and match anything the classifier looks for.
      .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ​]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Anchors, with the text the sweep matches its vocabulary against.
 *
 * aria-label is not a nicety here: Luma's event cards render as an anchor whose
 * only child is a non-breaking space, with the event's name in aria-label. Read
 * inner text alone and every event link on a calendar page looks untitled.
 */
export function linksFromHtml(html) {
  const links = [];
  for (const [, rawAttrs, inner] of html.matchAll(ANCHOR)) {
    const href = attr(rawAttrs, HREF);
    if (!href) continue;
    const ownText = visibleText(inner).replace(/\s+/g, " ").trim();
    const text =
      ownText.length > 1
        ? ownText
        : attr(rawAttrs, ARIA_LABEL) || attr(rawAttrs, TITLE_ATTR) || ownText;
    links.push({ href, text: text ?? "" });
  }
  return links;
}

/** Every schema.org Event in the page's JSON-LD, in the sweep's event shape. */
export function structuredEventsFromHtml(html) {
  const events = [];
  const seen = new Set();
  const types = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);
  const organizerNames = (organizer) =>
    (Array.isArray(organizer) ? organizer : [organizer])
      .map((item) => (typeof item === "string" ? item : item?.name))
      .filter(Boolean);

  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (types(value["@type"]).includes("Event")) {
      const address = value.location?.address;
      const event = {
        url: value.url || value["@id"] || null,
        name: value.name || null,
        description: value.description || null,
        startDate: value.startDate || null,
        endDate: value.endDate || null,
        attendanceMode: value.eventAttendanceMode || null,
        eventStatus: value.eventStatus || null,
        location: {
          name: value.location?.name || null,
          city: (typeof address === "object" && address?.addressLocality) || null,
          region: (typeof address === "object" && address?.addressRegion) || null,
        },
        organizers: organizerNames(value.organizer),
        offerAvailability:
          (Array.isArray(value.offers) ? value.offers : [value.offers])
            .map((offer) => offer?.availability)
            .find(Boolean) || null,
      };
      const key = `${event.url || event.name}|${event.startDate || ""}`;
      if (event.name && !seen.has(key)) {
        seen.add(key);
        events.push(event);
      }
    }
    Object.values(value).forEach(walk);
  };

  for (const [, block] of html.matchAll(LD_JSON)) {
    try {
      walk(JSON.parse(block));
    } catch {
      // Ignore malformed third-party JSON-LD blocks, as the browser path does.
    }
  }
  return events;
}

export function extractFromHtml(html) {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    bodyText: visibleText(html),
    links: linksFromHtml(html),
    structuredEvents: structuredEventsFromHtml(html),
  };
}

/**
 * Pages that answer 200 while carrying no content: a rate limit, a bot
 * challenge, an interstitial.
 *
 * This is not a theoretical case. Luma serves "Rate Limit Hit" as a 200 with
 * 34KB of perfectly well-formed HTML, and because only `!response.ok` was
 * checked, a limited read looked like a successful one. The page simply had no
 * JSON-LD, so four real hackathons were published with no date at all rather
 * than being retried or reported. A read that cannot be told from a failure is
 * worse than a failure.
 */
const REFUSAL_TITLE =
  /rate limit|too many requests|are you (a )?human|just a moment|access denied|attention required|unusual traffic|verify you are/i;

export function looksLikeRefusal({ title, bodyText, structuredEvents }) {
  if (REFUSAL_TITLE.test(title)) return title.trim() || "refused";
  // A challenge page with an innocuous title still says so in its body, and a
  // real event page always carries JSON-LD, so the pair is safe to require.
  if (!structuredEvents.length && REFUSAL_TITLE.test(bodyText.slice(0, 400))) {
    return "refusal in body text";
  }
  return null;
}

/**
 * Fetch and extract a page. Returns the browser extractor's shape so callers can
 * use either interchangeably; throws so a caller can fall back to the browser.
 */
export async function fetchPage(url, { timeoutMs = 15_000, userAgent } = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent ?? DEFAULT_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) {
    throw new Error(`not HTML (${type.split(";")[0]})`);
  }
  const extracted = extractFromHtml(await response.text());
  const refusal = looksLikeRefusal(extracted);
  if (refusal) throw new Error(`refused: ${refusal}`);
  return extracted;
}

/**
 * Space out requests to one host, and slow down when told to.
 *
 * 300 page reads in a sweep is enough to earn a rate limit from Luma, and four
 * sweeps in an hour is enough to earn a hard 429 on everything. A fixed interval
 * cannot know that, so the caller reports refusals back and the interval grows:
 * a sweep that is being throttled should get slower on its own rather than
 * spending its page budget on rejections.
 */
export function createPacer(minIntervalMs, { maxIntervalMs = 4_000 } = {}) {
  let next = 0;
  let interval = minIntervalMs;
  const pace = async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  pace.backOff = () => {
    interval = Math.min(maxIntervalMs, Math.max(minIntervalMs, interval * 2));
    return interval;
  };
  pace.interval = () => interval;
  return pace;
}

/** Does this failure mean "you are asking too often"? */
export function isThrottled(error) {
  return /\brefused:|\bHTTP (429|503)\b/.test(String(error));
}

