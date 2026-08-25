// Applies tags to events on the HackList SF Luma calendar so visitors can
// filter there the way they can on the site.
//
// The tag set is deliberately small. Tags are only worth having if they answer a
// question someone actually asks, and they only work as a filter if each one
// meaningfully divides the calendar:
//
//   Hackathon    — the real thing
//   Tech Events  — summit, meetup, conference, build night: listed, not a hackathon
//   SF           — in the city
//   Bay Area     — everywhere else inside the radius
//
// A "Prizes" tag was here and has been removed: nearly every hackathon has
// prizes, so it split almost nothing while costing a chip people had to read
// past. The prize is still parsed and still shown on the board.
//
// Tags must exist before they can be applied. The "Add new tag" field in the
// per-event popover looks like it creates them but silently does not — verified
// four ways, including real pointer events. The working path is the Create
// button under Settings -> Tags -> Event Tags, so this script creates any
// missing tag there first and then applies it from the event rows.
//
// Usage: node scripts/luma-tag-events.mjs [--region san-diego] [--dry-run]
//        node scripts/luma-tag-events.mjs [--name "HackList SF"]
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultRegionKey, regionFor } from "./lib/candidate-score.mjs";
import { calendarApiId } from "./lib/luma-calendar-api.mjs";
import { readEvents, readLedger } from "./lib/luma-queue.mjs";
import {
  ensureSignedIn,
  launchLocalBrowser,
  needsHumanAttention,
  root,
} from "./lib/local-browser.mjs";

const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const headless = args.includes("--headless");
const regionArg = args[args.indexOf("--region") + 1];
const askedRegion =
  args.includes("--region") && regionArg && !regionArg.startsWith("--")
    ? regionArg
    : null;
if (askedRegion && !config.regions?.[askedRegion]) {
  console.error(
    `Unknown region "${askedRegion}". Configured: ${Object.keys(config.regions ?? {}).join(", ")}.`,
  );
  process.exit(1);
}
const defaultRegion = defaultRegionKey(config);
const region = regionFor(askedRegion ?? defaultRegion, config);
const nameArg = args[args.indexOf("--name") + 1];
const calendarName =
  args.includes("--name") && nameArg && !nameArg.startsWith("--")
    ? nameArg
    : region.lumaCalendarName ?? `Hacklist ${region.label}`;

/**
 * The tags a calendar row should carry.
 *
 * Format and area only. A "Prizes" tag used to be added whenever the prize text
 * mentioned a dollar amount, and it was dropped: nearly every hackathon has
 * prizes, so the tag divided the calendar almost not at all while adding a filter
 * people had to read past. The prize itself is still parsed and still shown on
 * the board — it is a useful detail, just not a useful axis to filter on.
 */
function desiredTags(event) {
  const tags = [event.category === "adjacent" ? "Tech Events" : "Hackathon"];
  // In the city, or the region at large. Named from the region rather than
  // hardcoded to SF, so the tag on a San Diego calendar says San Diego.
  const areaTag = event.area === region.coreArea ? region.coreArea : region.label;
  if (areaTag && !tags.includes(areaTag)) tags.push(areaTag);
  return tags;
}

const { events: allEvents } = await readEvents();
const events = allEvents.filter(
  (event) => (event.region ?? defaultRegion) === region.key,
);
const ledger = await readLedger(defaultRegion);
/**
 * Key an event the way its calendar row can be recognised: by Luma slug when it
 * has one, and by its title when it does not.
 *
 * External events — Devpost, Y Combinator, x.ai — have no Luma slug, and were
 * skipped outright here. That is why the calendar's own "Hackathon" tag counted
 * 19 while 34 hackathons were on it: the untagged remainder was every external
 * event, invisible to the tag filter people actually browse by.
 */
const titleKey = (title) =>
  `title:${String(title).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
function eventKey(event) {
  try {
    const url = new URL(event.url);
    if (url.hostname === "luma.com") {
      const slug = url.pathname.replace(/^\/+|\/+$/g, "");
      if (slug) return slug;
    }
  } catch {
    // fall through to the title
  }
  return event.title ? titleKey(event.title) : null;
}

const wanted = new Map(); // key -> {title, tags}
for (const event of events) {
  const key = eventKey(event);
  if (key) wanted.set(key, { title: event.title, tags: desiredTags(event) });
}

/**
 * The one admin URL shape that has settings pages under it.
 *
 * The ledger records whatever the sync resolved, which for a calendar added by
 * `--calendar https://luma.com/<slug>` is the slug URL. That shape has a working
 * manage view, so the sync is happy with it -- but `<slug>/manage/settings/tags`
 * does not 404, it silently renders the events page again, so the tag controls
 * are simply absent and every click here timed out with nothing to say about
 * why. Only `luma.com/calendar/manage/<cal_api_id>` carries the settings pages.
 */
const calendarId = await calendarApiId(ledger.calendars[region.key]);
const adminUrl = calendarId
  ? `https://luma.com/calendar/manage/${calendarId}`
  : (ledger.calendars[region.key]?.replace(/\/$/, "") ?? null);
