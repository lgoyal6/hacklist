// Y Combinator events discovery.
//
// YC runs a lot of Bay Area hackathons on its own events site and never puts
// them on Luma, so the entire rest of the pipeline is blind to them — the
// sweep crawls outward from Luma calendars, and search discovery only accepts
// Luma permalinks. That is how "The Fast Hackathon" (Greptile's second, at YC
// on 23 Aug 2026) stayed off the board while it was open for applications.
//
// events.ycombinator.com is a client-rendered Inertia app: fetching it gets you
// an empty shell, which is why the headless sweep cannot read it either. But
// Inertia ships its props in a `data-page` attribute on the root element, so the
// event list arrives as clean structured JSON — title, slug, city, starts_at,
// ends_at, time_zone and an `event_type_label`. No browser, no API key, no
// third-party scraper needed for this one.
//
// Output is data/yc-candidates.json in the same candidate shape that
// scripts/discover-sf.mjs writes, and scripts/normalize-events.mjs merges the
// two. Every YC event is still scored and filtered like any other find.
//
// Never exits non-zero for a source problem: a sweep without YC is worth more
// than a sweep that did not run.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const outputPath = resolve(root, "data/yc-candidates.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const INDEX_URL = "https://www.ycombinator.com/events";
const EVENT_BASE = "https://events.ycombinator.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const candidatePattern = new RegExp(
  `(${config.candidateTerms.map(escapeTerm).join("|")})`,
  "i",
);
const placePattern = new RegExp(
  `\\b(${config.placeTerms.map(escapeTerm).join("|")})\\b`,
  "i",
);
// Same scoring vocabulary the sweep uses, so a YC candidate's confidence means
// the same thing as a Luma one's.
const buildPattern = /\b(build|prototype|ship|demo|project|team up|submission)\b/i;
const competitionPattern =
  /\b(prize|prizes|judg(?:e|es|ing)|winner|leaderboard|award|bounty|track)\b/i;
const negativeTitlePattern =
  /\b(meet[-\s]?ups?|conference|summit|webinar|expo|mixer|happy hour|fireside|panel|screening|dinner|networking|workshop|office hours|pitch night|demo night|launch party|party|social|talk|talks|showcase|open house|salons?|series|roundtable|symposium|forum|town hall|book club|concert|film)\b/i;

const localCities = new Set(
  Object.values(config.areas ?? {}).flat().map((city) => city.toLowerCase()),
);

/** Pull the Inertia props out of a server-rendered YC page. */
function inertiaProps(html) {
  const match = html.match(/data-page="([^"]*)"/);
  if (!match) return null;
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(decoded).props ?? null;
  } catch {
    return null;
  }
}

// Bounded like every other unattended network call in the pipeline: a socket
// that never answers must not hang a scheduled job.
const FETCH_TIMEOUT_MS = Number(process.env.YC_FETCH_TIMEOUT_MS ?? 20_000);

async function fetchProps(url) {
  const response = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const props = inertiaProps(await response.text());
  if (!props) return { error: "no data-page props" };
  return { props };
}

// --- timezone arithmetic ---------------------------------------------------
// The normalizer owns its own copy of this; duplicating a dozen lines beats
// exporting from a script that runs top-level work on import.

function zoneOffsetMinutes(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return (asUtc - utcMs) / 60_000;
}

function localToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = zoneOffsetMinutes(guess, timeZone);
  const corrected = guess - offset * 60_000;
  // One more pass settles the DST-boundary case.
  return corrected - (zoneOffsetMinutes(corrected, timeZone) - offset) * 60_000;
}

