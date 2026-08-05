// Matching a board event against a row on the Luma calendar.
//
// Pure functions, no browser, so the decisions the sync makes can be tested
// without driving a UI. These are the decisions that matter most: get them wrong
// in one direction and an event is added twice, wrong in the other and it is
// skipped forever.

/** A Luma event's slug, or null for anything hosted elsewhere. */
export function eventSlug(event) {
  try {
    const url = new URL(event.url);
    if (url.hostname !== "luma.com") return null;
    return url.pathname.replace(/^\/+|\/+$/g, "") || null;
  } catch {
    return null;
  }
}

const key = (text) => String(text ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * Loose title match, for events that have no Luma slug to compare.
 *
 * Luma trims and re-cases titles and a calendar row may show a truncated one, so
 * either side is allowed to contain the other — but only above a length floor.
 * Without it a short title like "Hack" would match nearly every row, and the sync
 * would believe everything was already on the calendar.
 */
export function titleOnCalendar(titles, title) {
  const wanted = key(title);
  if (!wanted) return false;
  for (const candidate of titles) {
    const seen = key(candidate);
    if (seen === wanted) return true;
    if (
      wanted.length >= 18 &&
      seen.length >= 18 &&
      (seen.includes(wanted) || wanted.includes(seen))
    ) {
      return true;
    }
  }
  return false;
}

/** Is this event on the calendar? By slug when it has one, by title otherwise. */
export function isOnCalendar(event, state) {
  const slug = eventSlug(event);
  if (slug) return state.slugs.has(slug);
  return titleOnCalendar(state.titles, event.title);
}

/**
 * Make the ledger agree with the calendar, in both directions: adopt events that
 * are there but unrecorded, and un-record ones that are not there so they become
 * pending again instead of being skipped forever.
 */
export function reconcile(ledger, allEvents, state, { markSynced }) {
  let adopted = 0;
  let cleared = 0;
  for (const event of allEvents) {
    const present = isOnCalendar(event, state);
    if (present && !ledger.synced[event.id]) {
      markSynced(ledger, event, eventSlug(event) ? "luma-ui" : "luma-ui-external");
      adopted += 1;
    } else if (!present && ledger.synced[event.id]) {
      delete ledger.synced[event.id];
      cleared += 1;
    }
  }
  return { adopted, cleared };
}
