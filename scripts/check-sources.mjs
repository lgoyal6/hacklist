// Source health gate.
//
// Every discovery pass is deliberately built never to fail: a throttled search
// or a dead API writes an empty file and exits 0, because a partial sweep beats
// no sweep. The cost of that design is silence — a source can stop working and
// the pipeline keeps publishing yesterday's answer with no signal at all. That
// happened: web search returned nothing on every query for an unknown number of
// runs and nobody found out, because nothing was watching.
//
// This is the thing that watches. It reads what each pass wrote and complains
// when the shape of the output says the source is broken rather than merely
// quiet. It runs *after* publishing, so a broken source never blocks the board
// from updating — it just turns the run red so it is visible.
//
// Exit codes:
//   0  everything within expectations (warnings may still be printed)
//   1  at least one source failed a hard expectation
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/discovery.json"), "utf8"),
);

const failures = [];
const warnings = [];
const notes = [];

async function readJson(file) {
  try {
    return JSON.parse(await readFile(resolve(root, file), "utf8"));
  } catch (error) {
    return { __missing: String(error).slice(0, 120) };
  }
}

/** Age of a timestamp in hours, or null when unparseable. */
function ageHours(timestamp) {
  const parsed = Date.parse(timestamp ?? "");
  if (!Number.isFinite(parsed)) return null;
  return (Date.now() - parsed) / 3_600_000;
}

// The schedule runs every 12 hours; anything older than a day and a half means
// the pass stopped running, not that it found nothing.
const STALE_HOURS = Number(process.env.SOURCE_STALE_HOURS ?? 36);

function checkFreshness(label, timestamp, { required }) {
  const age = ageHours(timestamp);
  if (age === null) {
    (required ? failures : warnings).push(`${label}: no usable collectedAt`);
    return false;
  }
  if (age > STALE_HOURS) {
    (required ? failures : warnings).push(
      `${label}: last collected ${age.toFixed(0)}h ago (limit ${STALE_HOURS}h) — the pass is not running`,
    );
    return false;
  }
  return true;
}

// --- the board itself: the only truly non-negotiable output ----------------

const board = await readJson("data/events.json");
if (board.__missing) {
  failures.push(`events.json unreadable: ${board.__missing}`);
} else {
  const events = board.events ?? [];
  const minimum = Number(process.env.MIN_PUBLISHED_EVENTS ?? config.minPublishedEvents ?? 12);
  if (events.length < minimum) {
    failures.push(
      `events.json publishes ${events.length} event(s), below the floor of ${minimum} — a source regression, not a quiet week`,
    );
  }
  const now = Date.now();
  const past = events.filter(
    (event) => Date.parse(event.end ?? event.start ?? "") < now,
  );
  if (past.length) {
    failures.push(`events.json contains ${past.length} event(s) that already ended`);
  }
  const undated = events.filter((event) => !event.start);
  if (undated.length) warnings.push(`${undated.length} event(s) published without a start`);
  checkFreshness("events.json", board.meta?.sweepCompletedAt, { required: true });
  notes.push(`board: ${events.length} events, ${new Set(events.map((e) => e.organizer)).size} organizers`);
}

// --- required sources: keyless APIs that work from any IP ------------------
//
// These have no excuse for returning nothing. They need no key, no session and
// no residential IP, so an empty result means the endpoint changed shape or went
// away — exactly the failure the silent design would otherwise hide.

const lumaApi = await readJson("data/luma-api.json");
if (lumaApi.__missing) {
  failures.push(`luma-api.json unreadable: ${lumaApi.__missing}`);
} else if (checkFreshness("luma-api", lumaApi.collectedAt, { required: true })) {
  if ((lumaApi.uniqueEvents ?? 0) < 100) {
    failures.push(
      `luma-api: only ${lumaApi.uniqueEvents ?? 0} events from the discover feed (expected hundreds) — the endpoint or its shape changed`,
    );
  }
  if ((lumaApi.hackathonCandidates ?? 0) === 0) {
    failures.push("luma-api: zero hackathon candidates from a feed that normally has a dozen");
  }
  notes.push(
    `luma-api: ${lumaApi.uniqueEvents} events, ${lumaApi.hackathonCandidates} hackathons, ${(lumaApi.calendarSeeds ?? []).length} calendar seeds`,
  );
}

const yc = await readJson("data/yc-candidates.json");
if (yc.__missing) {
  failures.push(`yc-candidates.json unreadable: ${yc.__missing}`);
} else if (checkFreshness("yc", yc.collectedAt, { required: true })) {
  // YC genuinely has quiet weeks, so an empty index is a warning, not a failure —
  // it is the difference between "nothing on" and "we can no longer read the
  // page". Only the latter is a bug, and it shows up as a problem on the index
  // stage: the Inertia props moved, or the fetch never landed.
  const indexBroke = (yc.problems ?? []).some(
    (problem) => problem.stage === "index",
  );
  if (indexBroke) {
    failures.push(
      `yc: could not read the events index (${yc.problems.find((p) => p.stage === "index").error}) — data-page props may have moved`,
    );
  } else if ((yc.listed ?? 0) === 0) {
    warnings.push("yc: events index read fine but listed nothing upcoming");
  }
  notes.push(`yc: ${yc.listed} listed, ${yc.candidates?.length ?? 0} candidates`);
}

