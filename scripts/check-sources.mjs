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
import { isMisconfiguration } from "./lib/source-health.mjs";

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
  // An event that ended after the sweep wrote the file is not a defect: the board
  // is a snapshot and events finish continuously. One run failed for a hackathon
  // that ended sixteen minutes after the sweep completed. The site and the feed
  // now filter those per request, so only an event the normalizer itself should
  // have dropped counts against the build.
  const writtenAt = Date.parse(board.meta?.sweepCompletedAt ?? "") || now;
  const past = events.filter(
    (event) => Date.parse(event.end ?? event.start ?? "") < writtenAt,
  );
  const endedSince = events.filter((event) => {
    const over = Date.parse(event.end ?? event.start ?? "");
    return over >= writtenAt && over < now;
  });
  if (endedSince.length) {
    notes.push(
      `board: ${endedSince.length} event(s) ended since the sweep, filtered at ` +
        "request time by the site and feed",
    );
  }
  if (past.length) {
    failures.push(
      `events.json contains ${past.length} event(s) that had already ended when ` +
        "it was written",
    );
  }
  const undated = events.filter((event) => !event.start);
  if (undated.length) warnings.push(`${undated.length} event(s) published without a start`);
  checkFreshness("events.json", board.meta?.sweepCompletedAt, { required: true });
  notes.push(`board: ${events.length} events, ${new Set(events.map((e) => e.organizer)).size} organizers`);
}

// --- the keyless API sources -----------------------------------------------
//
// Y Combinator and Devpost answer anyone from anywhere, so they have no excuse
// for returning nothing: an empty result means the endpoint changed shape or went
// away, which is exactly the failure the silent design would otherwise hide.
//
// Luma's discover feed is the exception and is treated more gently. Its rich
// pull is the one for wherever the caller is, so a datacenter run genuinely
// cannot refresh it — measured: ~890 events from a Bay Area address, 2 from a
// GitHub runner, both with a 200 and no error. The per-region place feeds it
// pulls alongside that one do answer from anywhere, and they are checked
// separately below, because a total the Bay Area dominates cannot say that a
// region went quiet.

