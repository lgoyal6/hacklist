// Applies tags to events on the HackList SF Luma calendar so visitors can
// filter there the way they can on the site.
//
// The tag set is deliberately small. Tags are only worth having if they answer
// a question someone actually asks, and five chips is already the limit of what
// reads as a filter rather than as noise:
//
//   Hackathon    — the real thing
//   Tech Events  — summit, meetup, conference, build night: listed, not a hackathon
//   SF           — in the city
//   Bay Area     — everywhere else inside the radius
//   Prizes       — a prize pool with a figure attached
//
// Deliberately "Prizes" and not "Cash Prizes": of the six events that qualify,
// only three actually say cash. One is "$5k in OpenAI Credits" and two just say
// "prizes", so the stronger label would have been wrong on half of them.
//
// Tags must exist before they can be applied. The "Add new tag" field in the
// per-event popover looks like it creates them but silently does not — verified
// four ways, including real pointer events. The working path is the Create
// button under Settings -> Tags -> Event Tags, so this script creates any
// missing tag there first and then applies it from the event rows.
//
// Usage: node scripts/luma-tag-events.mjs [--name "HackList SF"] [--dry-run]
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readEvents, readLedger } from "./lib/luma-queue.mjs";
import {
  ensureSignedIn,
  launchLocalBrowser,
  needsHumanAttention,
  root,
} from "./lib/local-browser.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const headless = args.includes("--headless");
const nameArg = args[args.indexOf("--name") + 1];
const calendarName =
  args.includes("--name") && nameArg && !nameArg.startsWith("--")
    ? nameArg
    : "HackList SF";

function desiredTags(event) {
  const tags = [event.category === "adjacent" ? "Tech Events" : "Hackathon"];
  tags.push(event.area === "SF" ? "SF" : "Bay Area");
  if (/\$/.test(event.prize ?? "")) tags.push("Prizes");
  return tags;
}

const { events } = await readEvents();
const ledger = await readLedger();
const wanted = new Map(); // slug -> {title, tags}
for (const event of events) {
  try {
    const url = new URL(event.url);
    if (url.hostname !== "luma.com") continue;
    const slug = url.pathname.replace(/^\/+|\/+$/g, "");
    if (slug) wanted.set(slug, { title: event.title, tags: desiredTags(event) });
  } catch {
    // skip unparseable
  }
}

const adminUrl = ledger.calendar
  ? `${ledger.calendar.replace(/\/$/, "")}`
  : null;
if (!adminUrl) {
  console.error(
    "No calendar recorded yet. Run `npm run luma:sync -- --name \"" +
      calendarName +
      '"` first.',
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
// transient problem permanently skips that tag, which is how six "Prizes" tags
// went missing after the tag itself failed to be created.
const failedThisRun = new Set();
const isApplied = (slug, tag) =>
  (tagState.applied[slug] ?? []).includes(tag) ||
  failedThisRun.has(`${slug}|${tag}`);
const markApplied = (slug, tag) => {
  tagState.applied[slug] = [...new Set([...(tagState.applied[slug] ?? []), tag])];
};

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
      rows.push({
        index,
        slug,
        rowText: (node?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      });
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
    // Parse the existing names exactly. A substring test is not good enough:
    // "Cash Prizes" contains "Prizes", so checking for the latter reported it as
    // already created and the tag was never made.
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
          const want = row.slug ? wanted.get(row.slug) : null;
          if (!want) return null;
          const tag = want.tags.find((t) => !isApplied(row.slug, t));
          return tag ? { row, tag, title: want.title } : null;
        })
        .find(Boolean);
      if (!target) break;

      if (dryRun) {
        console.log(`  would tag "${target.tag}" -> ${target.title.slice(0, 46)}`);
        markApplied(target.row.slug, target.tag);
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
        markApplied(target.row.slug, target.tag);
        applied += 1;
        console.log(`  tagged "${target.tag}" -> ${target.title.slice(0, 46)}`);
      } catch (error) {
        problems.push(
          `${target.title.slice(0, 28)} / ${target.tag}: ${String(error).slice(0, 80)}`,
        );
        skipped += 1;
        failedThisRun.add(`${target.row.slug}|${target.tag}`); // retry next run
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
