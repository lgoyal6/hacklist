// The browser half of POST /api/events.
//
// The identity here is deliberately weak, and that is the design rather than a
// shortcut. There is no account, no cookie and no server-derived id: a client
// id is sixteen random bytes minted in the browser, kept in localStorage with
// the time it was minted, and thrown away after seven days. The server cannot
// reconstruct who sent a row, cannot join two rows across a rotation, and is
// never sent an address, a name, a user-agent or a referrer to try.
//
// What that costs is real and worth stating: any per-client analysis can only
// reach back seven days, and a reader who clears site data or browses privately
// is a new person every time. What it buys is that the worst case for this
// dataset leaking is a list of anonymous orderings and the events clicked in
// them, which is a thing about the board rather than a thing about people.
//
// Nothing in here may break the board. Every storage read, every send and every
// call into the browser's APIs is wrapped, and a failure means no telemetry and
// a board that works exactly as it did before any of this existed.

import {
  CLIENT_ID_ROTATION_DAYS,
  FEED_EVENT_ID,
  MAX_BATCH,
} from "./telemetry-schema.mjs";

const ENDPOINT = "/api/events";
const STORAGE_KEY = "hacklist.client";
const ROTATION_MS = CLIENT_ID_ROTATION_DAYS * 86400000;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** How long a batch of impressions waits for the list to settle. */
const SETTLE_MS = 700;
/** Where the board stops calling itself narrow. */
const NARROW_MAX_WIDTH = 768;

export type RankingLabel = "production" | "candidate" | "none";

export type Identity = {
  clientId: string;
  sessionId: string;
  /** When the client id was minted, so a reader can see the rotation working. */
  createdAt: number;
  source: "web" | "dev";
};

export type RenderContext = {
  locale: string;
  modelVersion: string | null;
  /** What the list is: region, view and query. A new signature is a new list. */
  signature: string;
};

type Row = {
  type: "impression" | "click" | "save";
  ts: number;
  client_id: string;
  session_id: string;
  locale: string;
  event_id: string;
  position: number;
  ranking: RankingLabel;
  model_version: string | null;
  viewport: "narrow" | "wide";
  source: "web" | "dev";
};

/** base64url of sixteen random bytes: 22 characters, no padding. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * localhost, a .local name and a workers.dev preview are all us, not a reader.
 * Tagged at the source rather than guessed later, so the evaluator can exclude
 * developer traffic from the organic counts without having to know our hosts.
 */
function detectSource(): "web" | "dev" {
  const host = window.location.hostname;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".workers.dev")
  ) {
    return "dev";
  }
  return "web";
}

const viewportBucket = (): "narrow" | "wide" =>
  window.innerWidth < NARROW_MAX_WIDTH ? "narrow" : "wide";

let cached: Identity | null | undefined;

function mint(): Identity | null {
  if (typeof window === "undefined") return null;

  let store: Storage;
  try {
    store = window.localStorage;
    // Safari in private mode, and any browser set to block site data, throws on
    // access rather than on write. No storage means no client id at all, which
    // means no telemetry and the production ordering: the most private outcome
    // is also the simplest code path.
    store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }

  const now = Date.now();
  let clientId = "";
  let createdAt = 0;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown; createdAt?: unknown };
      const minted = typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
      if (
        typeof parsed.id === "string" &&
        ID_PATTERN.test(parsed.id) &&
        minted > 0 &&
        // A stored time in the future means the clock moved, not that the id is
        // young; rotate rather than trust it.
        minted <= now &&
        now - minted < ROTATION_MS
      ) {
        clientId = parsed.id;
        createdAt = minted;
      }
    }
  } catch {
    // An unreadable value is treated as an expired one.
  }

  if (!clientId) {
    clientId = randomId();
    createdAt = now;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ id: clientId, createdAt }));
    } catch {
      return null;
    }
  }

  return {
    clientId,
    // Per page load, never stored. A session is how one visit is grouped; it is
    // not meant to survive the tab closing.
    sessionId: randomId(),
    createdAt,
    source: detectSource(),
  };
}

/**
 * The identity for this page load, or null if there is none to be had.
 *
 * Cached at module level so it is referentially stable: the board reads it
 * through useSyncExternalStore, which requires the same object back on every
 * call or it re-renders forever.
 */
export function identity(): Identity | null {
  if (cached === undefined) cached = mint();
  return cached;
}

/** The server render has no identity, and must not invent one. */
export const serverIdentity = (): null => null;

const queue: Row[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushBound = false;
const reported = new Set<string>();

function send(rows: Row[]): void {
  const body = JSON.stringify({ events: rows });
  try {
    // sendBeacon first: it survives the navigation a click starts, which a
    // plain fetch does not reliably, and it posts text/plain, which the
    // endpoint accepts. It returns false when the browser refuses to queue it.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(ENDPOINT, body)) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => {});
  } catch {
    // Telemetry is never a reason for the board to misbehave.
  }
}

export function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  while (queue.length > 0) {
    send(queue.splice(0, MAX_BATCH));
  }
}

function bindFlush(): void {
  if (flushBound || typeof window === "undefined") return;
  flushBound = true;
  try {
    // pagehide rather than unload: unload is unreliable on mobile Safari and
    // blocks the back/forward cache.
    window.addEventListener("pagehide", flush);
  } catch {
    flushBound = false;
  }
}

function enqueue(row: Row, immediate: boolean): void {
  queue.push(row);
  bindFlush();
  if (immediate || queue.length >= MAX_BATCH) {
    flush();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, SETTLE_MS);
  }
}

function row(
  who: Identity,
  context: RenderContext,
  type: Row["type"],
  event_id: string,
  position: number,
  ranking: RankingLabel,
): Row {
  return {
    type,
    ts: Date.now(),
    client_id: who.clientId,
    session_id: who.sessionId,
    locale: context.locale,
    event_id,
    position,
    ranking,
    model_version: context.modelVersion,
    viewport: viewportBucket(),
    source: who.source,
  };
}

export type Shown = {
  eventId: string;
  /** 0-based rank as shown, which is what the position-bias correction needs. */
  position: number;
  ranking: RankingLabel;
};

/**
 * One impression per row of the list, sent once per list.
 *
 * Batched and settled rather than sent per render: typing in the search box
 * re-renders on every keystroke, and each of those is the same list a moment
 * later. The dedupe key is the list signature plus the row's own place in it,
 * so switching view and coming back does not double-count, and a genuinely
 * different order does not silently reuse the old rows.
 */
export function recordImpressions(shown: Shown[], context: RenderContext): void {
  const who = identity();
  if (!who) return;
  for (const item of shown) {
    const key = `${context.signature}|${item.eventId}|${item.position}|${item.ranking}`;
    if (reported.has(key)) continue;
    reported.add(key);
    enqueue(
      row(who, context, "impression", item.eventId, item.position, item.ranking),
      false,
    );
  }
}

/** A click on an event's own link, with the rank and team it was shown at. */
export function recordClick(item: Shown, context: RenderContext): void {
  const who = identity();
  if (!who) return;
  enqueue(row(who, context, "click", item.eventId, item.position, item.ranking), true);
}

/**
 * A subscribe or download of the calendar feed.
 *
 * The feed covers a whole region, so this is not a vote for the event at the
 * top of the list: it carries the feed sentinel and a ranking of "none" rather
 * than crediting whichever ordering happened to be showing.
 */
export function recordSave(context: RenderContext): void {
  const who = identity();
  if (!who) return;
  enqueue(row(who, context, "save", FEED_EVENT_ID, 0, "none"), true);
}
