// Collapsing the same event found under two different URLs.
//
// Pure functions, no I/O, so the rules can be tested — this took five passes to
// get right and every wrong version either published an event twice or merged two
// real events into one.
//
// Deduping by URL alone stopped being enough once more than one source could
// reach the same hackathon: search discovery started finding organisers' own pages
// (builder.aws.com) for events already on the board via Luma, and published both.

import { isSuspectSchedule } from "./event-dates.mjs";

export const titleFingerprint = (title) =>
  String(title ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * Do two records describe one event?
 *
 * Two independent tests, either sufficient:
 *
 *   title      — same day and one title contains the other outright, with the
 *                shorter at least 12 letters/digits. "Biopharma Hack Day" inside
 *                "Biopharma Hack Day at AWS".
 *   same host  — same day, same organiser, same area. Two different hackathons by
 *                one organiser in one place on one day does not happen, and this
 *                catches the pairs whose titles diverge too far to overlap:
 *                "SF Enterprise HACKATHON" and "SF Enterprise Innovation
 *                Hackathon: 8-Hour Hackathon in San Francisco".
 *
 * Both require the same calendar day, which is what keeps a recurring series from
 * collapsing into a single event.
 */
export function isSameEvent(a, b, { day, organizer, area }) {
  if (!day(a) || day(a) !== day(b)) return false;

  const fa = titleFingerprint(a.title);
  const fb = titleFingerprint(b.title);
  const shorter = fa.length <= fb.length ? fa : fb;
  const longer = shorter === fa ? fb : fa;
  if (shorter.length >= 12 && longer.includes(shorter)) return "title";

  const host = organizer(a);
  if (host && host === organizer(b) && area(a) && area(a) === area(b)) {
    return "same host + area + day";
  }
  return false;
}

/**
 * Build one record from two, rather than picking a winner.
 *
 * A Luma record is the base when there is one: it is the canonical registration
 * page and the only kind the calendar sync can add. Canonical is not the same as
 * accurate, though — "Data & AI Hackathon: SF" came from Luma claiming 00:30 to
 * 01:30 while the organiser's own page said 09:30 to 19:00, which is what the
 * title's "8-Hour" implies. So the base takes the better schedule and any venue it
 * lacked from the record it absorbs, and never the reverse.
 */
export function mergeDuplicate(a, b, timeZone) {
  const isLuma = (c) => String(c.url ?? "").startsWith("https://luma.com/");
  let base = a;
  let other = b;
  if (isLuma(b) && !isLuma(a)) [base, other] = [b, a];
  else if (isLuma(a) === isLuma(b) && (b.confidence ?? 0) > (a.confidence ?? 0)) {
    [base, other] = [b, a];
  }

  const credible = (c) => {
    const start = Date.parse(c.structuredEvent?.startDate ?? "");
    const end = Date.parse(c.structuredEvent?.endDate ?? "");
    if (!Number.isFinite(start)) return false;
    return !isSuspectSchedule(start, end, timeZone);
  };

  const merged = { ...base, structuredEvent: { ...(base.structuredEvent ?? {}) } };
  if (!credible(base) && credible(other)) {
    merged.structuredEvent.startDate = other.structuredEvent.startDate;
    merged.structuredEvent.endDate = other.structuredEvent.endDate;
    merged.structuredEvent.timeSource =
      `${other.structuredEvent.timeSource ?? "other"}-via-duplicate`;
  }
  if (!merged.structuredEvent.location?.name && other.structuredEvent?.location?.name) {
    merged.structuredEvent.location = {
      ...(merged.structuredEvent.location ?? {}),
      name: other.structuredEvent.location.name,
    };
  }
  if ((other.evidence?.length ?? 0) > (merged.evidence?.length ?? 0)) {
    merged.evidence = `${merged.evidence}\n${other.evidence}`;
  }
  return merged;
}
