// A seeded, synthetic event log, so the pipeline can be exercised at zero traffic.
//
// READ THIS BEFORE QUOTING ANY NUMBER PRODUCED FROM IT.
//
// Every row this writes is tagged source=synthetic. Nothing here is a
// measurement of how anybody uses the board, and no number computed from it is
// evidence that the ranker is better than the board's ordering. What it is for
// is the other half of the work: proving that the trainer, the interleaving,
// the leakage detector, the split, the metrics, the bootstrap and the controls
// all run, agree with each other, and fail when they should.
//
// The simulation is also rigged in the ranker's favour, on purpose, and the
// rigging is worth naming so nobody mistakes the result for a finding:
//
//   1. The synthetic reader's taste is a LINEAR function of the same features
//      the ranker gets. A linear model can therefore recover it almost exactly.
//      Real preference is not linear in fifteen numbers a scraper produced.
//   2. Examination falls as 1/rank, which is exactly the propensity the
//      trainer's inverse-propensity weighting assumes. In the synthetic world
//      that assumption is true by construction. In the real world it is
//      borrowed and unverified.
//   3. There is no unobserved confounder, no seasonality, no novelty effect and
//      no reason anybody clicks other than the utility written below.
//
// So: a candidate that beats production here has demonstrated that the code
// path works. A candidate that FAILED to beat production here would have
// demonstrated a bug. That asymmetry is the whole value of the fixture.
//
// Run: node scripts/recommender-synthesize-events.mjs
// Options: --seed N --days N --people N --depth N --out PATH

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import {
  boardVisible,
  candidateOrder,
  draftSeed,
  extractFeatures,
  mulberry32,
  positionWeight,
  teamDraftInterleave,
  trainLogistic,
} from "../app/ranking.mjs";
import { validateEvent } from "../app/telemetry-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = "tests/fixtures/recommender-synthetic-events.jsonl";

/** The fixture's own version string, so a row says which simulation made it. */
export const SYNTHETIC_MODEL_VERSION = "syn-1";

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  const raw = process.argv[index + 1];
  const asNumber = Number(raw);
  return Number.isFinite(asNumber) && raw.trim() !== "" ? asNumber : raw;
};

/**
 * How much of the list a synthetic session reports.
 *
 * The real board reports every rendered row, all sixty-nine of them. The
 * fixture reports the first twenty because it is committed to the repository
 * and sixty-nine rows per session runs to megabytes. Every metric here is @5 or
 * @10 and the position weight caps at rank 10, so nothing measured reaches past
 * this depth; it is a file-size choice and not a modelling one.
 */
