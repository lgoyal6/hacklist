// Which search queries a run sends.
//
// Search and LinkedIn discovery both send a few queries per run from a longer
// list and rotate through it, because the job runs twice a day and firing the
// whole list at once gets a keyless endpoint blocked and burns a metered quota.
//
// A plain rotation treats every query alike, which quietly starves the smaller
// regions. The LinkedIn list had two San Diego queries out of ten at three per
// run, so San Diego came round a little over once a day, and 0 of the 60 seeds
// it held had come from one. So every region other than the default one keeps
// one slot a run, rotating through its own queries, and the default region
// rotates through what is left.

/** Lowercased place names a region answers to: its label and every area city. */
function regionTerms(region) {
  const terms = [region.label, region.coreArea];
  for (const cities of Object.values(region.areas ?? {})) terms.push(...cities);
  return terms.filter(Boolean).map((term) => term.toLowerCase());
}

/**
 * The non-default region a query is about, or null for the default region.
 *
 * Matched on whole words so "sd" in a URL path or "la" inside another word
 * cannot claim a query.
 */
export function queryRegion(query, config) {
  const text = query.toLowerCase();
  for (const [key, region] of Object.entries(config.regions ?? {})) {
    if (key === config.defaultRegion || region.online) continue;
    const named = regionTerms(region).some((term) =>
      new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(text),
    );
    if (named) return key;
  }
  return null;
}

function rotate(items, size, slot) {
  if (!items.length || size <= 0) return [];
  const count = Math.min(size, items.length);
  const start = ((slot * count) % items.length + items.length) % items.length;
  return Array.from({ length: count }, (_, i) => items[(start + i) % items.length]);
}

/**
 * `perRun` queries for this slot: one per non-default region that has any, the
 * rest from the default region's rotation. A region's slot is taken only while
 * the budget allows, so a perRun smaller than the region count still sends
 * exactly perRun queries.
 */
export function pickQueries(all, perRun, config, slot = currentSlot()) {
  const size = Math.min(perRun, all.length);
  const byRegion = new Map();
  const rest = [];
  for (const query of all) {
    const region = queryRegion(query, config);
    if (!region) {
      rest.push(query);
      continue;
    }
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(query);
  }
  const picked = [];
  for (const queries of byRegion.values()) {
    if (picked.length >= size) break;
    picked.push(...rotate(queries, 1, slot));
  }
  picked.push(...rotate(rest, size - picked.length, slot));
  return picked;
}

/** A stateless slot that advances every 12 hours, matching the schedule. */
export function currentSlot(now = Date.now()) {
  return Math.floor(now / (12 * 3_600 * 1_000));
}
