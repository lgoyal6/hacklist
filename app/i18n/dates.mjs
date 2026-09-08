// Localized date presentation, shared by the board and the tests.
//
// Everything here starts from the event's UTC instant and the event's own IANA
// zone, so a locale can change the words but never the moment: DST is whatever
// the zone says it is at that instant, in every language. The English output
// reproduces byte-for-byte the dateLabel/dateDetail strings that
// scripts/normalize-events.mjs precomputes, and a test in
// tests/i18n-rendered.test.mjs holds the two implementations together.
//
// Plain .mjs rather than .ts so the node:test suites can exercise the exact
// code the page renders, not a re-implementation of it.

/** Intl locale tag for a UI locale. */
const intlTag = (locale) => (locale === "es" ? "es" : "en-US");

const partFormatters = new Map();

/**
 * The wall-clock parts of a UTC instant in a zone, DST included, plus the
 * locale's own long month and weekday names for that wall date.
 */
export function zoneParts(utcMs, timeZone, locale = "en") {
  const cacheKey = `${timeZone}|${locale}`;
  let formatter = partFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlTag(locale), {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    });
    partFormatters.set(cacheKey, formatter);
  }
  const parts = formatter.formatToParts(new Date(utcMs));
  const at = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const monthName = new Intl.DateTimeFormat(intlTag(locale), {
    timeZone,
    month: "long",
  }).format(new Date(utcMs));
  return {
    year: Number(at("year")),
    month: Number(at("month")),
    day: Number(at("day")),
    hour: Number(at("hour")) % 24,
    minute: Number(at("minute")),
    weekday: at("weekday"),
    monthName,
  };
}

/** "9am", "9:30am" — the exact shape normalize-events.mjs prints for English. */
function shortTimeEn(p) {
  const hour12 = p.hour % 12 || 12;
  const suffix = p.hour >= 12 ? "pm" : "am";
  return p.minute
    ? `${hour12}:${String(p.minute).padStart(2, "0")}${suffix}`
    : `${hour12}${suffix}`;
}

/** "9:00", "21:30" — Spanish reads the 24-hour clock. */
function shortTimeEs(p) {
  return `${p.hour}:${String(p.minute).padStart(2, "0")}`;
}

/** "Sat" / "sáb": the locale's long weekday name, clipped the way the board clips it. */
const weekday3 = (p) => p.weekday.slice(0, 3);

/** "SEP" / "SEP", "JAN" / "ENE": the locale's month name, clipped and shouted. */
const month3 = (p) => p.monthName.slice(0, 3).toUpperCase();

/**
 * The <time> block for one event: a compact label ("SEP 12" / "12 SEP") and a
 * detail line (weekday plus times, or a day span). Mirrors describeSchedule in
 * scripts/normalize-events.mjs case for case, including the events whose date
 * or time only the event page knows.
 *
 * @param {{start: string|null, end: string|null, timezone: string, timeUnverified?: boolean}} event
 * @param {"en"|"es"} locale
 * @param {(key: string, vars?: Record<string, string|number>) => string} t
 */
export function formatEventDate(event, locale, t) {
  if (!event.start) return { label: t("date.tbc"), detail: t("date.datePage") };
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end ?? event.start);
  const zone = event.timezone;
  const start = zoneParts(startMs, zone, locale);
  const end = zoneParts(endMs, zone, locale);

  const day2 = String(start.day).padStart(2, "0");
  const label =
    locale === "es" ? `${day2} ${month3(start)}` : `${month3(start)} ${day2}`;

  if (event.timeUnverified || !event.end) {
    return { label, detail: t("date.timePage") };
  }

  const sameDay =
    start.year === end.year && start.month === end.month && start.day === end.day;
  const time = locale === "es" ? shortTimeEs : shortTimeEn;
  if (sameDay) {
    return {
      label,
      detail: `${weekday3(start)} · ${time(start)}–${time(end)}`,
    };
  }
  // Calendar days in the event's zone, inclusive: pure date arithmetic, the
  // same sum the normalizer does.
  const days =
    Math.round(
      (Date.UTC(end.year, end.month - 1, end.day) -
        Date.UTC(start.year, start.month - 1, start.day)) /
        86400000,
    ) + 1;
  return {
    label,
    detail: `${weekday3(start)}–${weekday3(end)} · ${t("date.days", { count: days })}`,
  };
}

/**
 * The month heading a listing groups under: "September 2026" / "septiembre de 2026".
 * @param {string|null} startIso
 */
export function monthGroupLabel(startIso, timeZone, locale, t) {
  if (!startIso) return t("months.undated");
  return new Intl.DateTimeFormat(intlTag(locale), {
    timeZone,
    month: "long",
    year: "numeric",
  }).format(new Date(startIso));
}

/** The "last checked" stamp in the byline, in board time whatever the locale. */
export function updatedStampLabel(iso, timeZone, locale) {
  return new Intl.DateTimeFormat(intlTag(locale), {
    timeZone,
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