const DEFAULT_DEPTH = 20;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A 22-character id shaped like the ones the browser mints, from the seeded rng. */
function fakeId(rng) {
  let out = "";
  for (let i = 0; i < 22; i += 1) {
    out += BASE64URL[Math.floor(rng() * BASE64URL.length)];
  }
  return out;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * One synthetic person's taste: what they actually want, which the ranker never
 * sees. Drawn from the seeded rng so the whole fixture is a function of --seed.
 */
function makeTaste(rng) {
  return {
    prize: 0.4 + rng() * 1.6,
    soon: 0.6 + rng() * 1.4,
    luma: -0.4 + rng() * 1.2,
    builder: 0.5 + rng() * 1.5,
    open: rng() * 1.0,
    // Everyone is a bit less likely to click than the features suggest: most
    // impressions are not clicks, in any world.
    floor: -3.4 - rng() * 0.8,
  };
}

/** The utility the simulated reader assigns an event, which no feature reads. */
function utility(taste, event, asOf) {
  const features = extractFeatures(event, {
    asOf,
    regionKey: "bay-area",
    defaultRegion: "bay-area",
  });
  const [
    ,
    builderValue,
    ,
    ,
    ,
    ,
    isLuma,
    daysUntilStart,
    ,
    hasPrize,
    ,
    ,
    statusOpen,
  ] = features;
  return (
    taste.floor +
    taste.prize * hasPrize +
    taste.soon * (1 - daysUntilStart) +
    taste.luma * isLuma +
    taste.builder * builderValue +
    taste.open * statusOpen
  );
}

/** Examination probability by rank: the 1/rank curve the trainer assumes. */
const examination = (position) => 1 / (position + 1);

export async function synthesize(options = {}) {
  const {
    seed = 20260909,
    days = 14,
    people = 26,
    depth = DEFAULT_DEPTH,
  } = options;

  const data = JSON.parse(
    await readFile(resolve(root, "data/events.json"), "utf8"),
  );
  const defaultRegion = data.meta.defaultRegion;
  const region =
    data.meta.regions.find((entry) => entry.key === defaultRegion) ??
    data.meta.regions[0];
  const sweep = Date.parse(data.meta.sweepCompletedAt);
  // The window ends at the sweep that produced the committed board, so every
  // event in it was genuinely upcoming for the whole simulated fortnight, the
  // visible set does not change under the reader's feet, and no row is dated in
  // the future.
  const dayZero = sweep - days * 86400000;

  const rng = mulberry32(seed);

  /**
   * A synthetic person, and their client id, which rotates on day 7 exactly as
   * a real one does. The evaluator groups by client id, not by person, so this
   * is also how the fixture exercises the honest limitation: a fortnight of one
   * reader looks like two readers, and it is supposed to.
   */
  const population = [];
  for (let i = 0; i < people; i += 1) {
    population.push({
      taste: makeTaste(rng),
      ids: [fakeId(rng), fakeId(rng)],
      visitRate: 0.35 + rng() * 0.4,
      locale: rng() < 0.2 ? "es" : "en",
      viewport: rng() < 0.4 ? "narrow" : "wide",
    });
  }

  const rows = [];
  /** Renders whose labels are known, for the mid-run training in phase B. */
  const trainingRows = [];
  /** The day the simulation starts drafting: half the window on production alone. */
  const draftFromDay = Math.floor(days / 2);
  let model = null;

  for (let day = 0; day < days; day += 1) {
    // At the start of each drafting day, retrain on everything logged so far.
    // The real trainer does the same thing from the same function, so what the
    // fixture drafts against is a real model of the fixture's own history.
    if (day >= draftFromDay && trainingRows.length >= 200) {
      const trained = trainLogistic(trainingRows);
      model = {
        modelVersion: SYNTHETIC_MODEL_VERSION,
        weights: trained.weights,
        bias: trained.bias,
      };
    }

    for (const person of population) {
      if (rng() >= person.visitRate) continue;
      // Some hour of the day, in the middle of it, so a session never straddles
      // the UTC midnight the split rolls over on.
      const sessionStart =
        dayZero + day * 86400000 + Math.floor(4 * 3600000 + rng() * 14 * 3600000);
      const clientId = person.ids[day < 7 ? 0 : 1];
      const sessionId = fakeId(rng);

      const visible = boardVisible(data.events, {
        regionKey: region.key,
        coreArea: region.coreArea,
        defaultRegion,
        view: "hackathons",
        query: "",
        asOf: sessionStart,
      });
      if (visible.length === 0) continue;

      const context = {
        asOf: sessionStart,
        regionKey: region.key,
        defaultRegion,
      };
      let listed;
      if (model) {
        const candidate = candidateOrder(visible, model, context);
        listed = teamDraftInterleave(
          visible,
          candidate,
          draftSeed(clientId, new Date(sessionStart).toISOString().slice(0, 10)),
        );
      } else {
        listed = visible.map((event) => ({ event, team: "production" }));
      }

      const shown = listed.slice(0, depth);
      const impressionTs = sessionStart;
      const renderRows = [];
      for (let position = 0; position < shown.length; position += 1) {
        const { event, team } = shown[position];
        renderRows.push({
          type: "impression",
          ts: impressionTs + position,
          client_id: clientId,
          session_id: sessionId,
          locale: person.locale,
          event_id: event.id,
          position,
          ranking: team,
          model_version: model ? model.modelVersion : null,
          viewport: person.viewport,
          source: "synthetic",
        });
      }

      // Clicks: examined with probability 1/rank, then clicked on utility.
      const clicked = new Set();
      for (let position = 0; position < shown.length; position += 1) {
        const { event, team } = shown[position];
        const chance =
          examination(position) *
          sigmoid(utility(person.taste, event, impressionTs));
        if (rng() >= chance) continue;
        clicked.add(event.id);
        renderRows.push({
          type: "click",
          ts: impressionTs + depth + 1000 + position * 37,
          client_id: clientId,
          session_id: sessionId,
          locale: person.locale,
          event_id: event.id,
          position,
          ranking: team,
          model_version: model ? model.modelVersion : null,
          viewport: person.viewport,
          source: "synthetic",
        });
      }

      // A reader who found something is likelier to subscribe to the feed.
      if (rng() < (clicked.size > 0 ? 0.16 : 0.03)) {
        renderRows.push({
          type: "save",
          ts: impressionTs + depth + 6000,
          client_id: clientId,
          session_id: sessionId,
          locale: person.locale,
          event_id: "__feed__",
          position: 0,
          ranking: "none",
          model_version: model ? model.modelVersion : null,
          viewport: person.viewport,
          source: "synthetic",
        });
      }

      rows.push(...renderRows);

      for (let position = 0; position < shown.length; position += 1) {
        const { event } = shown[position];
        trainingRows.push({
          features: extractFeatures(event, context),
          label: clicked.has(event.id) ? 1 : 0,
          weight: positionWeight(position),
        });
      }
    }
  }

  // Every row must be exactly what the Worker would have accepted. A fixture
  // that could not have been logged is a fixture that proves nothing about the
  // thing that logs.
  for (const row of rows) {
    const result = validateEvent(row, { checkClock: false });
    if (!result.ok) {
      throw new Error(`the synthesizer produced an invalid row: ${result.reason}`);
    }
  }

  rows.sort((a, b) => a.ts - b.ts);
  return {
    rows,
    summary: {
      seed,
      days,
      people,
      depth,
      client_ids: new Set(rows.map((row) => row.client_id)).size,
      impressions: rows.filter((row) => row.type === "impression").length,
      clicks: rows.filter((row) => row.type === "click").length,
      saves: rows.filter((row) => row.type === "save").length,
      interleaved_from_day: draftFromDay,
      window: [
        new Date(rows[0].ts).toISOString(),
        new Date(rows[rows.length - 1].ts).toISOString(),
      ],
    },
  };
}

async function main() {
  const out = resolve(root, String(argOf("out", DEFAULT_OUT)));
  const { rows, summary } = await synthesize({
    seed: argOf("seed", 20260909),
    days: argOf("days", 14),
    people: argOf("people", 26),
    depth: argOf("depth", DEFAULT_DEPTH),
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(`Wrote ${rows.length} synthetic rows to ${out}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "Every row is tagged source=synthetic. No number computed from this file is a measurement of the board.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