function zoneParts(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

const TIME_RANGE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

function toHour24(hourStr, meridiem) {
  let hour = Number(hourStr) % 12;
  if (/pm/i.test(meridiem)) hour += 12;
  return hour;
}

/**
 * YC's own start/end timestamps are frequently a placeholder: an organizer
 * enters a date and the record lands at local midnight with a three-hour
 * duration, while the description says "Sunday August 23rd 12pm-6pm". Trusting
 * the field would publish a hackathon that starts at midnight and runs three
 * hours, which is plainly wrong.
 *
 * So: keep YC's calendar date, and take the clock time from the description
 * whenever the stored one is not credible and the description states a range.
 * When neither is usable the timestamps are passed through untouched and the
 * normalizer's own "time we do not believe" guard publishes the date alone.
 */
function resolveSchedule(meetup) {
  const timeZone = meetup.time_zone || config.timezone;
  const startUtc = Date.parse(meetup.starts_at ?? "");
  const endUtc = Date.parse(meetup.ends_at ?? "");
  if (!Number.isFinite(startUtc)) return null;

  const start = zoneParts(startUtc, timeZone);
  const hours = Number.isFinite(endUtc) ? (endUtc - startUtc) / 3_600_000 : null;
  const suspect = start.hour < 6 || (hours !== null && hours < 1.5);
  if (!suspect) {
    return {
      startDate: new Date(startUtc).toISOString(),
      endDate: Number.isFinite(endUtc) ? new Date(endUtc).toISOString() : null,
      timeSource: "yc",
      timeZone,
    };
  }

  const range = (meetup.description ?? "").match(TIME_RANGE);
  if (!range) {
    return {
      startDate: new Date(startUtc).toISOString(),
      endDate: Number.isFinite(endUtc) ? new Date(endUtc).toISOString() : null,
      timeSource: "yc-unverified",
      timeZone,
    };
  }
  const startHour = toHour24(range[1], range[3]);
  const endHour = toHour24(range[4], range[6]);
  const correctedStart = localToUtc(
    start.year,
    start.month,
    start.day,
    startHour,
    Number(range[2] ?? 0),
    timeZone,
  );
  let correctedEnd = localToUtc(
    start.year,
    start.month,
    start.day,
    endHour,
    Number(range[5] ?? 0),
    timeZone,
  );
  if (correctedEnd <= correctedStart) correctedEnd += 24 * 3_600_000;
  return {
    startDate: new Date(correctedStart).toISOString(),
    endDate: new Date(correctedEnd).toISOString(),
    timeSource: "description",
    timeZone,
  };
}

/**
 * YC's public_location is often just the city spelled out long-hand ("San
 * Francisco, California, United States"). Publishing that as the venue would
 * print the city twice, so anything that is only place words becomes no venue at
 * all — the venue is genuinely unknown until you register.
 */
function resolveVenue(meetup, city) {
  const raw = (meetup.public_location || "").trim();
  if (!raw) return null;
  const remainder = raw
    .replace(new RegExp(escapeTerm(city ?? ""), "gi"), "")
    .replace(/\b(california|ca|united states|usa|us)\b/gi, "")
    .replace(/[\s,]+/g, "");
  return remainder ? raw : null;
}

/** "San Francisco, California, United States" -> "San Francisco", when local. */
function resolveCity(meetup) {
  const raw = meetup.public_location || meetup.city || "";
  for (const segment of raw.split(",")) {
    const candidate = segment.trim();
    if (candidate && localCities.has(candidate.toLowerCase())) return candidate;
  }
  const match = raw.match(placePattern);
  if (match) {
    return match[1]
      .split(" ")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
  }
  return null;
}

function resolveOrganizer(meetup) {
  const description = meetup.description ?? "";
  const hosting = description.match(
    /([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,3})\s+is\s+(?:hosting|running)/,
  );
  if (hosting) return hosting[1].trim();
  const hostedBy = description.match(
    /[Hh]osted by\s+([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,3})/,
  );
  if (hostedBy) return hostedBy[1].trim();
  return "Y Combinator";
}

/**
 * Markdown-ish description into the flat line format the normalizer's text
 * parsers expect, with the "Hosted By" pair it reads organizers from.
 */
function buildEvidence(meetup, schedule, city, organizer) {
  const description = (meetup.description ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\*\*?/g, "")
    .replace(/\\\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const lines = [
    "Hosted By",
    organizer,
    meetup.friendly_name || meetup.title,
    meetup.formatted_start_date ? `${meetup.formatted_start_date}` : null,
    schedule?.timeSource === "description" && meetup.description?.match(TIME_RANGE)
      ? meetup.description.match(TIME_RANGE)[0]
      : null,
    city ? `${city}, CA` : null,
    meetup.capacity ? `Capacity ${meetup.capacity}` : null,
    meetup.cancelled ? "Cancelled" : null,
    "About Event",
    description,
  ];
  return lines.filter(Boolean).join("\n");
}

function score(title, evidence) {
  const combined = `${title}\n${evidence}`;
  const direct = candidatePattern.test(combined);
  const builds = buildPattern.test(combined);
  const competes = competitionPattern.test(combined);
  const negative = negativeTitlePattern.test(title);
  const local = placePattern.test(combined);

  let confidence = direct ? 62 : 20;
  if (builds) confidence += 16;
  if (competes) confidence += 16;
  if (negative && !(builds && competes)) confidence -= 30;
  confidence = Math.max(0, Math.min(100, confidence));

  let relevance = Math.round(confidence * 0.65);
  if (local) relevance += 20;
  if (/\b(open|register|apply|application|request to join)\b/i.test(combined)) {
    relevance += 8;
  }
  if (/\b(prize|bount(?:y|ies)|cash|credits?)\b/i.test(combined)) relevance += 7;
  relevance = Math.max(0, Math.min(100, relevance));

  return {
    confidence,
    relevance,
    signals: {
      directHackathonTerm: direct,
      buildEvidence: builds,
      competitionEvidence: competes,
      sfBayAreaEvidence: local,
      negativeTitleEvidence: negative,
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const problems = [];

// Extra slugs found elsewhere. discover-linkedin.mjs records YC event URLs it
// sees in posts rather than seeding them, because the headless sweep cannot
// read this site — this is where they get picked up.
const extraSlugs = new Set();
try {
  const linkedin = JSON.parse(
    await readFile(resolve(root, "data/linkedin-seeds.json"), "utf8"),
  );
  for (const url of linkedin.ycEventUrls ?? []) {
    const slug = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    if (slug && !slug.includes("/")) extraSlugs.add(slug);
  }
} catch {
  // Optional input.
}

const index = await fetchProps(INDEX_URL).catch((error) => ({
  error: String(error).slice(0, 160),
}));
if (index.error) problems.push({ stage: "index", error: index.error });
const listed = index.props?.events ?? [];

// The index carries an event_type_label, so the obvious non-hackathons are
// dropped before spending a request on their detail page. A title that names a
// hackathon format still gets through even when YC labelled it something else.
const shortlist = listed.filter((event) => {
  const label = event.event_type_label ?? "";
  const looksLikeHackathon =
    /hackathon/i.test(label) || candidatePattern.test(event.title ?? "");
  if (!looksLikeHackathon) return false;
  const place = `${event.city ?? ""} ${event.public_location ?? ""}`;
  return placePattern.test(place);
});
for (const slug of shortlist.map((event) => event.slug)) extraSlugs.add(slug);

console.log(
  `YC index: ${listed.length} event(s) listed, ${shortlist.length} shortlisted, ` +
    `${extraSlugs.size} to read.`,
);

const candidates = [];
const skipped = [];
const slugs = [...extraSlugs].slice(0, config.ycEventsPerRun ?? 25);

for (const [position, slug] of slugs.entries()) {
  if (position > 0) await sleep(Number(process.env.YC_PAGE_DELAY_MS ?? 800));
  const url = `${EVENT_BASE}${slug}`;
  let result;
  try {
    result = await fetchProps(url);
  } catch (error) {
    problems.push({ stage: "event", slug, error: String(error).slice(0, 160) });
    continue;
  }
  if (result.error) {
    problems.push({ stage: "event", slug, error: result.error });
    continue;
  }
  const meetup = result.props.meetup;
  if (!meetup) {
    problems.push({ stage: "event", slug, error: "no meetup props" });
    continue;
  }

  const title = (meetup.title || meetup.friendly_name || "").trim();
  const isHackathon =
    /hackathon/i.test(meetup.event_type ?? "") || candidatePattern.test(title);
  if (!isHackathon) {
    skipped.push({ slug, title, why: "not a hackathon" });
    continue;
  }
  if (meetup.cancelled) {
    skipped.push({ slug, title, why: "cancelled" });
    continue;
  }

  const schedule = resolveSchedule(meetup);
  if (!schedule) {
    skipped.push({ slug, title, why: "no parseable date" });
    continue;
  }
  // First-layer past filter. The normalizer applies its own as well.
  const endMs = Date.parse(schedule.endDate ?? schedule.startDate);
  if (Number.isFinite(endMs) && endMs < Date.now()) {
    skipped.push({ slug, title, why: "already happened" });
    continue;
  }

  const city = resolveCity(meetup);
  if (!city) {
    skipped.push({ slug, title, why: `not local (${meetup.public_location ?? "?"})` });
    continue;
  }

  const organizer = resolveOrganizer(meetup);
  const evidence = buildEvidence(meetup, schedule, city, organizer);
  const scored = score(title, evidence);

  candidates.push({
    url,
    title,
    category: "hackathon",
    discoveredVia: INDEX_URL,
    confidence: scored.confidence,
    relevance: scored.relevance,
    signals: scored.signals,
    evidence,
    checkedAt: new Date().toISOString(),
    heldBecause: null,
    structuredEvent: {
      url,
      name: title,
      description: meetup.description ?? null,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      // Recorded so the provenance of a published time is auditable: "yc" is
      // YC's own field, "description" was recovered from the event copy, and
      // "yc-unverified" means we kept a value we do not trust and left it to
      // the normalizer to suppress.
      timeSource: schedule.timeSource,
      organizers: [organizer],
      location: {
        name: resolveVenue(meetup, city),
        city,
        region: "CA",
      },
      offerAvailability: meetup.registration_closes_at
        ? Date.parse(meetup.registration_closes_at) > Date.now()
          ? "InStock"
          : "SoldOut"
        : null,
      capacity: meetup.capacity ?? null,
    },
  });
  console.log(
    `  ${slug} · ${title} · ${schedule.startDate.slice(0, 10)} · ` +
      `time from ${schedule.timeSource} · confidence ${scored.confidence}`,
  );
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      source: INDEX_URL,
      listed: listed.length,
      shortlisted: shortlist.length,
      read: slugs.length,
      note:
        "Hackathons from Y Combinator's own events site, read from the Inertia " +
        "props its pages ship. Same candidate shape as the Luma sweep; merged " +
        "and scored by scripts/normalize-events.mjs.",
      problems,
      skipped,
      candidates,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `YC discovery: ${candidates.length} hackathon candidate(s), ` +
    `${skipped.length} skipped` +
    (problems.length ? `, ${problems.length} problem(s)` : "") +
    `.\nWrote ${outputPath}`,
);