const lumaApi = await readJson("data/luma-api.json");
if (lumaApi.__missing) {
  failures.push(`luma-api.json unreadable: ${lumaApi.__missing}`);
} else if (
  // Not "required": this feed is geolocated, so a run from a datacenter may not
  // be able to refresh it at all, and the board publishes perfectly well on a
  // slightly stale copy — it loses guest counts and registration state, not
  // events. Staleness warns; a changed endpoint shape below still fails.
  checkFreshness("luma-api", lumaApi.collectedAt, { required: false }) ||
  (lumaApi.uniqueEvents ?? 0) > 0
) {
  if ((lumaApi.uniqueEvents ?? 0) < 100) {
    failures.push(
      `luma-api: only ${lumaApi.uniqueEvents ?? 0} events from the discover feed (expected hundreds) — the endpoint or its shape changed`,
    );
  }
  if ((lumaApi.hackathonCandidates ?? 0) === 0) {
    failures.push("luma-api: zero hackathon candidates from a feed that normally has a dozen");
  }
  // A place feed that returns nothing at all is a wrong or retired place id
  // rather than a quiet week. San Diego's is small — single figures — but a
  // place that exists always answers with something.
  for (const feed of lumaApi.feeds ?? []) {
    if (!feed.region) continue; // the geolocated pull; its size is the caller's
    if ((feed.entries ?? 0) === 0) {
      warnings.push(
        `luma-api: the ${feed.region} place feed (${feed.placeId}) returned no ` +
          "events at all — check the place id against luma.com's city page",
      );
    }
  }
  notes.push(
    `luma-api: ${lumaApi.uniqueEvents} events, ${lumaApi.hackathonCandidates} hackathons, ${(lumaApi.calendarSeeds ?? []).length} calendar seeds` +
      (lumaApi.feeds ?? [])
        .filter((feed) => feed.region)
        .map((feed) => `, ${feed.region} ${feed.entries}`)
        .join(""),
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
  // Only failing at zero let a real collapse through: one run crawled 731 pages
  // and produced 8 candidates against 46 from the same code an hour earlier, and
  // the health check called it fine because 8 is not 0.
  //
  // A hard floor would cry wolf instead, because a low count is expected from a
  // datacenter: Luma's discover surfaces are geolocated, and CI legitimately
  // sees a fraction of what a Bay Area address does. So the floor applies only
  // when the feed was healthy, which is the case where a thin crawl means
  // something is broken rather than something is remote.
  const found = discovery.sweep?.candidatesFound ?? 0;
  const geolocatedOut = lumaApi.feedCollapsed === true;
  const candidateFloor = config.minSweepCandidates ?? 20;
  if (found > 0 && found < candidateFloor && !geolocatedOut) {
    failures.push(
      `sweep: ${found} candidate(s) from ${visited} pages, under the floor of ` +
        `${candidateFloor}, and the discover feed was healthy, so this is a ` +
        "crawl problem rather than a geolocation one",
    );
  } else if (found > 0 && found < candidateFloor) {
    warnings.push(
      `sweep: ${found} candidate(s) from ${visited} pages, expected from an ` +
        "address the discover feed does not serve; the board is carried by " +
        "retention and the keyless sources",
    );
  }
  // A throttled sweep is the quiet failure this file exists to catch: it exits
  // 0, writes a well-formed file, and reports a smaller board with no error. One
  // such run fell from 47 candidates to 17 while every counter looked fine.
  const throttled = discovery.sweep?.httpThrottled ?? 0;
  const budget = discovery.sweep?.pageBudget ?? 0;
  // Throttling only matters if it cost the sweep something. The crawl gives up
  // on the fast path once Luma refuses and finishes on the browser, so a run can
  // be throttled early and still get everywhere. Failing on the throttle alone
  // would cry wolf on exactly the runs the fallback handled correctly.
  // Not "did it stop on time" -- with the page cap above what fifteen minutes
  // affords, stopping on time is the normal, healthy outcome, and keying the
  // failure to it turned the best sweep yet (562 pages, 50 candidates) red.
  // What matters is whether throttling was absorbed. The crawl abandons the HTTP
  // path after a few refusals and finishes on the browser, so a run that gave up
  // early is fine; a run still being refused without having given up is
  // misconfigured, and a run well under its page budget lost real coverage.
  const gaveUp = (discovery.sweep?.httpPauses ?? 0) > 0;
  const collapsed = budget > 0 && visited < budget * 0.6;
  if (throttled > 0 && !gaveUp) {
    failures.push(
      `sweep: ${throttled} read(s) rate-limited and the HTTP path was never ` +
        "abandoned, so every refusal cost a wasted request and a pacing wait " +
        "on top of the browser read (check LUMA_HTTP_GIVE_UP_AFTER)",
    );
  } else if (collapsed) {
    failures.push(
      `sweep: only ${visited} of ${budget} pages visited, so coverage is ` +
        "degraded and the candidate count understates what is out there",
    );
  } else if (throttled > 0) {
    warnings.push(
      `sweep: ${throttled} read(s) rate-limited, absorbed by the browser ` +
        `fallback after ${visited} pages`,
    );
  }
  notes.push(
    `sweep: ${visited} pages, ${discovery.sweep?.candidatesFound ?? 0} candidates${discovery.sweep?.stoppedOnTimeBudget ? " (hit time budget)" : ""}`,
  );
}

// --- best-effort sources: mostly warn -------------------------------------
//
// Web search and LinkedIn depend on engines that block datacenter IPs, so in CI
// they are expected to come back empty. They are extras; the board does not rest
// on them. A warning is the right volume — enough to notice a long dry spell,
// not enough to cry wolf twice a day.
//
// With one exception, which is why this section was rewritten. Being blocked and
// being misconfigured produce the same visible result — no seeds — but only one
// of them ever fixes itself. This used to test `urls`, which is the CUMULATIVE
// tracked total and so is never empty once the source has ever worked, and it
// never read `problems` at all. So it printed "search: 24 seeds via brightdata"
// as a healthy note for four days while every single query came back
// 400 `"zone" is not allowed to be empty`. Read the problems, and say which kind
// they are.

/**
 * Judge one query-based seed pass from what it recorded.
 *
 * A 400 or 401 quotes the credential or the request body back at you: somebody
 * configured this and configured it wrong, and no amount of waiting helps. That
 * is a regression and it fails the run — after publishing, like everything here,
 * so a broken extra never withholds the board. A 403, a timeout or an empty
 * result is the engine refusing this address, which is the ordinary CI condition
 * and stays a warning.
 */
function reviewSeedPass(label, data, extra = "") {
  const problems = data.problems ?? [];
  const queriesRun = data.queriesRun ?? 0;
  const tracked = (data.urls ?? []).length;
  const describe = (problem) => String(problem?.error ?? problem).slice(0, 120);

  // Judge only what THIS sweep produced. These legs are metered, so the evening
  // sweep skips them on purpose (RUN_SEARCH_LEGS=false) and the pass exits
  // without touching its file — leaving a record of some earlier run on disk.
  // Reading that as current reports problems that may already be fixed, and did:
  // the first run after the Bright Data key was replaced went red over 401s from
  // the day before, while the leg that actually ran reported no problems at all.
  //
  // The window is generous because it only has to separate "written minutes ago
  // during this sweep" from "written on a previous run hours or days ago".
  const collectedAt = Date.parse(data.collectedAt ?? "");
  const sweptAt = Date.parse(board?.meta?.sweepCompletedAt ?? "");
  const STALE_WINDOW_MS = 2 * 3_600_000;
  const ranThisSweep =
    !Number.isFinite(collectedAt) ||
    !Number.isFinite(sweptAt) ||
    sweptAt - collectedAt < STALE_WINDOW_MS;

  if (!ranThisSweep) {
    const age = ((Date.now() - collectedAt) / 3_600_000).toFixed(0);
    notes.push(
      `${label}: not run this sweep — ${tracked} seeds from ${age}h ago stand` +
        `${problems.length ? `, with ${problems.length} problem(s) from that run` : ""}${extra}`,
    );
    return;
  }

  const misconfigured = problems.filter(isMisconfiguration);

  if (misconfigured.length) {
    failures.push(
      `${label}: ${misconfigured.length}/${queriesRun || problems.length} quer${
        (queriesRun || problems.length) === 1 ? "y" : "ies"
      } rejected as misconfigured rather than blocked — ${describe(misconfigured[0])}`,
    );
  } else if (queriesRun && problems.length >= queriesRun) {
    warnings.push(
      `${label}: all ${queriesRun} quer${queriesRun === 1 ? "y" : "ies"} failed — ${describe(problems[0])}`,
    );
  } else if (!tracked) {
    warnings.push(`${label}: no seeds tracked (engines block datacenter IPs; expected in CI)`);
  }

  notes.push(
    `${label}: ${tracked} seeds tracked, ${queriesRun} quer${queriesRun === 1 ? "y" : "ies"} run, ` +
      `${problems.length} problem(s)${extra}`,
  );
}

const search = await readJson("data/search-seeds.json");
if (!search.__missing) {
  reviewSeedPass("search", search, ` via ${search.provider ?? "?"}`);
}

const linkedin = await readJson("data/linkedin-seeds.json");
if (!linkedin.__missing) {
  reviewSeedPass("linkedin", linkedin, `, ${linkedin.pagesRead ?? 0} pages read`);
  if ((linkedin.paidSpendUsd ?? 0) > 0) {
    // The board is meant to cost nothing. If this fires, something re-enabled
    // paid search.
    warnings.push(`linkedin: spent $${linkedin.paidSpendUsd} — paid search should be off`);
  }
}

// --- is the published Luma calendar keeping up with the board? -------------
//
// The board and the Luma calendar are different products, and the calendar is
// the one people follow. It is filled by a local, browser-driven pass, so it
// always trails a little — but it can also trail permanently and silently:
// some events are declined on purpose. Luma's external-event form forces a clock
// time (no all-day option, and it substitutes 19:00 server-side even when the
// field is cleared), so a date-only source like Devpost cannot go on the calendar
// without asserting a time nobody stated. Those are reported as declined rather
// than pending, because they will never resolve on their own and counting them
// as work outstanding makes the number meaningless.
const ledger = await readJson("data/luma-ledger.json");
if (!ledger.__missing && !board.__missing) {
  const synced = new Set(
    Object.values(ledger.synced ?? {}).map((entry) => entry.url),
  );
  const events = board.events ?? [];
  const pending = events.filter((event) => !synced.has(event.url));
  // The same rule the sync applies, so this agrees with what it actually does.
  // Respects the override, or this reports declines the sync no longer makes.
  const declined =
    config.syncTimeUnknownExternals === true
      ? []
      : pending.filter(
          (event) =>
            event.platform !== "luma" &&
            (event.timeUnverified === true || !event.start),
        );
  const queued = pending.length - declined.length;
  notes.push(
    `luma calendar: ${events.length - pending.length}/${events.length} synced, ` +
      `${queued} queued` +
      (declined.length ? `, ${declined.length} declined (no stated start time)` : ""),
  );
  // Does the calendar show the times the board says? Presence is not correctness:
  // two entries went live seven hours off because Luma reads a typed time in the
  // browser's timezone and the runner was UTC. The sync verifies what it just
  // wrote; this catches anything already wrong, whenever it got that way.
  /**
   * Read the calendar, confirming a disagreement before believing it.
   *
   * Luma's feed is eventually consistent, and this runs immediately after the
   * mirror step has written to it — so a single read inside that window reports
   * entries that were just deleted or not yet updated. That produced a red run
   * with nothing wrong, and a gate that cries wolf is worse than no gate, because
   * the next real failure gets ignored. So a mismatch has to survive a second
   * read a few seconds later before it counts.
   */
  const readCalendar = async (calendarId) => {
    const response = await fetch(
      `https://api.lu.ma/calendar/get-items?calendar_api_id=${calendarId}&pagination_limit=100`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) return null;
    return response.json();
  };

  try {
    const calendarId = (ledger.calendar ?? "").match(/cal-[A-Za-z0-9]+/)?.[0];
    if (calendarId) {
      const body = await readCalendar(calendarId);
      if (body) {
        const key = (text) => String(text).replace(/[^a-z0-9]/gi, "").toLowerCase();
        // Only entries we typed the time into are ours to police. A Luma-hosted
        // event shows the organiser's own start, which we neither set nor can
        // change — and the board may legitimately differ from it, since a
        // duplicate merge can recover a better time from the organiser's own
        // page than the Luma listing carries. Those are not drift.
        const stored = new Map();
        for (const entry of body.entries ?? []) {
          const name = key(entry.event?.name ?? "");
          const isExternal = /^https?:/.test(entry.event?.url ?? "");
          if (name && isExternal) stored.set(name, entry.event?.start_at ?? null);
        }
        const wrong = [];
        for (const event of events) {
          if (!event.start) continue;
          let at = stored.get(key(event.title));
          if (!at) {
            for (const [name, value] of stored) {
              if (name.startsWith(key(event.title)) || key(event.title).startsWith(name)) {
                at = value;
                break;
              }
            }
          }
          if (!at) continue;
          if (Math.abs(Date.parse(at) - Date.parse(event.start)) >= 60_000) {
            wrong.push(
              `${event.title.slice(0, 40)} (calendar ${new Date(at).toLocaleString("en-US", { timeZone: config.timezone })}, board ${new Date(event.start).toLocaleString("en-US", { timeZone: config.timezone })})`,
            );
          }
        }
        if (wrong.length) {
          // Confirm against a second read before calling it a failure.
          await new Promise((r) => setTimeout(r, 6_000));
          const recheck = await readCalendar(calendarId).catch(() => null);
          if (recheck) {
            const still = new Map();
            for (const entry of recheck.entries ?? []) {
              const name = key(entry.event?.name ?? "");
              if (name && /^https?:/.test(entry.event?.url ?? "")) {
                still.set(name, entry.event?.start_at ?? null);
              }
            }
            const confirmed = wrong.filter((line) => {
              const event = events.find((candidate) =>
                line.startsWith(candidate.title.slice(0, 40)),
              );
              if (!event?.start) return false;
              let at = still.get(key(event.title));
              if (!at) {
                for (const [name, value] of still) {
                  if (name.startsWith(key(event.title)) || key(event.title).startsWith(name)) {
                    at = value;
                    break;
                  }
                }
              }
              // Gone from the calendar, or now agreeing: not a failure.
              return at && Math.abs(Date.parse(at) - Date.parse(event.start)) >= 60_000;
            });
            wrong.length = 0;
            wrong.push(...confirmed);
          }
        }
        if (wrong.length) {
          failures.push(
            `luma calendar: ${wrong.length} external entr${wrong.length === 1 ? "y" : "ies"} ` +
              "show a time we did not intend — Luma cannot edit an external event, " +
              `so these need deleting by hand and the next sync re-adds them: ${wrong.slice(0, 4).join("; ")}`,
          );
        }
      }
    }
  } catch {
    // The read-back is a check, not a dependency.
  }

  if (declined.length >= 5) {
    warnings.push(
      `luma calendar: ${declined.length} external event(s) declined for having no ` +
        "stated start time, which Luma's form would publish as 7pm. They are on " +
        "the site and the ICS feed, just not the Luma calendar; set " +
        "syncTimeUnknownExternals to add them with the title carrying the caveat",
    );
  }
  // Distinguish "trailing" from "stopped". The local pass runs twice a day, so a
  // large Luma-URL backlog means it has not run, not that it is slow.
  const autoPending = pending.filter(
    (event) => event.platform === "luma",
  ).length;
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