if (!adminUrl) {
  console.error(
    `No calendar recorded yet for ${region.label}. Run \`npm run luma:sync -- ` +
      `--region ${region.key} --name "${calendarName}"\` first.`,
  );
  process.exit(1);
}

// Which (event, tag) pairs are already done is tracked here rather than read
// off the page. The row text cannot be trusted for this: an event titled
// "... Hackathon" contains the word "Hackathon" whether or not the tag is
// applied, so a text check reports every such event as already tagged.
const tagStatePath = resolve(root, "data/luma-tags.json");
let tagState = { applied: {} };
try {
  tagState = JSON.parse(await readFile(tagStatePath, "utf8"));
  tagState.applied ??= {};
} catch {
  // first run
}
// Failures are held only for this run. Recording them as applied would mean a
// transient problem permanently skips that tag, which is how six tags once went
// missing after the tag itself failed to be created.
const failedThisRun = new Set();
const isApplied = (slug, tag) =>
  (tagState.applied[slug] ?? []).includes(tag) ||
  failedThisRun.has(`${slug}|${tag}`);
// Progress within this run, kept apart from the persisted ledger. The loop
// re-reads the rows after every tag, and Luma does not repaint the new pill
// immediately, so without a run-local marker the same row is picked again.
const appliedThisRun = new Set();
const markApplied = (slug, tag) => {
  tagState.applied[slug] = [...new Set([...(tagState.applied[slug] ?? []), tag])];
  appliedThisRun.add(`${slug}|${tag}`);
};

/**
 * Which wanted event a calendar row belongs to. A Luma row is identified by its
 * permalink; an external row has none, so it is matched on its title appearing in
 * the row text. Requires a decent length so a short title cannot match several
 * rows at once.
 */
function resolveWanted(row) {
  if (row.slug && wanted.has(row.slug)) {
    return { ...wanted.get(row.slug), key: row.slug };
  }
  const rowKey = titleKey(row.rowText);
  let best = null;
  for (const [key, value] of wanted) {
    if (!key.startsWith("title:")) continue;
    const bare = key.slice("title:".length);
    if (bare.length >= 12 && rowKey.includes(bare)) {
      // Prefer the longest match, so one title that is a prefix of another does
      // not win over the more specific one.
      if (!best || bare.length > best.bare.length) best = { key, value, bare };
    }
  }
  return best ? { ...best.value, key: best.key } : null;
}

const context = await launchLocalBrowser({ headless });
let applied = 0;
let skipped = 0;
const problems = [];

/**
 * Describe each tag control on the page together with the event it belongs to.
 * Rows are matched by the event permalink inside them rather than by position,
 * because the list re-renders after every change.
 */
