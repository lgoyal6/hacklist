// The sweep's work queue, with a page reserve per region.
//
// The sweep stops on a page budget, and the default region's graph is large
// enough to spend all of it: San Francisco's seeds link to calendars that link
// to more calendars, and most September sweeps stopped on 870 of 870 pages.
// San Diego's seeds were visited (configured seeds drain first), but everything
// they led to joined the same queue behind a Bay Area frontier that kept
// unshifting promising links ahead of it, so a San Diego calendar's events were
// a lottery ticket.
//
// A region with a reserve gets its own queue, served ahead of the shared one
// until it has spent that many pages. Past the reserve its leftovers join the
// shared queue and compete like anything else, so a reserve is a floor and
// never a cap. Items without a region, or for a region with no reserve, go
// straight to the shared queue, which behaves exactly as the single queue did.

export function createCrawlQueue({ reserve = {} } = {}) {
  const shared = [];
  const reserved = new Map();
  const spent = new Map();

  const left = (region) => (reserve[region] ?? 0) - (spent.get(region) ?? 0);

  function add(item, { front = false } = {}) {
    let target = shared;
    if (item.region && left(item.region) > 0) {
      if (!reserved.has(item.region)) reserved.set(item.region, []);
      target = reserved.get(item.region);
    }
    if (front) target.unshift(item);
    else target.push(item);
  }

  function next() {
    for (const [region, items] of reserved) {
      if (!items.length) continue;
      if (left(region) > 0) return items.shift();
      // Reserve spent: what is left competes in the shared queue from here on.
      shared.push(...items.splice(0));
    }
    return shared.shift();
  }

  /** Count a page actually visited against its region's reserve. */
  function spend(region) {
    if (region) spent.set(region, (spent.get(region) ?? 0) + 1);
  }

  return {
    add,
    next,
    spend,
    get length() {
      let total = shared.length;
      for (const items of reserved.values()) total += items.length;
      return total;
    },
    /** Pages visited per region, for the sweep report. */
    spentByRegion: () => Object.fromEntries(spent),
  };
}
