import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);
const discovery = JSON.parse(
  await readFile(resolve(root, "data/discovery-output.json"), "utf8"),
);

const timezone = config.timezone;
const sweepTime = new Date(discovery.sweep.completedAt).getTime();
const configuredLocalCities = new Set(
  Object.values(config.areas ?? {}).flat(),
);

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_ABBREVS = MONTHS.map((month) => month.slice(0, 3));

const LUMA_CATEGORIES = new Set([
  "AI",
  "Tech",
  "Crypto",
  "Science",
  "Climate",
  "Gaming",
  "Business",
  "Education",
  "Arts & Culture",
  "Wellness",
  "Fitness",
  "Music",
  "Food & Drink",
]);

const KEYWORD_TAGS = [
  [/\bagent/i, "Agents"],
  [/\bvoice\b/i, "Voice AI"],
  [/\binfra(structure)?\b/i, "Infra"],
  [/vibe.?cod/i, "Vibe coding"],
  [/social (good|impact)/i, "Social impact"],
  [/\btoken/i, "Token economy"],
  [/\bdata\b/i, "Data"],
  [/\bdesign/i, "Design"],
];

// --- timezone helpers (no external deps) ---

function zoneParts(utcMs, tz) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zoneOffsetMs(utcMs, tz) {
  const p = zoneParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

function localToUtc(year, month, day, hour, minute, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let utc = naive - zoneOffsetMs(naive, tz);
  utc = naive - zoneOffsetMs(utc, tz);
  return utc;
}

function toIsoWithOffset(utcMs, tz) {
  const p = zoneParts(utcMs, tz);
  const offsetMinutes = zoneOffsetMs(utcMs, tz) / 60000;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function weekdayInZone(utcMs, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(new Date(utcMs));
}

// --- evidence parsing ---

function parseTime(hourStr, minuteStr, meridiem) {
  let hour = Number(hourStr) % 12;
  if (meridiem === "PM") hour += 12;
  return { hour, minute: Number(minuteStr) };
}

const DATE_LINE = new RegExp(
  `^(${WEEKDAYS.join("|")}), (${MONTHS.join("|")}) (\\d{1,2})(?:, (\\d{4}))?$`,
);
// Luma renders times event-local; when the viewer's timezone differs it
// appends a label ("9:00 AM - 7:00 PM PDT"), so allow an optional suffix.
const TIME_LINE = new RegExp(
  `^(\\d{1,2}):(\\d{2}) (AM|PM) - (?:(${MONTH_ABBREVS.join("|")}) (\\d{1,2}), )?(\\d{1,2}):(\\d{2}) (AM|PM)(?: [A-Z]{2,5})?$`,
);

function inferYear(weekdayName, monthIndex, day, explicitYear) {
  if (explicitYear) return explicitYear;
  const sweepYear = zoneParts(sweepTime, timezone).year;
  const matches = [];
  for (const year of [sweepYear, sweepYear + 1]) {
    const utc = localToUtc(year, monthIndex + 1, day, 12, 0, timezone);
    if (weekdayInZone(utc, timezone) === weekdayName) {
      matches.push({ year, utc });
    }
  }
  // Prefer a weekday-consistent year whose date is not far in the past.
  for (const match of matches) {
    if (match.utc >= sweepTime - 36 * 3600 * 1000) return match.year;
  }
  if (matches.length) return matches[0].year;
  return sweepYear;
}

function parseSchedule(lines) {
  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(DATE_LINE);
    if (!dateMatch) continue;
    const timeMatch = lines[i + 1]?.match(TIME_LINE);
    if (!timeMatch) continue;

    const [, weekdayName, monthName, dayStr, yearStr] = dateMatch;
    const monthIndex = MONTHS.indexOf(monthName);
    const day = Number(dayStr);
    const year = inferYear(
      weekdayName,
      monthIndex,
      day,
      yearStr ? Number(yearStr) : null,
    );

    const startTime = parseTime(timeMatch[1], timeMatch[2], timeMatch[3]);
    const endTime = parseTime(timeMatch[6], timeMatch[7], timeMatch[8]);

    let endMonthIndex = monthIndex;
    let endDay = day;
    if (timeMatch[4]) {
      endMonthIndex = MONTH_ABBREVS.indexOf(timeMatch[4]);
      endDay = Number(timeMatch[5]);
    }
    let endYear = year;
    if (endMonthIndex < monthIndex) endYear += 1;

    const startUtc = localToUtc(
      year,
      monthIndex + 1,
      day,
      startTime.hour,
      startTime.minute,
      timezone,
    );
    let endUtc = localToUtc(
      endYear,
      endMonthIndex + 1,
      endDay,
      endTime.hour,
      endTime.minute,
      timezone,
    );
    // Same-day listings ending after midnight ("9:00 PM - 1:00 AM").
    if (endUtc <= startUtc) endUtc += 24 * 3600 * 1000;

    return { startUtc, endUtc, timeLineIndex: i + 1 };
  }
  return null;
}

function parseStructuredSchedule(structuredEvent) {
  if (!structuredEvent?.startDate || !structuredEvent?.endDate) return null;
  const startUtc = Date.parse(structuredEvent.startDate);
  const endUtc = Date.parse(structuredEvent.endDate);
  if (
    !Number.isFinite(startUtc) ||
    !Number.isFinite(endUtc) ||
    endUtc <= startUtc
  ) {
    return null;
  }
  return { startUtc, endUtc, timeLineIndex: -1 };
}

function parseLocation(lines, timeLineIndex) {
  const registrationIndex = lines.indexOf("Registration", timeLineIndex);
  const stop =
    registrationIndex > 0
      ? registrationIndex
      : Math.min(timeLineIndex + 4, lines.length);
  const locationLines = lines
    .slice(timeLineIndex + 1, stop)
    .filter((line) => line !== "Register to See Address");

  let city = null;
  const venueLines = [];
  for (const line of locationLines) {
    const cityMatch = line.match(
      /^(.*?),\s*(CA|California|United States|[A-Z]{2})$/,
    );
    if (cityMatch && !/\d/.test(cityMatch[1])) {
      city = cityMatch[1].trim();
    } else {
      venueLines.push(line);
    }
  }
  if (!city) {
    const placePattern = new RegExp(
      `\\b(${config.placeTerms
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})\\b`,
      "i",
    );
    for (const line of locationLines) {
      const match = line.match(placePattern);
      if (match) {
        city = match[1]
          .split(" ")
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(" ");
        break;
      }
    }
  }

  let venue = venueLines.join(", ") || null;
  if (venue && city) {
    venue = venue.replace(new RegExp(`[,\\s]*${city}\\s*$`, "i"), "").trim() || null;
  }
  return { venue, city };
}

function parseStructuredLocation(structuredEvent, evidence) {
  const location = structuredEvent?.location ?? {};
  let city = location.city || null;
  if (!city) {
    const placePattern = new RegExp(
      `\\b(${config.placeTerms
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})\\b`,
      "i",
    );
    const match = evidence.match(placePattern);
    if (match) {
      city = match[1]
        .split(" ")
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(" ");
    }
  }
  const rawVenue = location.name || null;
  let venue =
    rawVenue && !/^(online|virtual)( event)?$/i.test(rawVenue)
      ? rawVenue
      : null;
  if (venue && city) {
    const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${escapedCity}(?:,\\s*[^,]+)?$`, "i").test(venue)) {
      venue = null;
    } else {
      venue =
        venue.replace(new RegExp(`,?\\s*${escapedCity}\\s*$`, "i"), "").trim() ||
        null;
    }
  }
  return { venue, city };
}

function areaForCity(city) {
  if (!city) return "Bay Area";
  const lower = city.toLowerCase();
  for (const [area, cities] of Object.entries(config.areas ?? {})) {
    if (cities.includes(lower)) return area;
  }
  return "Bay Area";
}

function parseOrganizer(lines) {
  const presentedIndex = lines.indexOf("Presented by");
  if (presentedIndex >= 0 && lines[presentedIndex + 1]) {
    return lines[presentedIndex + 1];
  }
  const hostedIndex = lines.indexOf("Hosted By");
  if (hostedIndex >= 0 && lines[hostedIndex + 1]) {
    return lines[hostedIndex + 1];
  }
  return "Unknown organizer";
}

function parseCandidateOrganizer(candidate, lines) {
  const structured = candidate.structuredEvent?.organizers?.[0];
  if (structured) return structured;
  const parsed = parseOrganizer(lines);
  if (parsed !== "Unknown organizer") return parsed;
  try {
    const hostname = new URL(candidate.url).hostname.replace(/^www\./, "");
    if (hostname === "x.ai") return "xAI";
    return hostname;
  } catch {
    return parsed;
  }
}

function parseStatus(lines) {
  const registrationIndex = lines.indexOf("Registration");
  if (registrationIndex < 0) return "Check page";
  const aboutIndex = lines.indexOf("About Event");
  const block = lines
    .slice(
      registrationIndex + 1,
      aboutIndex > registrationIndex ? aboutIndex : registrationIndex + 12,
    )
    .join("\n");

  if (/Sold Out/i.test(block)) return "Sold out";
  if (/Join Waitlist|Event Full/i.test(block)) return "Waitlist";
  if (/Registration Closed|not currently taking registrations/i.test(block)) {
    return "Closed";
  }
  if (/^Register$/m.test(block)) return "Open";
  if (/Approval Required|Request to Join|Require Approval/i.test(block)) {
    return "Approval";
  }
  return "Check page";
}

function parseCandidateStatus(candidate, lines) {
  const evidence = candidate.evidence;
  if (
    /applications? closed|application deadline.*(?:passed|closed)/i.test(
      evidence,
    )
  ) {
    return "Closed";
  }
  if (/schema\.org\/SoldOut/i.test(
    candidate.structuredEvent?.offerAvailability ?? "",
  )) {
    return "Sold out";
  }
  const parsed = parseStatus(lines);
  if (parsed !== "Check page") return parsed;
  if (/applications? open|apply to attend/i.test(evidence)) return "Approval";
  if (/register|registration open/i.test(evidence)) return "Open";
  return parsed;
}

function stableEventId(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "luma.com") return parsed.pathname.slice(1);
  const host = parsed.hostname
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/gi, "-");
  const path = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/gi, "-");
  const readable = `${host}-${path}`.replace(/-+/g, "-").slice(0, 54);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `external-${readable || "event"}-${hash}`;
}

function parsePrize(title, evidence) {
  const lines = `${title}\n${evidence}`.split("\n");
  for (const line of lines) {
    if (!/priz|cash|bount|credits/i.test(line)) continue;
    const amountMatch = line.match(/\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\+?/);
    if (amountMatch) {
      const amount = amountMatch[0].replace(/\s/g, "");
      return {
        amount,
        label: /cash/i.test(line) ? `${amount} cash` : `${amount} prizes`,
      };
    }
  }
  if (/priz|bount/i.test(`${title}\n${evidence}`)) {
    return { amount: null, label: "Prizes listed" };
  }
  return { amount: null, label: "Not listed" };
}

function parseTags(lines, title, evidence) {
  const tags = [];
  const reportIndex = lines.indexOf("Report Event");
  if (reportIndex >= 0) {
    for (const line of lines.slice(reportIndex + 1, reportIndex + 5)) {
      if (LUMA_CATEGORIES.has(line)) tags.push(line);
      else break;
    }
  }
  const haystack = `${title}\n${evidence.slice(0, 500)}`;
  for (const [pattern, tag] of KEYWORD_TAGS) {
    if (tags.length >= 4) break;
    if (!tags.includes(tag) && pattern.test(haystack)) tags.push(tag);
  }
  return tags;
}

function parseGoing(lines) {
  for (const line of lines) {
    const match = line.match(/^(\d+) Going$/);
    if (match) return Number(match[1]);
  }
  return null;
}

// --- presentation helpers ---

function shortTime(utcMs) {
  const p = zoneParts(utcMs, timezone);
  const hour12 = p.hour % 12 || 12;
  const suffix = p.hour >= 12 ? "pm" : "am";
  return p.minute ? `${hour12}:${String(p.minute).padStart(2, "0")}${suffix}` : `${hour12}${suffix}`;
}

function describeSchedule(schedule) {
  if (!schedule) return { dateLabel: "TBC", dateDetail: "Date on event page" };
  const start = zoneParts(schedule.startUtc, timezone);
  const end = zoneParts(schedule.endUtc, timezone);
  const dateLabel = `${MONTH_ABBREVS[start.month - 1].toUpperCase()} ${String(start.day).padStart(2, "0")}`;
  const startWeekday = weekdayInZone(schedule.startUtc, timezone).slice(0, 3);
  const sameDay =
    start.year === end.year && start.month === end.month && start.day === end.day;
  if (sameDay) {
    return {
      dateLabel,
      dateDetail: `${startWeekday} · ${shortTime(schedule.startUtc)}–${shortTime(schedule.endUtc)}`,
    };
  }
  const endWeekday = weekdayInZone(schedule.endUtc, timezone).slice(0, 3);
  const days = Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) -
      Date.UTC(start.year, start.month - 1, start.day)) /
      86400000,
  ) + 1;
  return {
    dateLabel,
    dateDetail: `${startWeekday}–${endWeekday} · ${days} days`,
  };
}

function buildWhy(schedule, prize, evidence) {
  const parts = [];
  if (schedule) {
    const hours = (schedule.endUtc - schedule.startUtc) / 3600000;
    parts.push(
      hours > 24
        ? `${Math.ceil(hours / 24)}-day build`
        : `${Math.round(hours)}-hour build`,
    );
  } else {
    parts.push("Build event");
  }
  const formats = [];
  if (/judg/i.test(evidence)) formats.push("judging");
  if (/\bdemo/i.test(evidence)) formats.push("demos");
  if (/\bteam/i.test(evidence)) formats.push("team formation");
  if (/submission|deadline/i.test(evidence)) formats.push("a submission deadline");
  let sentence = parts[0];
  if (formats.length) sentence += ` with ${formats.join(", ")}`;
  sentence += prize.label !== "Not listed" ? `; ${prize.label.toLowerCase()}.` : ".";
  return sentence[0].toUpperCase() + sentence.slice(1);
}

// --- scoring per PROTOTYPE.md: 40% confidence, 25% builder value,
// 20% accessibility, 15% freshness ---

function scoreBuilderValue(schedule, prize, evidence) {
  let value = 55;
  if (prize.amount) value += 15;
  else if (prize.label === "Prizes listed") value += 8;
  if (schedule) {
    const hours = (schedule.endUtc - schedule.startUtc) / 3600000;
    if (hours >= 8) value += 10;
  }
  if (/judg/i.test(evidence)) value += 8;
  if (/mentor|expert|partner engineer/i.test(evidence)) value += 6;
  if (/\btrack/i.test(evidence)) value += 5;
  return Math.min(100, value);
}

function scoreAccessibility(status, area) {
  const base =
    { Open: 92, Approval: 74, Waitlist: 45, Closed: 28, "Sold out": 35 }[
      status
    ] ?? 60;
  const areaBonus =
    { SF: 8, "East Bay": 3, Peninsula: 3, "South Bay": 0 }[area] ?? -5;
  return Math.max(0, Math.min(100, base + areaBonus));
}

function scoreFreshness(schedule) {
  if (!schedule) return 50;
  const daysUntil = (schedule.startUtc - sweepTime) / 86400000;
  if (daysUntil < 0) return 96; // already underway but not ended
  if (daysUntil <= 2) return 100;
  if (daysUntil <= 7) return 92;
  if (daysUntil <= 14) return 84;
  if (daysUntil <= 30) return 70;
  if (daysUntil <= 60) return 55;
  return 40;
}

// --- normalize each candidate ---

const events = [];
for (const candidate of discovery.candidates) {
  const lines = candidate.evidence
    .split("\n")
    .map((line) => line.replace(/​/g, "").trim())
    .filter(Boolean);

  const schedule =
    parseStructuredSchedule(candidate.structuredEvent) ?? parseSchedule(lines);
  if (schedule && schedule.endUtc < sweepTime) continue; // second-layer past filter
  const structuredCity = candidate.structuredEvent?.location?.city?.toLowerCase();
  if (structuredCity && !configuredLocalCities.has(structuredCity)) continue;

  const location = candidate.structuredEvent
    ? parseStructuredLocation(candidate.structuredEvent, candidate.evidence)
    : schedule
      ? parseLocation(lines, schedule.timeLineIndex)
      : { venue: null, city: null };
  const area = areaForCity(location.city);
  const status = parseCandidateStatus(candidate, lines);
  const prize = parsePrize(candidate.title, candidate.evidence);
  const { dateLabel, dateDetail } = describeSchedule(schedule);

  const builderValue = scoreBuilderValue(schedule, prize, candidate.evidence);
  const accessibility = scoreAccessibility(status, area);
  const freshness = scoreFreshness(schedule);
  const score = Math.round(
    0.4 * candidate.confidence +
      0.25 * builderValue +
      0.2 * accessibility +
      0.15 * freshness,
  );

  events.push({
    id: stableEventId(candidate.url),
    url: candidate.url,
    platform:
      new URL(candidate.url).hostname === "luma.com" ? "luma" : "external",
    // "hackathon" is the real thing; "adjacent" is a build-adjacent event
    // (pitch night, demo day, robot night) that is worth listing but should
    // never be presented as a hackathon.
    category: candidate.category === "adjacent" ? "adjacent" : "hackathon",
    adjacentReason: candidate.category === "adjacent" ? candidate.heldBecause ?? null : null,
    title: candidate.title,
    organizer: parseCandidateOrganizer(candidate, lines),
    venue: location.venue,
    city: location.city,
    area,
    start: schedule ? toIsoWithOffset(schedule.startUtc, timezone) : null,
    end: schedule ? toIsoWithOffset(schedule.endUtc, timezone) : null,
    timezone,
    dateLabel,
    dateDetail,
    status,
    prize: prize.label,
    tags: parseTags(lines, candidate.title, candidate.evidence),
    going: parseGoing(lines),
    why: buildWhy(schedule, prize, candidate.evidence),
    score,
    confidence: candidate.confidence,
    scores: {
      confidence: candidate.confidence,
      builderValue,
      accessibility,
      freshness,
    },
    discoveredVia: candidate.discoveredVia,
    checkedAt: candidate.checkedAt,
  });
}

// Hackathons rank above adjacent events regardless of score: the board's
// promise is a hackathon index, and an adjacent event should never outrank a
// real one just because it scored well on accessibility.
events.sort(
  (a, b) =>
    (a.category === b.category ? 0 : a.category === "hackathon" ? -1 : 1) ||
    b.score - a.score ||
    (a.start ?? "9999").localeCompare(b.start ?? "9999"),
);

const output = {
  meta: {
    city: discovery.sweep.city,
    timezone,
    sweepCompletedAt: discovery.sweep.completedAt,
    pagesVisited: discovery.sweep.pagesVisited,
    candidatesFound: discovery.sweep.candidatesFound,
    publishedCount: events.length,
    hackathonCount: events.filter((event) => event.category === "hackathon").length,
    adjacentCount: events.filter((event) => event.category === "adjacent").length,
    organizerCount: new Set(events.map((e) => e.organizer)).size,
    sourceCount: new Set(events.map((e) => e.discoveredVia)).size,
    seedCount: config.seedUrls.length,
    externalCount: events.filter((event) => event.platform === "external")
      .length,
  },
  events,
};

// --- history + change detection ---

const historyDir = resolve(root, "data/history");
await mkdir(historyDir, { recursive: true });
const stamp = discovery.sweep.completedAt.replace(/[:.]/g, "-");
const currentHistoryName = `sweep-${stamp}.json`;
const previousSnapshots = (await readdir(historyDir))
  .filter((name) => name.endsWith(".json") && name !== currentHistoryName)
  .sort();

let previous = null;
if (previousSnapshots.length) {
  previous = JSON.parse(
    await readFile(
      resolve(historyDir, previousSnapshots[previousSnapshots.length - 1]),
      "utf8",
    ),
  );
}

const TRACKED_FIELDS = ["title", "start", "end", "status", "venue", "prize"];
const previousByUrl = new Map(
  (previous?.events ?? []).map((event) => [event.url, event]),
);
const currentByUrl = new Map(events.map((event) => [event.url, event]));

const changes = {
  comparedTo: previous?.meta.sweepCompletedAt ?? null,
  sweepCompletedAt: discovery.sweep.completedAt,
  added: events.filter((e) => !previousByUrl.has(e.url)).map((e) => e.url),
  removed: [...previousByUrl.keys()].filter((url) => !currentByUrl.has(url)),
  updated: events
    .filter((event) => {
      const before = previousByUrl.get(event.url);
      return (
        before && TRACKED_FIELDS.some((field) => before[field] !== event[field])
      );
    })
    .map((event) => {
      const before = previousByUrl.get(event.url);
      const fields = {};
      for (const field of TRACKED_FIELDS) {
        if (before[field] !== event[field]) {
          fields[field] = { from: before[field], to: event[field] };
        }
      }
      return { url: event.url, title: event.title, fields };
    }),
};

await writeFile(
  resolve(historyDir, currentHistoryName),
  `${JSON.stringify(output, null, 2)}\n`,
);
await writeFile(
  resolve(root, "data/changes.json"),
  `${JSON.stringify(changes, null, 2)}\n`,
);
await writeFile(
  resolve(root, "data/events.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log(
  `Normalized ${events.length}/${discovery.candidates.length} candidates ` +
    `(+${changes.added.length} added, ~${changes.updated.length} updated, ` +
    `-${changes.removed.length} removed vs previous sweep).`,
);