async function readRows(page) {
  return page.evaluate(() => {
    const rows = [];
    const buttons = [...document.querySelectorAll("button")].filter((button) => {
      const label = (button.innerText || button.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      const box = button.getBoundingClientRect();
      return /add tag/i.test(label) && box.width > 0 && box.height > 0;
    });
    buttons.forEach((button, index) => {
      // Walk up until an ancestor contains an event permalink.
      let node = button;
      let slug = null;
      for (let hops = 0; hops < 8 && node; hops++) {
        node = node.parentElement;
        if (!node) break;
        const anchor = [...node.querySelectorAll('a[href^="/"]')]
          .map((a) => a.getAttribute("href") ?? "")
          .find((href) => /^\/[a-z0-9][a-z0-9._-]{2,}$/i.test(href));
        if (anchor) {
          slug = anchor.replace(/^\//, "");
          break;
        }
      }
      const rowText = (node?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      // The tags already on this row, read from the pills rather than from
      // rowText: a title like "Zero Downtime Hackathon" contains a tag name and
      // a substring test would call it tagged when it is not.
      const tags = [...(node?.querySelectorAll(".pill-label") ?? [])]
        .map((pill) => (pill.innerText || "").replace(/\s+/g, " ").trim())
        .filter((name) => name && !/^add tag$/i.test(name));
      rows.push({ index, slug, rowText, tags });
    });
    return rows;
  });
}

/** Create any tag that does not exist yet, via the calendar's Tags settings. */
async function ensureTagsExist(page, names) {
  const settingsUrl = `${adminUrl}/settings/tags`;
  for (const name of names) {
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    // Parse the existing names exactly. A substring test is not good enough —
    // one tag's name containing another's reports the shorter as already created
    // and it never gets made. That bit us for real when the set included both
    // "Prizes" and "Cash Prizes".
    const existing = await page.evaluate(() => {
      const text = (document.body.innerText || "").replace(/\s+/g, " ");
      const start = text.search(/Event Tags/i);
      const end = text.search(/Member Tags/i);
      const block = start >= 0 ? text.slice(start, end > start ? end : start + 500) : "";
      return [...block.matchAll(/([A-Za-z][A-Za-z&'\- ]*?)\s+\d+\s+Events?\b/g)].map(
        (match) => match[1].trim(),
      );
    });
    if (existing.some((tag) => tag.toLowerCase() === name.toLowerCase())) continue;
    try {
      await page.getByRole("button", { name: "Create" }).first().click({ timeout: 6_000 });
      await page.waitForTimeout(2_000);
      await page.locator('input[name="name"]:visible, input:visible').first().fill(name);
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: /^(create|save|add)$/i }).last().click({ timeout: 6_000 });
      await page.waitForTimeout(2_500);
      console.log(`  created tag "${name}"`);
    } catch (error) {
      problems.push(`create tag ${name}: ${String(error).slice(0, 70)}`);
    }
  }
}

try {
  const page = await ensureSignedIn(context);
  if (!dryRun) {
    const allTags = [...new Set([...wanted.values()].flatMap((w) => w.tags))];
    await ensureTagsExist(page, allTags);
  }
  await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);

  // The list is virtualized, so only mounted rows can be tagged. Step down the
  // page and finish everything visible at each position before moving on.
  const stepCount = 24;
  for (let step = 0; step < stepCount; step++) {
    const attention = await needsHumanAttention(page);
    if (attention) {
      problems.push(`stopped: ${attention}`);
      break;
    }

    for (let inner = 0; inner < 12; inner++) {
      const rows = await readRows(page);
      const target = rows
        .map((row) => {
          const want = resolveWanted(row);
          if (!want) return null;
          // The row is the truth; the ledger is only a cache, and it was wrong
          // in both directions. A tag the ledger had forgotten is still on the
          // event, and Luma omits an applied tag from the picker — so retrying
          // one can never succeed: the picker offers only `Create "<name>"`, the
          // lookup falls through to another row's pill of the same name, and the
          // click times out. That is four events failing every run. Conversely a
          // tag the ledger claims is applied may be gone, because deleting and
          // re-adding an entry drops its tags while the record survives, and
          // trusting the ledger meant never putting them back.
          const onRow = new Set((row.tags ?? []).map((t) => t.toLowerCase()));
          for (const t of want.tags) {
            if (onRow.has(t.toLowerCase())) markApplied(want.key, t);
          }
          const tag = want.tags.find(
            (t) =>
              !onRow.has(t.toLowerCase()) &&
              !appliedThisRun.has(`${want.key}|${t}`) &&
              !failedThisRun.has(`${want.key}|${t}`),
          );
          return tag ? { row, tag, title: want.title, key: want.key } : null;
        })
        .find(Boolean);
      if (!target) break;

      if (dryRun) {
        console.log(`  would tag "${target.tag}" -> ${target.title.slice(0, 46)}`);
        markApplied(target.key, target.tag);
        continue;
      }

      try {
        await page
          .locator("button")
          .filter({ hasText: /Add Tag/i })
          .nth(target.row.index)
          .click({ timeout: 8_000 });
        await page.waitForTimeout(1_100);
        const field = page.getByPlaceholder(/add new tag/i).first();
        await field.fill(target.tag, { timeout: 6_000 });
        await page.waitForTimeout(1_000);

        // The typed name is only a filter. Committing means clicking the option
        // the dropdown offers — either the existing tag or `Create "<name>"`.
        // Pressing Enter just dismisses the popover and silently does nothing,
        // which is how an earlier version reported 56 successful tags while
        // applying none of them.
        // The tag already exists, so the dropdown lists it; click the leaf
        // element carrying the label, since the outer menu containers share the
        // same text and clicking those does nothing.
        const clicked = await page.evaluate((label) => {
          const norm = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
          const hits = [...document.querySelectorAll("*")].filter(
            (el) => norm(el) === label,
          );
          const leaf = hits
            .filter((el) => ![...el.querySelectorAll("*")].some((c) => norm(c) === label))
            .pop();
          if (!leaf) return false;
          leaf.setAttribute("data-hl-tag", "1");
          return true;
        }, target.tag);
        if (!clicked) throw new Error(`option "${target.tag}" not offered`);
        await page.click('[data-hl-tag="1"]', { timeout: 6_000 });
        await page.waitForTimeout(2_000);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(900);
        markApplied(target.key, target.tag);
        applied += 1;
        console.log(`  tagged "${target.tag}" -> ${target.title.slice(0, 46)}`);
      } catch (error) {
        problems.push(
          `${target.title.slice(0, 28)} / ${target.tag}: ${String(error).slice(0, 80)}`,
        );
        skipped += 1;
        failedThisRun.add(`${target.key}|${target.tag}`); // retry next run
        await page.keyboard.press("Escape").catch(() => {});
      }
    }

    const atEnd = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, window.innerHeight * 0.7);
      return window.scrollY === before;
    });
    await page.waitForTimeout(700);
    if (atEnd) break;
  }
} finally {
  await context.close();
  if (!dryRun) {
    await writeFile(tagStatePath, `${JSON.stringify(tagState, null, 2)}\n`);
  }
}

console.log(
  `\nTagging: ${applied} applied, ${skipped} failed.` +
    (problems.length ? `\nProblems:\n  ${problems.join("\n  ")}` : ""),
);
