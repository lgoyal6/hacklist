// How many hackathons does a metro actually have?
//
// Written because the first answer to that question was wrong in three ways, and
// the plan for a second region was about to rest on it.
//
// It counted only Luma, which is an SF company whose home market adopted it
// first, so measuring hackathon density through Luma flatters San Francisco and
// says little about anywhere else. It mixed a Luma window of unknown length with
// MLH's nine-month season in the same column. And it undercounted everywhere,
// because a city page surfaces roughly one hackathon in nine: San Francisco's
// showed 6 where the full crawl finds 53.
//
// So this asks four independent sources over one fixed forward window, dedupes
// by name and date, and reports per source as well as combined, because the
// per-source split is the part that says whether a number is real or is just one
// platform's popularity in one city.
//
//   Luma       the city page, scrolled, since it renders its list client-side
//   Eventbrite its search page's JSON-LD, 20 events per query
//   Meetup     its search page's embedded state
//   Devpost    the public hackathon API, filtered by location text
//   MLH        the season pages, filtered by venue state
//
// Read-only and keyless. Nothing here writes to data/.
import { readFile } from "node:fs/promises";
import { lightpanda } from "@lightpanda/browser";
import { chromium } from "playwright-core";

import { buildPatterns, namesHackathonFormat } from "./lib/candidate-score.mjs";
import { createPacer, DEFAULT_UA } from "./lib/page-http.mjs";

const config = JSON.parse(
  await readFile(new URL("../config/discovery.json", import.meta.url), "utf8"),
);
const patterns = buildPatterns(config);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 60);
const now = Date.now();
const until = now + WINDOW_DAYS * 864e5;
const pace = createPacer(900);

/** Metros to compare. Each needs the slug or search term every source uses. */
const METROS = [
  { name: "Bay Area", luma: "sf", eventbrite: "ca--san-francisco", meetup: "us--ca--san%20francisco", states: ["California", "CA"], cities: ["san francisco", "oakland", "berkeley", "palo alto", "san jose", "santa clara", "sunnyvale", "mountain view", "pleasanton", "san ramon"] },
  { name: "New York", luma: "nyc", eventbrite: "ny--new-york", meetup: "us--ny--new%20york", states: ["New York", "NY"], cities: ["new york", "brooklyn", "queens", "manhattan"] },
  { name: "Los Angeles", luma: "la", eventbrite: "ca--los-angeles", meetup: "us--ca--los%20angeles", states: [], cities: ["los angeles", "santa monica", "pasadena", "irvine", "long beach", "burbank"] },
  { name: "San Diego", luma: "sd", eventbrite: "ca--san-diego", meetup: "us--ca--san%20diego", states: [], cities: ["san diego", "la jolla"] },
  { name: "Austin", luma: "austin", eventbrite: "tx--austin", meetup: "us--tx--austin", states: ["Texas", "TX"], cities: ["austin"] },
  { name: "Seattle", luma: "seattle", eventbrite: "wa--seattle", meetup: "us--wa--seattle", states: ["Washington", "WA"], cities: ["seattle", "bellevue", "redmond"] },
  { name: "Boston", luma: "boston", eventbrite: "ma--boston", meetup: "us--ma--boston", states: ["Massachusetts", "MA"], cities: ["boston", "cambridge"] },
];

const inWindow = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) && t >= now && t <= until;
};
const key = (name, iso) =>
  `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 28)}|${String(iso).slice(0, 10)}`;