const devpost = await readJson("data/devpost-candidates.json");
if (devpost.__missing) {
  failures.push(`devpost-candidates.json unreadable: ${devpost.__missing}`);
} else if (checkFreshness("devpost", devpost.collectedAt, { required: true })) {
  if ((devpost.seen ?? 0) === 0) {
    failures.push("devpost: the hackathons API returned nothing — endpoint or filters changed");
  }
  notes.push(`devpost: ${devpost.seen} seen, ${devpost.candidates?.length ?? 0} local candidates`);
}

// --- the headless sweep ----------------------------------------------------

const discovery = await readJson("data/discovery-output.json");
if (discovery.__missing) {
  failures.push(`discovery-output.json unreadable: ${discovery.__missing}`);
} else if (checkFreshness("sweep", discovery.sweep?.completedAt, { required: true })) {
  const visited = discovery.sweep?.pagesVisited ?? 0;
  if (visited < 25) {
    failures.push(`sweep: only ${visited} page(s) visited — the browser is failing, not the sites`);
  }
  if ((discovery.sweep?.candidatesFound ?? 0) === 0) {
    failures.push("sweep: zero candidates from a full crawl");
  }
  notes.push(
    `sweep: ${visited} pages, ${discovery.sweep?.candidatesFound ?? 0} candidates${discovery.sweep?.stoppedOnTimeBudget ? " (hit time budget)" : ""}`,
  );
}

// --- best-effort sources: warn, never fail ---------------------------------
//
// Web search and LinkedIn depend on engines that block datacenter IPs, so in CI
// they are expected to come back empty. They are extras; the board does not rest
// on them. A warning is the right volume — enough to notice a long dry spell,
// not enough to cry wolf twice a day.

const search = await readJson("data/search-seeds.json");
if (!search.__missing) {
  const urls = search.urls ?? [];
  if (!urls.length) warnings.push("search: no seeds tracked (engines block datacenter IPs; expected in CI)");
  notes.push(`search: ${urls.length} seeds via ${search.provider ?? "?"}`);
}

const linkedin = await readJson("data/linkedin-seeds.json");
if (!linkedin.__missing) {
  const urls = linkedin.urls ?? [];
  if (!urls.length) warnings.push("linkedin: no seeds tracked");
  if ((linkedin.paidSpendUsd ?? 0) > 0) {
    // The board is meant to cost nothing. If this fires, something re-enabled
    // paid search.
    warnings.push(`linkedin: spent $${linkedin.paidSpendUsd} — paid search should be off`);
  }
  notes.push(`linkedin: ${urls.length} seeds, ${linkedin.pagesRead ?? 0} pages read, $${linkedin.paidSpendUsd ?? 0}`);
}

// --- is the published Luma calendar keeping up with the board? -------------
//
// The board and the Luma calendar are different products, and the calendar is
// the one people follow. It is filled by a local, browser-driven pass, so it
// always trails a little — but it can also trail permanently and silently:
// external events (Devpost, Y Combinator, x.ai) cannot be added by the current
// automation at all, and that share grew when those sources were added. Worth
// reporting every run rather than discovering it by counting rows by hand.
const ledger = await readJson("data/luma-ledger.json");
if (!ledger.__missing && !board.__missing) {
  const synced = new Set(
    Object.values(ledger.synced ?? {}).map((entry) => entry.url),
  );
  const events = board.events ?? [];
  const pending = events.filter((event) => !synced.has(event.url));
  const manual = pending.filter((event) => event.platform !== "luma");
  notes.push(
    `luma calendar: ${events.length - pending.length}/${events.length} synced, ` +
      `${pending.length} pending (${manual.length} need the external-event form by hand)`,
  );
  if (manual.length >= 5) {
    warnings.push(
      `luma calendar: ${manual.length} external event(s) can never be synced automatically — ` +
        "the sync only handles Luma URLs (npm run luma:queue lists them)",
    );
  }
  // Distinguish "trailing" from "stopped". The local pass runs twice a day, so a
  // large Luma-URL backlog means it has not run, not that it is slow.
  const autoPending = pending.length - manual.length;
  if (autoPending >= 10) {
    warnings.push(
      `luma calendar: ${autoPending} Luma event(s) queued but not synced — the local pass may not be running`,
    );
  }
}

// --- report ---------------------------------------------------------------

for (const note of notes) console.log(`  ${note}`);
for (const warning of warnings) console.warn(`  WARN  ${warning}`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);

if (failures.length) {
  console.error(
    `\nSource health: ${failures.length} failure(s), ${warnings.length} warning(s).\n` +
      "The board has already been published — this run is red so the regression " +
      "is visible, not to stop the update.",
  );
  process.exit(1);
}
console.log(
  `\nSource health: OK${warnings.length ? ` with ${warnings.length} warning(s)` : ""}.`,
);
