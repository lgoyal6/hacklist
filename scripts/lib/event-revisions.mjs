// What happens to a calendar entry between one sweep and the next.
//
// A published .ics is a subscription, not a report. Someone's phone holds these
// rows, and the only handle it has on an entry is the UID, which is derived from
// the event's URL and does not change. That much already worked: a renamed venue
// or a moved date rewrites the same VEVENT and the subscriber's row updates in
// place.
//
// What did not work is absence. events.json was rebuilt from each sweep's own
// output, so an event the sweep failed to read simply was not in the file, and
// a Luma rate limit on one page removed that hackathon from every subscription
// that had it. On the phone, "the source 429'd" and "the organizer cancelled"
// are the same event: the row disappears. The collapse breaker in
// normalize-events catches a sweep that loses most of the board, which is a
// pipeline failure; it says nothing about one page out of forty.
//
// So a missing read is treated as missing, not as news. The event is carried
// forward with the fields the last good sweep established, for a bounded number
// of sweeps, and a counter says how long it has been unconfirmed. An event that
// is genuinely gone leaves either by running its course or by running out of
// that budget.
//
// A cancellation is the opposite case and has to be published rather than
// dropped: an entry that vanishes leaves the subscriber believing the hackathon
// is still on, because their client has nothing to act on. A cancelled event
// stays in the feed, marked, until its date passes.

/** Fields whose change is worth reporting as a revision of an existing entry. */
export const TRACKED_FIELDS = ["title", "start", "end", "status", "venue", "prize"];

/** The one status value that means the organizer called it off. */
export const CANCELLED = "Cancelled";

/**
 * Whether the organizer's own page says the event is off.
 *
 * schema.org/EventCancelled is the only cancellation signal that is stated
 * rather than inferred from wording, and the sweep has been reading it into
 * every candidate since structured events existed without anything looking at
 * it. It has to outrank the registration wording: a cancelled hackathon whose
 * Register button is still rendered is cancelled.
 *
 * Here rather than in normalize-events because a branch that decides whether an
 * entry gets published as called-off should be reachable from a test, and
 * normalize-events is a script with no seam into it.
 */
export function cancelledByOrganizer(candidate) {
  return /EventCancelled/i.test(
    String(candidate?.structuredEvent?.eventStatus ?? ""),
  );
}

/** How many consecutive sweeps may fail to see an event before it is dropped. */
export const DEFAULT_MAX_MISSED_SWEEPS = 3;

function isOver(event, now) {
  const last = Date.parse(event.end ?? event.start ?? "");
  return Number.isFinite(last) && last < now;
}

/**
 * The events to publish, and what changed since the last good sweep.
 *
 * `current` is what this sweep read. `previous` is the last published set,
 * which is where a carried event's fields and its missed-sweep count come from.
 * Returns the same `added` / `removed` / `updated` shape data/changes.json has
 * always had, plus `carried` and `cancelled`.
 */
export function reconcile({
  current,
  previous = [],
  now = Date.now(),
  maxMissedSweeps = DEFAULT_MAX_MISSED_SWEEPS,
}) {
  const previousByUrl = new Map(previous.map((event) => [event.url, event]));
  const published = new Map();
  const duplicates = [];

  for (const event of current) {
    if (published.has(event.url)) {
      // Two sources describing one event under one URL would otherwise put two
      // rows with the same UID on the subscription. Dedupe upstream collapses
      // the usual case; this is the backstop, and it keeps the first, which is
      // the higher-scoring one after the sort.
      duplicates.push(event.url);
      continue;
    }
    // Seen this sweep, so whatever it had been missing for is settled.
    published.set(event.url, { ...event, missedSweeps: 0 });
  }

  const carried = [];
  const removed = [];
  for (const [url, before] of previousByUrl) {
    if (published.has(url)) continue;
    if (isOver(before, now)) {
      // It ran. Dropping it is not a claim about cancellation, and the feed
      // stops serving finished events anyway.
      removed.push(url);
      continue;
    }
    const missedSweeps = (before.missedSweeps ?? 0) + 1;
    if (missedSweeps > maxMissedSweeps) {
      // Held long enough. Past this point the more likely story is that the
      // event was taken down, and carrying a stale row forever is its own
      // wrong answer.
      removed.push(url);
      continue;
    }
    published.set(url, { ...before, missedSweeps });
    carried.push({ url, missedSweeps });
  }

  const events = [...published.values()];
  const updated = [];
  for (const event of events) {
    const before = previousByUrl.get(event.url);
    // A carried event falls out of this on its own rather than being skipped:
    // it is a copy of `before` with only missedSweeps changed, and that is not
    // a tracked field. A sweep that did not read an event cannot report a
    // revision to it.
    if (!before) continue;
    const fields = {};
    for (const field of TRACKED_FIELDS) {
      if (before[field] !== event[field]) {
        fields[field] = { from: before[field] ?? null, to: event[field] ?? null };
      }
    }
    if (Object.keys(fields).length) {
      updated.push({ url: event.url, title: event.title, fields });
    }
  }

  return {
    events,
    changes: {
      added: events
        .filter((event) => !previousByUrl.has(event.url))
        .map((event) => event.url),
      removed,
      updated,
      carried,
      cancelled: events
        .filter((event) => event.status === CANCELLED)
        .map((event) => event.url),
      duplicates,
    },
  };
}
