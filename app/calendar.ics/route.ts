import discovery from "../../data/events.json";

type FeedEvent = {
  id: string;
  url: string;
  region?: string;
  category: "hackathon" | "adjacent";
  timeUnverified?: boolean;
  title: string;
  organizer: string;
  venue: string | null;
  city: string | null;
  start: string | null;
  end: string | null;
  status: string;
  prize: string;
  why: string;
};

const encoder = new TextEncoder();

/** "2026-09-26T00:00:00-07:00" -> "20260926". The offset is already local. */
function icsDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

/**
 * All-day DTEND is exclusive (RFC 5545 §3.6.1), so a one-day event ending on the
 * 26th must say the 27th. Pure calendar arithmetic on the date parts - no
 * timezone is involved in "the day after".
 */
function icsDateExclusive(iso: string, addDays = 1): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + addDays));
  return next.toISOString().slice(0, 10).replace(/-/g, "");
}

function daysBetween(startIso: string, endIso: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(endIso) - toUtc(startIso)) / 86400000);
}

// Devpost reports a *submission period*, which can run for weeks. Blocking out
// three weeks of a subscriber's calendar for a one-day hackathon is worse than
// useless, so a long all-day span collapses to its first day and the full range
// moves into the description. Genuine multi-day hackathons are short.
const MAX_ALL_DAY_SPAN = 3;

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + space.
function foldLine(line: string): string {
  const folded: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    const limit = folded.length === 0 ? 75 : 74;
    if (currentBytes + charBytes > limit) {
      folded.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  folded.push(current);
  return folded.join("\r\n ");
}

// "2026-08-28T09:00:00-07:00" -> "20260828T090000" (local wall time)
function icsLocal(iso: string): string {
  return iso.slice(0, 19).replace(/[-:]/g, "");
}

/**
 * DTSTART/DTEND for a timed event.
 *
 * icsLocal takes the wall clock straight out of the ISO string, so labelling it
 * TZID=<zone> is only true when the string's own offset IS that zone's offset at
 * that instant. Normalisation makes that hold today, but a source that hands back
 * a UTC timestamp would otherwise be published as if the UTC wall time were local.
 * When the offsets disagree the event is emitted as an absolute UTC timestamp,
 * which every client renders correctly in the viewer's own zone - correct beats
 * pretty here.
 */
function timedWhen(startIso: string, endIso: string, zone: string): string[] {
  const matchesZone = (iso: string) => {
    const carried = isoOffsetMinutes(iso);
    if (carried === null) return false; // no offset at all: not safe to relabel
    return carried === zoneOffsetMinutes(new Date(iso), zone);
  };
  if (matchesZone(startIso) && matchesZone(endIso)) {
    return [
      `DTSTART;TZID=${zone}:${icsLocal(startIso)}`,
      `DTEND;TZID=${zone}:${icsLocal(endIso)}`,
    ];
  }
  return [`DTSTART:${icsUtcStamp(startIso)}`, `DTEND:${icsUtcStamp(endIso)}`];
}

function icsUtcStamp(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

// VTIMEZONE definitions for the zones this feed can publish. A calendar client
// needs the zone's DST rules to place a local time, so a zone is only safe to
// emit if its rules are actually written down here - hence an allowlist rather
// than passing an arbitrary IANA name through to TZID and hoping.
const US_DST = (tzid: string, stdOffset: string, dstOffset: string,
                stdName: string, dstName: string) => [
  "BEGIN:VTIMEZONE",
  `TZID:${tzid}`,
  "BEGIN:DAYLIGHT",
  `TZOFFSETFROM:${stdOffset}`,
  `TZOFFSETTO:${dstOffset}`,
  `TZNAME:${dstName}`,
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  `TZOFFSETFROM:${dstOffset}`,
  `TZOFFSETTO:${stdOffset}`,
  `TZNAME:${stdName}`,
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const timezoneBlocks: Record<string, string[]> = {
  "America/Los_Angeles": US_DST("America/Los_Angeles", "-0800", "-0700", "PST", "PDT"),
  "America/Denver": US_DST("America/Denver", "-0700", "-0600", "MST", "MDT"),
  "America/Chicago": US_DST("America/Chicago", "-0600", "-0500", "CST", "CDT"),
  "America/New_York": US_DST("America/New_York", "-0500", "-0400", "EST", "EDT"),
};

const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** The zone's UTC offset in minutes at a given instant, DST included. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    at("year"), at("month") - 1, at("day"),
    at("hour") % 24, at("minute"), at("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The offset an ISO timestamp already carries, in minutes. */
function isoOffsetMinutes(iso: string): number | null {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(iso.trim());
  if (!m) return null;
  if (m[1] === "Z") return 0;
  const sign = m[1][0] === "-" ? -1 : 1;
  return sign * (Number(m[1].slice(1, 3)) * 60 + Number(m[1].slice(4, 6)));
}

type FeedRegion = {
  key: string;
  label: string;
  boardName: string;
  // The region data has carried a timezone since San Diego was added; this feed
  // used to ignore it and stamp America/Los_Angeles on every event. That is
  // harmless while every region is Pacific and silently wrong the day one is
  // not: the wall clock would be published unchanged under the wrong zone, so a
  // 9am event in a -04:00 region would land on subscribers' calendars at 9am
  // Pacific - three hours out, with nothing to notice it by.
  timezone?: string;
};

// A data file written before regions existed has none, and the feed still has to
// serve: it is one region's board, the one everything defaults to.
const regions: FeedRegion[] = (discovery.meta as unknown as {
  regions?: FeedRegion[];
}).regions ?? [{ key: "bay-area", label: "Bay Area", boardName: "Hacklist SF" }];
const defaultRegion =
  (discovery.meta as unknown as { defaultRegion?: string }).defaultRegion ??
  regions[0]?.key ??
  "bay-area";

/**
 * One feed per region, because a subscriber asked for a place and not for a
 * product. /calendar.ics keeps meaning what it meant before San Diego existed -
 * the Bay Area board - so nobody who subscribed to it wakes up with hackathons
 * 500 miles away on their calendar; every other region is ?region=<key>.
 */
function buildCalendar(region: FeedRegion): string {
  const zone = region.timezone ?? DEFAULT_TIMEZONE;
  const zoneBlock = timezoneBlocks[zone];
  if (!zoneBlock) {
    // Refuse rather than fall back to Pacific. Serving a New York board with
    // Pacific timestamps is worse than serving nothing: the feed looks healthy
    // and every event is silently three hours out.
    throw new Error(
      `no VTIMEZONE definition for region "${region.key}" zone "${zone}"; ` +
        `supported: ${Object.keys(timezoneBlocks).join(", ")}`,
    );
  }
  // Anything with a date goes in the feed. An event whose *time* we do not trust
  // goes in as an all-day entry rather than being withheld: the day is solid -
  // Devpost publishes submission dates and no clock times at all - and an all-day
  // row claims no hour, so it cannot land a subscriber in the wrong place. Only
  // an event with no date at all has nowhere to go.
  // Filtered per request, not per build. The board is rebuilt twice a day, so
  // between sweeps it will always contain events that have since finished: one
  // run published a hackathon that ended sixteen minutes after the sweep wrote
  // the file. A feed is read continuously and can simply not serve them.
  const asOf = Date.now();
  const events = (discovery.events as FeedEvent[]).filter((event) => {
    if (!event.start) return false;
    // An event written before regions existed belongs to the default one, which
    // is where the single-region board had it.
    if ((event.region ?? defaultRegion) !== region.key) return false;
    const over = Date.parse(event.end ?? event.start);
    return !Number.isFinite(over) || over >= asOf;
  });
  const stamp = icsUtcStamp(discovery.meta.sweepCompletedAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${region.boardName}//Hackathon Calendar//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${region.boardName}`,
    `X-WR-TIMEZONE:${zone}`,
    ...zoneBlock,
  ];

  for (const event of events) {
    const location = [event.venue, event.city].filter(Boolean).join(", ");
    const adjacent = event.category === "adjacent";
    // A calendar row has no room for a badge, so say it in the title. A
    // subscriber should never mistake a pitch night for a hackathon.
    // A cancellation has to reach the row itself. STATUS:CANCELLED is what a
    // client acts on, but not every client shows it, and a subscriber glancing
    // at their week sees only the title.
    const cancelled = event.status === "Cancelled";
    const summary =
      (cancelled ? "[Cancelled] " : "") +
      (adjacent ? `[Tech Event] ${event.title}` : event.title);
    // No end, or a time we do not believe, means the hour is unknown but the day
    // is not. Say so in the description so a subscriber knows to check.
    const allDay = !event.end || event.timeUnverified === true;
    const span = allDay
      ? daysBetween(event.start as string, (event.end ?? event.start) as string) + 1
      : 0;
    const longSpan = allDay && span > MAX_ALL_DAY_SPAN;
    const description =
      (adjacent ? "A tech event, not a hackathon. " : "") +
      (allDay ? "Start time is on the event page. " : "") +
      (longSpan
        ? `Runs ${(event.start as string).slice(0, 10)} to ${(event.end as string).slice(0, 10)}; shown on the first day. `
        : "") +
      `${event.why} Hosted by ${event.organizer}. ` +
      `Registration: ${event.status}. Details: ${event.url}`;
    const when = allDay
      ? [
          `DTSTART;VALUE=DATE:${icsDate(event.start as string)}`,
          `DTEND;VALUE=DATE:${
            longSpan
              ? icsDateExclusive(event.start as string)
              : icsDateExclusive((event.end ?? event.start) as string)
          }`,
        ]
      : timedWhen(event.start as string, event.end as string, zone);
    lines.push(
      "BEGIN:VEVENT",
      // The UID namespace stays "hacklist-sf" for every region. It is an
      // identity, not a label, and rewriting it would make every event on an
      // existing subscription look like a new one.
      `UID:${event.id}@hacklist-sf`,
      `DTSTAMP:${stamp}`,
      ...when,
      `SUMMARY:${escapeText(summary)}`,
      // A cancelled event stays in the feed rather than being dropped. Dropping
      // it removes the row, and a row that quietly disappears leaves the
      // subscriber believing the hackathon is still on; STATUS:CANCELLED gives
      // their client something to act on. It ages out with everything else once
      // its date passes.
      ...(cancelled ? ["STATUS:CANCELLED"] : []),
      `CATEGORIES:${adjacent ? "TECH-EVENT" : "HACKATHON"}`,
      ...(location ? [`LOCATION:${escapeText(location)}`] : []),
      `DESCRIPTION:${escapeText(description)}`,
      `URL:${event.url}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n");
}

export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams.get("region");
  const region = regions.find((entry) => entry.key === (asked ?? defaultRegion));
  // An unknown region is refused rather than quietly served the default: a
  // subscriber who mistyped one would otherwise never find out, and would be
  // reading another metro's hackathons.
  if (!region) {
    // The refusal is the one human-readable thing this route says, so it may
    // follow the reader's language. The calendar itself never does: every 200
    // from this route is byte-identical whatever Accept-Language asks for,
    // because the feed is one shared artifact, not a per-locale rendering.
    const wantsSpanish = /(^|,)\s*es\b/i.test(
      request.headers.get("accept-language") ?? "",
    );
    const available = regions.map((entry) => entry.key).join(", ");
    return new Response(
      wantsSpanish
        ? `Región desconocida "${asked}". Disponibles: ${available}.`
        : `Unknown region "${asked}". Available: ${available}.`,
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const filename = `${region.boardName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.ics`;
  return new Response(buildCalendar(region), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=1800",
    },
  });
}
