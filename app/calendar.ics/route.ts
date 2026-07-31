const calendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Hacklist SF//Hackathon Calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Hacklist SF
X-WR-TIMEZONE:America/Los_Angeles
BEGIN:VEVENT
UID:a1mobile-voice-ai-20260731@hacklist.sf
DTSTAMP:20260730T190000Z
DTSTART;TZID=America/Los_Angeles:20260731T090000
DTEND;TZID=America/Los_Angeles:20260731T210000
SUMMARY:Close the Loop — Voice AI Hackathon
LOCATION:San Francisco\, CA
DESCRIPTION:12-hour voice AI build challenge. Verify current registration details on Luma.
URL:https://luma.com/f8cratbb
END:VEVENT
END:VCALENDAR`;

export async function GET() {
  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="hacklist-sf.ics"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