async function getText(url, accept = "text/html") {
  await pace();
  const r = await fetch(url, {
    headers: { "user-agent": DEFAULT_UA, accept, "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const LD = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
function ldObjects(html) {
  const out = [];
  for (const [, block] of html.matchAll(LD)) {
    try {
      out.push(JSON.parse(block));
    } catch {
      // a page may carry more than one and only some parse
    }
  }
  return out;
}

// --- Eventbrite: its search page publishes an ItemList of 20 -----------------
async function eventbrite(metro) {
  const hits = [];
  try {
    const html = await getText(
      `https://www.eventbrite.com/d/${metro.eventbrite}/hackathon/`,
    );
    for (const obj of ldObjects(html)) {
      if (obj?.["@type"] !== "ItemList") continue;
      for (const entry of obj.itemListElement ?? []) {
        const e = entry.item ?? {};
        if (!e.name || !inWindow(e.startDate)) continue;
        if (!namesHackathonFormat(e.name, patterns)) continue;
        hits.push({ name: e.name, start: e.startDate });
      }
    }
  } catch {
    return null; // told apart from zero in the report
  }
  return hits;
}

// --- Meetup: its search page embeds the results ------------------------------
async function meetup(metro) {
  const hits = [];
  try {
    const html = await getText(
      `https://www.meetup.com/find/?keywords=hackathon&location=${metro.meetup}&source=EVENTS`,
    );
    for (const obj of ldObjects(html)) {
      for (const e of Array.isArray(obj) ? obj : [obj]) {
        if (e?.["@type"] !== "Event" || !e.name) continue;
        if (!inWindow(e.startDate)) continue;
        if (!namesHackathonFormat(e.name, patterns)) continue;
        hits.push({ name: e.name, start: e.startDate });
      }
    }
  } catch {
    return null;
  }
  return hits;
}

// --- Devpost: one global pull, bucketed by location text ---------------------
let devpostAll = null;
async function devpost(metro) {
  if (!devpostAll) {
    devpostAll = [];
    for (let page = 1; page <= 12; page += 1) {
      let data;
      try {
        data = JSON.parse(
          await getText(
            `https://devpost.com/api/hackathons?status[]=upcoming&status[]=open&challenge_type[]=in-person&order_by=recently-added&page=${page}`,
            "application/json",
          ),
        );
      } catch {
        break;
      }
      const batch = data.hackathons ?? [];
      if (!batch.length) break;
      devpostAll.push(...batch);
    }
  }
  const hits = [];
  for (const h of devpostAll) {
    const where = String(h.displayed_location?.location ?? "").toLowerCase();
    if (!metro.cities.some((c) => where.includes(c))) continue;
    // Devpost publishes a date range as text, so the window check is coarse.
    hits.push({ name: h.title, start: h.submission_period_dates });
  }
  return hits;
}

// --- MLH: the season pages, bucketed by venue state -------------------------
let mlhAll = null;
async function mlh(metro) {
  if (!mlhAll) {
    mlhAll = [];
    const year = new Date().getUTCFullYear();
    for (const season of [year, year + 1]) {
      let html;
      try {
        html = await getText(`https://www.mlh.com/seasons/${season}/events`);
      } catch {
        continue;
      }
      for (const [, block] of html.matchAll(
        /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
      )) {
        let parsed;
        try {
          parsed = JSON.parse(block);
        } catch {
          continue;
        }
        const walk = (v) => {
          if (Array.isArray(v)) return v.forEach(walk);
          if (!v || typeof v !== "object") return;
          if (v.formatType && v.startsAt && v.name) mlhAll.push(v);
          Object.values(v).forEach(walk);
        };
        walk(parsed);
      }
    }
  }
  const hits = [];
  for (const e of mlhAll) {
    if (!inWindow(e.startsAt)) continue;
    const venue = e.venueAddress ?? {};
    const city = String(venue.city ?? "").toLowerCase();
    const state = String(venue.state ?? "");
    const cityHit = metro.cities.some((c) => city.includes(c));
    const stateHit = metro.states.includes(state) && !metro.cities.length;
    if (!cityHit && !stateHit) continue;
    hits.push({ name: e.name, start: e.startsAt });
  }
  return hits;
}

// --- Luma: the city page, scrolled, since it renders its list client-side ----
const host = "127.0.0.1";
const port = 10_000 + Math.floor(Math.random() * 20_000);
const handle = await lightpanda.serve({ host, port });
async function connect(endpoint) {
  let last;
  for (let i = 0; i < 40; i += 1) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last;
}
const browser = await connect(`ws://${host}:${port}`);
const context = await browser.newContext();
const page = await context.newPage();

async function luma(metro) {
  try {
    await page.goto(`https://luma.com/${metro.luma}`, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
  } catch {
    // read whatever rendered
  }
  await page.waitForTimeout(1_500);
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
    await page.waitForTimeout(700);
  }
  let cards = [];
  try {
    cards = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")]
        .map((a) => ({
          title: a.getAttribute("aria-label") || (a.textContent || "").trim(),
          href: a.getAttribute("href") || "",
        }))
        .filter((c) => c.title.length > 6 && c.title.length < 140),
    );
  } catch {
    return null;
  }
  // A title alone has no date, so the ones that look like hackathons are
  // resolved individually. There are only ever a handful.
  const named = [...new Map(cards.map((c) => [c.title, c])).values()].filter((c) =>
    namesHackathonFormat(c.title, patterns),
  );
  const hits = [];
  for (const card of named.slice(0, 25)) {
    const slug = card.href.replace(/^\//, "").split("?")[0];
    if (!slug || slug.includes("/")) continue;
    try {
      const body = JSON.parse(
        await getText(`https://api.lu.ma/url?url=${encodeURIComponent(slug)}`, "application/json"),
      );
      const event = body?.data?.event;
      if (!event?.start_at || !inWindow(event.start_at)) continue;
      hits.push({ name: event.name, start: event.start_at });
    } catch {
      // an unresolvable slug is not a hackathon we can count
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
console.log(
  `Hackathons starting in the next ${WINDOW_DAYS} days, by metro and source.\n` +
    "A dash means the source failed rather than returned nothing.\n",
);
const header = ["metro", "luma", "evbrite", "meetup", "devpost", "mlh", "UNIQUE"];
console.log(
  `${header[0].padEnd(13)}${header.slice(1, 6).map((h) => h.padStart(9)).join("")}${header[6].padStart(9)}`,
);
const detail = [];
for (const metro of METROS) {
  const results = {
    luma: await luma(metro),
    evbrite: await eventbrite(metro),
    meetup: await meetup(metro),
    devpost: await devpost(metro),
    mlh: await mlh(metro),
  };
  const combined = new Map();
  for (const hits of Object.values(results)) {
    for (const hit of hits ?? []) combined.set(key(hit.name, hit.start), hit.name);
  }
  const cell = (v) => (v === null ? "-" : String(v.length));
  console.log(
    `${metro.name.padEnd(13)}` +
      [results.luma, results.evbrite, results.meetup, results.devpost, results.mlh]
        .map((v) => cell(v).padStart(9))
        .join("") +
      String(combined.size).padStart(9),
  );
  detail.push([metro.name, [...combined.values()]]);
}
console.log("\nnamed hackathons found, deduped:");
for (const [name, titles] of detail) {
  console.log(`  ${name}:`);
  for (const t of titles.slice(0, 8)) console.log(`     ${t.slice(0, 62)}`);
  if (!titles.length) console.log("     (none)");
}
try {
  await browser.close();
} catch {
  // closing is best effort
}
handle.kill?.();
process.exit(0);
