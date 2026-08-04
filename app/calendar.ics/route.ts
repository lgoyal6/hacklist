import discovery from "../../data/events.json";

type FeedEvent = {
  id: string;
  url: string;
  category: "hackathon" | "adjacent";
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
  const events = (discovery.events as FeedEvent[]).filter(
    (event) => event.start && event.end,
  );
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
    const description =
      (adjacent ? "A tech event, not a hackathon. " : "") +
      `${event.why} Hosted by ${event.organizer}. ` +
      `Registration: ${event.status}. Details: ${event.url}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@hacklist-sf`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=America/Los_Angeles:${icsLocal(event.start as string)}`,
      `DTEND;TZID=America/Los_Angeles:${icsLocal(event.end as string)}`,
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
