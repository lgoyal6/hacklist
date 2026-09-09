// Reading the event log, and the two things that are easy to get wrong about it:
// which impressions belong to one rendered list, and what counts as evidence
// available at the moment that list was rendered.
//
// Shared by the synthesizer, the trainer and the evaluator so that all three
// agree about it. The alternative is three subtly different definitions of a
// render, which is the shape of most reported offline wins.

import { readFile } from "node:fs/promises";

import {
  ORGANIC_SOURCE,
  validateEvent,
} from "../../app/telemetry-schema.mjs";
import {
  FEATURE_NAMES,
  extractFeatures,
  positionWeight,
} from "../../app/ranking.mjs";

/**
 * How far apart two impressions from one session may be and still be the same
 * rendered list.
 *
 * The client sends a whole list in one settled batch, so rows from one render
 * are milliseconds apart. A reader who switches view or types a search gets a
 * new list seconds later. A repeated position is the other boundary and the
 * surer one: one list cannot have two rows at rank 3.
 */
export const RENDER_GAP_MS = 5000;

/** UTC calendar day, which is what the prequential split rolls over. */
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Read a JSONL log, validating every row against the same schema the Worker
 * enforces. Clock checking is off: these rows are history, and history is in
 * the past.
 */
export async function readEventLog(path) {
  const text = await readFile(path, "utf8");
  const rows = [];
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${path}:${lineNumber} is not JSON`);
    }
    const result = validateEvent(parsed, { checkClock: false });
    if (!result.ok) {
      throw new Error(`${path}:${lineNumber} ${result.reason}`);
    }
    rows.push(result.event);
  }
  return rows;
}

/**
 * Split a log into rendered lists.
 *
 * @returns {Array<{client_id: string, session_id: string, locale: string,
 *   viewport: string, source: string, model_version: string|null, ts: number,
 *   day: string, items: Array<{event_id: string, position: number, ranking: string, ts: number}>,
 *   clicks: Map<string, number>, interactions: Map<string, number>, saves: number}>}
 */
export function groupRenders(rows) {
  const bySession = new Map();
  for (const row of rows) {
    const key = `${row.client_id}|${row.session_id}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }

  const all = [];
  for (const [, sessionRows] of bySession) {
    const ordered = [...sessionRows].sort(
      (a, b) => a.ts - b.ts || a.position - b.position,
    );

    /** This session's rendered lists, in order. */
    const renders = [];
    let seen = new Set();
    for (const row of ordered) {
      if (row.type !== "impression") continue;
      const current = renders[renders.length - 1];
      const broken =
        !current ||
        seen.has(row.position) ||
        row.ts - current.endTs > RENDER_GAP_MS;
      if (broken) {
        seen = new Set();
        renders.push({
          client_id: row.client_id,
          session_id: row.session_id,
          locale: row.locale,
          viewport: row.viewport,
          source: row.source,
          model_version: row.model_version,
          ts: row.ts,
          endTs: row.ts,
          day: dayKey(row.ts),
          items: [],
          clicks: new Map(),
          // Clicks and saves both, keyed by the event they name. A save names
          // the feed on this board, so it labels no event; the label below is
          // still click-or-save, and would start crediting saves the day a
          // per-event calendar action exists.
          interactions: new Map(),
          saves: 0,
        });
      }
      const target = renders[renders.length - 1];
      target.items.push({
        event_id: row.event_id,
        position: row.position,
        ranking: row.ranking,
        ts: row.ts,
      });
      target.endTs = row.ts;
      seen.add(row.position);
    }

    for (const row of ordered) {
      if (row.type === "impression") continue;
      // An interaction belongs to the last list rendered at or before it. One
      // that arrives before any impression in its session has no list to
      // credit, and is dropped rather than attached to the nearest one.
      let owner = null;
      for (const render of renders) {
        if (render.ts <= row.ts) owner = render;
        else break;
      }
      if (!owner) continue;
      const earliest = owner.interactions.get(row.event_id);
      if (earliest === undefined || row.ts < earliest) {
        owner.interactions.set(row.event_id, row.ts);
      }
      if (row.type === "save") {
        owner.saves += 1;
        continue;
      }
      const at = owner.clicks.get(row.event_id);
      if (at === undefined || row.ts < at) owner.clicks.set(row.event_id, row.ts);
    }

    all.push(...renders);
  }

  return all.sort((a, b) => a.ts - b.ts);
}

