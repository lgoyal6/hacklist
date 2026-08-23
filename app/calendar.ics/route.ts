import discovery from "../../data/events.json";

type FeedEvent = {
  id: string;
  url: string;
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
 * 26th must say the 27th. Pure calendar arithmetic on the date parts — no
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

function icsUtcStamp(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

const timezoneBlock = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Los_Angeles",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "TZNAME:PDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "TZNAME:PST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function buildCalendar(): string {
  // Anything with a date goes in the feed. An event whose *time* we do not trust
  // goes in as an all-day entry rather than being withheld: the day is solid —
  // Devpost publishes submission dates and no clock times at all — and an all-day
  // row claims no hour, so it cannot land a subscriber in the wrong place. Only
  // an event with no date at all has nowhere to go.
  // Filtered per request, not per build. The board is rebuilt twice a day, so
  // between sweeps it will always contain events that have since finished: one
  // run published a hackathon that ended sixteen minutes after the sweep wrote
  // the file. A feed is read continuously and can simply not serve them.
  const asOf = Date.now();
  const events = (discovery.events as FeedEvent[]).filter((event) => {
    if (!event.start) return false;
    const over = Date.parse(event.end ?? event.start);
    return !Number.isFinite(over) || over >= asOf;
  });
  const stamp = icsUtcStamp(discovery.meta.sweepCompletedAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hacklist SF//Hackathon Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hacklist SF",
    "X-WR-TIMEZONE:America/Los_Angeles",
    ...timezoneBlock,
  ];

  for (const event of events) {
    const location = [event.venue, event.city].filter(Boolean).join(", ");
    const adjacent = event.category === "adjacent";
    // A calendar row has no room for a badge, so say it in the title. A
    // subscriber should never mistake a pitch night for a hackathon.
    const summary = adjacent ? `[Tech Event] ${event.title}` : event.title;
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
      : [
          `DTSTART;TZID=America/Los_Angeles:${icsLocal(event.start as string)}`,
          `DTEND;TZID=America/Los_Angeles:${icsLocal(event.end as string)}`,
        ];
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@hacklist-sf`,
      `DTSTAMP:${stamp}`,
      ...when,
      `SUMMARY:${escapeText(summary)}`,
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

export async function GET() {
  return new Response(buildCalendar(), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="hacklist-sf.ics"',
      "Cache-Control": "public, max-age=1800",
    },
  });
}
