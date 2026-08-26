// Date and time arithmetic shared by the API-shaped discovery sources.
//
// Pure functions, no network, no top-level work — so the tests can import this
// and exercise the real rules rather than a restatement of them.

const MONTH_ABBREVS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function zoneOffsetMinutes(utcMs, timeZone) {
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

/** Wall-clock time in a zone to a UTC instant. Two passes settle DST edges. */
export function localToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = zoneOffsetMinutes(guess, timeZone);
  const corrected = guess - offset * 60_000;
  return corrected - (zoneOffsetMinutes(corrected, timeZone) - offset) * 60_000;
}

export function zoneParts(utcMs, timeZone) {
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

/** "12pm-6pm", "9:00 AM to 5:30 PM" — the first stated range in a blob of copy. */
export const TIME_RANGE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

export function toHour24(hourStr, meridiem) {
  let hour = Number(hourStr) % 12;
  if (/pm/i.test(meridiem)) hour += 12;
  return hour;
}

/**
 * Is a source's stated schedule one we are willing to print a clock time from?
 *
 * Two tells that it is not, both seen in real records: a start at local
 * pre-dawn (an organizer entered a date and the row defaulted to midnight) and a
 * duration under 90 minutes (the same defaulting, or a mis-set timezone). The
 * normalizer applies the same rule to everything it publishes; this lets a source
 * spot the problem early enough to go looking for a better answer.
 */
export function isSuspectSchedule(startUtc, endUtc, timeZone) {
  if (!Number.isFinite(startUtc)) return true;
  const { hour } = zoneParts(startUtc, timeZone);
  if (hour < 6) return true;
  if (!Number.isFinite(endUtc)) return false;
  return (endUtc - startUtc) / 3_600_000 < 1.5;
}

/**
 * Recover a start/end from a time range stated in event copy, anchored to the
 * calendar date the source already gave us. Returns null when the copy states no
 * range — in which case the source's own values stand and the normalizer
 * suppresses the time.
 */
export function recoverTimeRange(description, anchorUtc, timeZone) {
  const match = String(description ?? "").match(TIME_RANGE);
  if (!match || !Number.isFinite(anchorUtc)) return null;
  const anchor = zoneParts(anchorUtc, timeZone);
  const startUtc = localToUtc(
    anchor.year,
    anchor.month,
    anchor.day,
    toHour24(match[1], match[3]),
    Number(match[2] ?? 0),
    timeZone,
  );
  let endUtc = localToUtc(
    anchor.year,
    anchor.month,
    anchor.day,
    toHour24(match[4], match[6]),
    Number(match[5] ?? 0),
    timeZone,
  );
  // "8pm - 1am" runs past midnight.
  if (endUtc <= startUtc) endUtc += 24 * 3_600_000;
  return { startUtc, endUtc, matched: match[0] };
}

/**
 * Parse Devpost's `submission_period_dates`, which comes in these shapes:
 *   "Aug 04, 2026"            single day
 *   "Sep 26 - 27, 2026"       range inside one month
 *   "Jul 26 - Aug 14, 2026"   range across months
 *   "Dec 28 - Jan 03, 2027"   range across a year boundary
 *
 * Returns UTC bounds spanning local midnight to end of the last day, or null
 * when the string is not one of those. Devpost states no clock times, so a
 * date-only span is the honest reading.
 */
export function parseDevpostDates(raw, timeZone) {
  const text = String(raw ?? "").trim();
  const month = `(${MONTH_ABBREVS.join("|")})`;
  const cross = new RegExp(
    `^${month}\\s+(\\d{1,2})\\s*[-–]\\s*${month}\\s+(\\d{1,2}),\\s*(\\d{4})$`,
    "i",
  );
  const within = new RegExp(
    `^${month}\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2}),\\s*(\\d{4})$`,
    "i",
  );
  const single = new RegExp(`^${month}\\s+(\\d{1,2}),\\s*(\\d{4})$`, "i");
  const monthIndex = (name) =>
    MONTH_ABBREVS.findIndex((m) => m.toLowerCase() === name.toLowerCase());

  let start;
  let end;
  let match;
  if ((match = text.match(cross))) {
    const [, m1, d1, m2, d2, year] = match;
    // Devpost prints the end date's year, so a range that goes backwards through
    // the months began in the previous year.
    const startYear =
      monthIndex(m2) < monthIndex(m1) ? Number(year) - 1 : Number(year);
    start = { year: startYear, month: monthIndex(m1) + 1, day: Number(d1) };
    end = { year: Number(year), month: monthIndex(m2) + 1, day: Number(d2) };
  } else if ((match = text.match(within))) {
    const [, m1, d1, d2, year] = match;
    start = { year: Number(year), month: monthIndex(m1) + 1, day: Number(d1) };
    end = { year: Number(year), month: monthIndex(m1) + 1, day: Number(d2) };
    // Real data prints a range backwards now and then ("Jul 28 - 26, 2026").
    // Collapsing to the single day keeps the event; inverting would drop it.
    if (end.day < start.day) end = { ...start };
  } else if ((match = text.match(single))) {
    const [, m1, d1, year] = match;
    start = { year: Number(year), month: monthIndex(m1) + 1, day: Number(d1) };
    end = { ...start };
  } else {
    return null;
  }

  const startUtc = localToUtc(start.year, start.month, start.day, 0, 0, timeZone);
  const endUtc = localToUtc(end.year, end.month, end.day, 23, 59, timeZone);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) return null;
  if (endUtc <= startUtc) return null;
  return { startUtc, endUtc };
}

/**
 * What MLH means by its timestamps.
 *
 * MLH publishes a start and end for every event, and about as often as not they
 * are day markers rather than times. The seconds field is the tell: a stated
 * start is on the minute. "2027-04-04T01:11:11Z" is Diamondhacks, which MLH
 * itself prints as "APR 04 - 05" -- read as an instant in Pacific it becomes
 * 6:11pm on 3 April, a day early at a time nobody stated. "2026-04-18T12:00:00Z"
 * is DataHacks and "2026-01-24T14:45:00Z" is Hard Hack, both on the minute and
 * both real.
 *
 * A synthetic clock makes the event date-only -- local midnight to end of day,
 * which is how Devpost's date ranges are already carried -- and the date taken
 * is the UTC one, because that is the day MLH prints beside it.
 */
export function mlhSchedule(startsAt, endsAt, timeZone) {
  const startMs = Date.parse(startsAt ?? "");
  if (!Number.isFinite(startMs)) return null;
  const endMs = Date.parse(endsAt ?? startsAt ?? "");
  if (new Date(startMs).getUTCSeconds() === 0) {
    return { dateOnly: false, startMs, endMs };
  }
  const utcDay = (ms) => {
    const at = new Date(ms);
    return [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()];
  };
  return {
    dateOnly: true,
    startMs: localToUtc(...utcDay(startMs), 0, 0, timeZone),
    endMs: localToUtc(
      ...utcDay(Number.isFinite(endMs) ? endMs : startMs),
      23,
      59,
      timeZone,
    ),
  };
}