/**
 * A guarded view of the log's engagement, and the whole reason the leakage
 * detector can say anything.
 *
 * `priorClicks` is safe by construction: it counts clicks strictly before the
 * instant it was built for, which is what the popularity baseline is entitled
 * to know. `clicksInWindow` is the unsafe door, left deliberately open and
 * alarmed: it answers the question and records that a feature asked about a
 * time the render had not reached yet. The detector fails the run on any such
 * record, so a leak announces itself instead of showing up as a good number.
 */
export function engagementIndex(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (row.type !== "click") continue;
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row.ts);
  }
  for (const list of byEvent.values()) list.sort((a, b) => a - b);

  /** How many entries of a sorted array are strictly below a value. */
  const countBelow = (list, limit) => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid] < limit) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  return {
    /** A probe bound to one render's instant. */
    at(asOf) {
      const violations = [];
      return {
        violations,
        asOf,
        priorClicks(eventId) {
          const list = byEvent.get(eventId);
          return list ? countBelow(list, asOf) : 0;
        },
        clicksInWindow(eventId, fromMs, toMs) {
          if (toMs > asOf) {
            violations.push({
              event_id: eventId,
              asOf,
              requestedUpTo: toMs,
              reason: "a feature asked about engagement after the impression",
            });
          }
          const list = byEvent.get(eventId);
          if (!list) return 0;
          return countBelow(list, toMs) - countBelow(list, fromMs);
        },
      };
    },
  };
}

/** The extractor the ranker is meant to use: ranking-time features, nothing else. */
export const productionExtractor = {
  names: [...FEATURE_NAMES],
  extract: (event, context) => extractFeatures(event, context),
};

/**
 * Turn rendered lists into weighted training rows.
 *
 * The label is a click or a save on that event. On this board a save is
 * feed-level (subscribing covers a whole region, so it names no event), which
 * means in practice the label is driven by clicks; the code implements
 * click-or-save because a per-event calendar action would need no change here.
 *
 * The weight is the inverse-propensity correction from app/ranking.mjs, whose
 * assumed 1/rank examination curve is stated there.
 */
export function buildTrainingRows(renders, options) {
  const { catalog, defaultRegion, regionKey, extractor, index } = options;
  const rows = [];
  for (const render of renders) {
    const probe = index ? index.at(render.ts) : null;
    for (const item of render.items) {
      const event = catalog.get(item.event_id);
      if (!event) continue;
      const context = {
        asOf: item.ts,
        regionKey,
        defaultRegion,
      };
      rows.push({
        features: extractor.extract(event, context, probe),
        label: render.interactions.has(item.event_id) ? 1 : 0,
        weight: positionWeight(item.position),
        client_id: render.client_id,
        day: render.day,
        ts: item.ts,
        event_id: item.event_id,
        position: item.position,
        ranking: item.ranking,
      });
    }
  }
  return rows;
}

/**
 * The organic gate's counts. Only source=web is organic: seeded, synthetic,
 * developer and replay rows are excluded here rather than at the call site, so
 * there is one place to be wrong about it and it is tested.
 */
export function organicCounts(rows) {
  const organic = rows.filter((row) => row.source === ORGANIC_SOURCE);
  const clients = new Set();
  const days = new Set();
  let impressions = 0;
  let interactions = 0;
  for (const row of organic) {
    clients.add(row.client_id);
    days.add(dayKey(row.ts));
    if (row.type === "impression") impressions += 1;
    else interactions += 1;
  }
  const excluded = {};
  for (const row of rows) {
    if (row.source === ORGANIC_SOURCE) continue;
    excluded[row.source] = (excluded[row.source] ?? 0) + 1;
  }
  return {
    impressions,
    interactions,
    clients: clients.size,
    days: days.size,
    dayList: [...days].sort(),
    excluded_rows_by_source: excluded,
  };
}
