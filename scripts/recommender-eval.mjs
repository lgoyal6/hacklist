// Does the learned ordering beat the board's, and is the answer trustworthy?
//
// The second half of that question is the reason this file is long. An offline
// ranking win is the easiest number in software to produce by accident, so the
// evaluation is built to catch itself: a leakage detector that perturbs the
// inputs a feature is not allowed to read and alarms the one door into future
// engagement, a prequential split that never evaluates a day it trained on, a
// shuffled-label control that must fail, a cold-start and a missing-artifact
// check that must both fall back to exactly the frozen production ordering, and
// bootstrap intervals resampled by client rather than by row.
//
// The thresholds are not here. They are in results/recommender-manifest.json,
// committed before any of this existed, and read back at runtime. A gate chosen
// after seeing the result is not a gate.
//
// Run: npm run recommender:eval
// Options: --log PATH --artifact PATH --control MODE --out-dir DIR --no-write
// Controls: leak-future, shuffle-labels, cold-start, missing-artifact

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_NAMES,
  RANKING_TIME_EVENT_FIELDS,
  boardVisible,
  candidateOrder,
  extractFeatures,
  mulberry32,
  positionWeight,
  rankedList,
  trainLogistic,
  validateModel,
} from "../app/ranking.mjs";
import { ORGANIC_SOURCE } from "../app/telemetry-schema.mjs";
import {
  dayKey,
  engagementIndex,
  groupRenders,
  productionExtractor,
  readEventLog,
} from "./lib/recommender-log.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOG = "tests/fixtures/recommender-synthetic-events.jsonl";
const DEFAULT_ARTIFACT = "data/ranker.json";

/** The seed for the random baseline, fixed here as the manifest says it is. */
const RANDOM_SEED = 20260909;
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 4242;
/** How far ahead the leaking control reaches, which is the whole point of it. */
const LEAK_WINDOW_MS = 7 * 86400000;

export const CONTROLS = Object.freeze([
  "leak-future",
  "shuffle-labels",
  "cold-start",
  "missing-artifact",
]);

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
};

// --- metrics ---

const discount = (rank) => 1 / Math.log2(rank + 2);

/**
 * Binary-relevance NDCG at k.
 *
 * Null when the render produced no click. A render nobody clicked in says
 * nothing about which ordering is better, and averaging a zero for it would
 * quietly reward whichever ordering appeared in the quietest renders.
 */
function ndcg(orderIds, relevant, k) {
  if (relevant.size === 0) return null;
  let gain = 0;
  for (let i = 0; i < Math.min(k, orderIds.length); i += 1) {
    if (relevant.has(orderIds[i])) gain += discount(i);
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i += 1) ideal += discount(i);
  return ideal === 0 ? null : gain / ideal;
}

function mrr(orderIds, relevant) {
  if (relevant.size === 0) return null;
  for (let i = 0; i < orderIds.length; i += 1) {
    if (relevant.has(orderIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function recallAt(orderIds, relevant, k) {
  if (relevant.size === 0) return null;
  let found = 0;
  for (let i = 0; i < Math.min(k, orderIds.length); i += 1) {
    if (relevant.has(orderIds[i])) found += 1;
  }
  return found / relevant.size;
}

const mean = (values) => {
  const usable = values.filter((value) => value !== null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
};

const round = (value, places = 4) =>
  value === null || value === undefined ? null : Number(value.toFixed(places));

/**
 * Percentile bootstrap, resampled by client.
 *
 * By client and not by render, because two renders from one reader are not two
 * independent observations. Client ids rotate every seven days, so this
 * over-splits a long-lived reader into several clients and the interval is
 * therefore a little narrower than the truth. That is a known bias, in the
 * direction of overconfidence, and it is stated in the report rather than left
 * for someone to find.
 */
function bootstrapByClient(units, statistic, seed = BOOTSTRAP_SEED) {
  const clients = [...new Set(units.map((unit) => unit.client_id))];
  if (clients.length < 2) return { lower: null, upper: null, resamples: 0 };
  const byClient = new Map(clients.map((client) => [client, []]));
  for (const unit of units) byClient.get(unit.client_id).push(unit);

  const rng = mulberry32(seed);
  const draws = [];
  for (let round = 0; round < BOOTSTRAP_RESAMPLES; round += 1) {
    const sample = [];
    for (let i = 0; i < clients.length; i += 1) {
      const picked = clients[Math.floor(rng() * clients.length)];
      sample.push(...byClient.get(picked));
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) draws.push(value);
  }
  if (draws.length < BOOTSTRAP_RESAMPLES / 2) {
    return { lower: null, upper: null, resamples: draws.length };
  }
  draws.sort((a, b) => a - b);
  const at = (q) => draws[Math.min(draws.length - 1, Math.floor(q * draws.length))];
  return { lower: at(0.025), upper: at(0.975), resamples: draws.length };
}

// --- feature extractors, including the one that cheats ---

/**
 * The leaking extractor: the same features plus one that asks how many clicks
 * an event collected in the WEEK AFTER the impression. The probe answers, and
 * records that it was asked about a time the render had not reached, which is
 * what the detector fails the run on.
 */
const leakingExtractor = {
  names: [...FEATURE_NAMES, "futureClicksNextWeek"],
  extract: (event, context, probe) => [
    ...extractFeatures(event, context),
    probe
      ? probe.clicksInWindow(event.id, context.asOf, context.asOf + LEAK_WINDOW_MS)
      : 0,
  ],
};

/**
 * The other half of the detector, and the half that needs no cooperation from
 * the feature: move every field the manifest does not allow a feature to read,
 * plant two that look exactly like future engagement, and check the vector did
 * not move.
 */
function perturbationFailures(events, context, extractor, probe) {
  const failures = [];
  for (const event of events) {
    const perturbed = {
      ...event,
      futureClicks: 991,
      clicksAfterImpression: 137,
      engagementToDate: 44,
    };
    for (const [key, value] of Object.entries(event)) {
      if (RANKING_TIME_EVENT_FIELDS.includes(key)) continue;
      if (typeof value === "string") perturbed[key] = `${value}-moved`;
      else if (typeof value === "number") perturbed[key] = value + 1234;
      else if (typeof value === "boolean") perturbed[key] = !value;
      else perturbed[key] = null;
    }
    const before = extractor.extract(event, context, probe);
    const after = extractor.extract(perturbed, context, probe);
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) {
        failures.push({
          event_id: event.id,
          feature: extractor.names[i] ?? `feature_${i}`,
          before: before[i],
          after: after[i],
        });
        break;
      }
    }
  }
  return failures;
}

// --- orderings ---

function scoreWith(model, features) {
  let z = model.bias;
  for (let i = 0; i < features.length; i += 1) z += model.weights[i] * features[i];
  return z;
}

function orderByModel(events, model, context, extractor, probe) {
  return events
    .map((event, index) => ({
      event,
      index,
      z: scoreWith(model, extractor.extract(event, context, probe)),
    }))
    .sort((a, b) => b.z - a.z || a.index - b.index)
    .map((entry) => entry.event);
}

/** A seeded shuffle, so the random baseline is a baseline and not a lottery. */
function seededShuffle(events, seed) {
  const rng = mulberry32(seed);
  const out = [...events];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- the run ---

export async function evaluate(options = {}) {
  const {
    logPath,
    artifactPath,
    control = null,
  } = options;

  const rawLog = await readFile(logPath, "utf8");
  const rows = await readEventLog(logPath);
  const data = JSON.parse(await readFile(resolve(root, "data/events.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(resolve(root, "results/recommender-manifest.json"), "utf8"),
  );
  const defaultRegion = data.meta.defaultRegion;
  const region =
    data.meta.regions.find((entry) => entry.key === defaultRegion) ??
    data.meta.regions[0];
  const catalog = new Map(data.events.map((event) => [event.id, event]));

  // The artifact is read the way the board reads it: present and valid, or
  // absent and therefore the production ordering. --control missing-artifact
  // simply points this at a path that is not there.
  let artifact = null;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch {
    artifact = null;
  }
  const committedModel = validateModel(artifact);

  const renders = groupRenders(rows);
  const index = engagementIndex(rows);
  const extractor = control === "leak-future" ? leakingExtractor : productionExtractor;

  const rowsBySource = {};
  for (const row of rows) rowsBySource[row.source] = (rowsBySource[row.source] ?? 0) + 1;
  const organicRows = rows.filter((row) => row.source === ORGANIC_SOURCE);

  // --- leakage detection ---

  const violations = [];
  const trainingRows = [];
  for (const render of renders) {
    const probe = index.at(render.ts);
    for (const item of render.items) {
      const event = catalog.get(item.event_id);
      if (!event) continue;
      const context = { asOf: item.ts, regionKey: region.key, defaultRegion };
      trainingRows.push({
        features: extractor.extract(event, context, probe),
        label: render.interactions.has(item.event_id) ? 1 : 0,
        weight: positionWeight(item.position),
        client_id: render.client_id,
        day: render.day,
        ts: item.ts,
        render,
      });
    }
    violations.push(...probe.violations);
  }

  const sampleEvents = data.events
    .filter((event) => event.category === "hackathon")
    .slice(0, 25);
  const sampleProbe = index.at(Date.parse(data.meta.sweepCompletedAt));
  const failures = perturbationFailures(
    sampleEvents,
    {
      asOf: Date.parse(data.meta.sweepCompletedAt),
      regionKey: region.key,
      defaultRegion,
    },
    extractor,
    sampleProbe,
  );

  const leakage = {
    detected: violations.length > 0 || failures.length > 0,
    future_reads: violations.length,
    future_reads_sample: violations.slice(0, 3),
    perturbation_failures: failures.length,
    perturbation_sample: failures.slice(0, 3),
    method:
      "Two prongs. Every field outside the manifest's allow-list is perturbed and the feature vector must not move. And the only accessor that can reach engagement is alarmed: asking about any instant at or after the impression records a violation.",
  };

  // --- the prequential split ---

  const days = [...new Set(renders.map((render) => render.day))].sort();
  const minimumRows = manifest.split.minimum_training_rows;
  const evaluationDays = [];
  const perRender = [];
  const orderings = ["production", "popularity", "recency", "random", "candidate"];
  const shuffledUnits = [];
  const coverage = Object.fromEntries(orderings.map((name) => [name, new Set()]));
  const regionalCoverage = Object.fromEntries(
    orderings.map((name) => [name, new Set()]),
  );
  const universe = new Set();

  for (const day of days) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const trainSet = trainingRows.filter((row) => row.ts < dayStart);
    const evalRenders = renders.filter((render) => render.day === day);
    if (trainSet.length < minimumRows || evalRenders.length === 0) continue;

    const trained = trainLogistic(trainSet);
    // The same rows with their labels shuffled: a model with nothing to learn.
    // Deterministic, seeded off the day so each day's control is its own draw.
    const shuffledLabels = seededShuffle(
      trainSet.map((row) => row.label),
      Number(day.replaceAll("-", "")),
    );
    const shuffledTrained = trainLogistic(
      trainSet.map((row, i) => ({ ...row, label: shuffledLabels[i] })),
    );

    evaluationDays.push({
      day,
      training_rows: trainSet.length,
      training_positives: trainSet.filter((row) => row.label === 1).length,
      evaluated_renders: evalRenders.length,
    });

    for (const render of evalRenders) {
      // Only the items this render actually showed can be scored: they are the
      // only ones with a label. An ordering that would have surfaced something
      // the reader never saw is neither credited nor punished for it, which is
      // the standard limitation of any offline ranking evaluation and the
      // reason the online interleaving section exists at all.
      const shown = render.items
        .map((item) => catalog.get(item.event_id))
        .filter(Boolean);
      if (shown.length === 0) continue;
      const relevant = new Set(
        [...render.interactions.keys()].filter((id) => catalog.has(id)),
      );
      for (const event of shown) universe.add(event.id);

      const context = { asOf: render.ts, regionKey: region.key, defaultRegion };
      const probe = index.at(render.ts);
      const boardOrder = boardVisible(shown, {
        regionKey: region.key,
        coreArea: region.coreArea,
        defaultRegion,
        view: "everything",
        query: "",
        asOf: render.ts,
      });

      const lists = {
        production: boardOrder,
        popularity: [...shown]
          .map((event, i) => ({ event, i, clicks: probe.priorClicks(event.id) }))
          .sort(
            (a, b) =>
              b.clicks - a.clicks ||
              boardOrder.indexOf(a.event) - boardOrder.indexOf(b.event),
          )
          .map((entry) => entry.event),
        recency: [...shown].sort((a, b) =>
          (a.start ?? "9999").localeCompare(b.start ?? "9999"),
        ),
        random: seededShuffle(shown, RANDOM_SEED + render.ts),
        candidate: orderByModel(shown, trained, context, extractor, probe),
      };
      const shuffledList = orderByModel(
        shown,
        shuffledTrained,
        context,
        extractor,
        probe,
      );

      const measure = (list) => {
        const ids = list.map((event) => event.id);
        return {
          "NDCG@5": ndcg(ids, relevant, 5),
          "NDCG@10": ndcg(ids, relevant, 10),
          MRR: mrr(ids, relevant),
          "recall@10": recallAt(ids, relevant, 10),
        };
      };

      const measured = {};
      for (const name of orderings) {
        measured[name] = measure(lists[name]);
        for (const event of lists[name].slice(0, 10)) {
          coverage[name].add(event.id);
          regionalCoverage[name].add(event.region ?? defaultRegion);
        }
      }
      perRender.push({
        client_id: render.client_id,
        day,
        clicks: relevant.size,
        measured,
      });
      shuffledUnits.push({
        client_id: render.client_id,
        value: measure(shuffledList)["NDCG@10"],
        production: measured.production["NDCG@10"],
      });
    }
  }

  const metricNames = ["NDCG@5", "NDCG@10", "MRR", "recall@10"];
  const offline = {};
  for (const name of orderings) {
    const units = perRender.map((row) => ({
      client_id: row.client_id,
      ...row.measured[name],
    }));
    const entry = { coverage_at_10: coverage[name].size };
    entry.coverage_at_10_share = universe.size
      ? round(coverage[name].size / universe.size)
      : null;
    entry.regional_coverage_at_10 = regionalCoverage[name].size;
    for (const metric of metricNames) {
      const values = units.map((unit) => unit[metric]);
      const interval = bootstrapByClient(units, (sample) =>
        mean(sample.map((unit) => unit[metric])),
      );
      entry[metric] = {
        mean: round(mean(values)),
        ci95: [round(interval.lower), round(interval.upper)],
        scored_renders: values.filter((value) => value !== null).length,
      };
    }
    offline[name] = entry;
  }

  // --- the standing controls ---

  const shuffledMean = mean(shuffledUnits.map((unit) => unit.value));
  const productionMean = offline.production["NDCG@10"].mean;
  const shuffleControl = {
    id: "shuffle-labels",
    expectation: "a candidate trained on shuffled labels must not beat production",
    shuffled_ndcg10: round(shuffledMean),
    production_ndcg10: productionMean,
    behaved_as_expected:
      shuffledMean === null || productionMean === null
        ? false
        : shuffledMean <= productionMean,
  };

  const frozenSnapshot = manifest.production_ordering.snapshot;
  const frozenAsOf = Date.parse(manifest.production_ordering.as_of);
  const frozenList = boardVisible(data.events, {
    regionKey: region.key,
    coreArea: region.coreArea,
    defaultRegion,
    view: manifest.production_ordering.view,
    query: "",
    asOf: frozenAsOf,
  });
  const coldContext = {
    asOf: frozenAsOf,
    regionKey: region.key,
    defaultRegion,
  };
  const coldStart = rankedList({
    visible: frozenList,
    model: committedModel,
    clientId: null,
    dayKey: "2026-09-09",
    context: coldContext,
  });
  const coldControl = {
    id: "cold-start",
    expectation: "a client with no history receives exactly the production ordering",
    ordering: coldStart.ordering,
    matches_frozen_snapshot:
      JSON.stringify(coldStart.rows.map((entry) => entry.event.id)) ===
      JSON.stringify(frozenSnapshot),
    behaved_as_expected: false,
  };
  coldControl.behaved_as_expected =
    coldStart.ordering === "production" && coldControl.matches_frozen_snapshot;

  const missing = rankedList({
    visible: frozenList,
    model: validateModel(null),
    clientId: "AbCdEfGhIjKlMnOpQr",
    dayKey: "2026-09-09",
    context: coldContext,
  });
  const missingAgain = rankedList({
    visible: frozenList,
    model: validateModel(null),
    clientId: "AbCdEfGhIjKlMnOpQr",
    dayKey: "2026-09-09",
    context: coldContext,
  });
  const missingControl = {
    id: "missing-artifact",
    expectation: "a missing model artifact yields the production ordering, deterministically",
    artifact_path: relative(root, artifactPath),
    artifact_present: committedModel !== null,
    ordering: missing.ordering,
    matches_frozen_snapshot:
      JSON.stringify(missing.rows.map((entry) => entry.event.id)) ===
      JSON.stringify(frozenSnapshot),
    deterministic:
      JSON.stringify(missing.rows.map((entry) => entry.event.id)) ===
      JSON.stringify(missingAgain.rows.map((entry) => entry.event.id)),
    behaved_as_expected: false,
  };
  missingControl.behaved_as_expected =
    missing.ordering === "production" &&
    missingControl.matches_frozen_snapshot &&
    missingControl.deterministic;

  const leakControl = {
    id: "leak-future",
    expectation:
      control === "leak-future"
        ? "the leakage detector fails the run"
        : "no leakage from the production extractor (run --control leak-future to watch the detector fire)",
    run_in_this_mode: control === "leak-future",
    detected: leakage.detected,
    behaved_as_expected:
      control === "leak-future" ? leakage.detected : !leakage.detected,
    note:
      control === "leak-future"
        ? "This run deliberately added a feature reading engagement after the impression."
        : "Not the planted mode: here the expectation is that the detector finds nothing, because the production extractor reads nothing it should not. Run --control leak-future to see it fail.",
  };

  // The evaluator's own ordering must be the board's ordering, or the whole
  // comparison is against something the reader never sees.
  const agreement =
    committedModel === null
      ? null
      : JSON.stringify(
          candidateOrder(frozenList, committedModel, coldContext).map((e) => e.id),
        ) ===
        JSON.stringify(
          orderByModel(
            frozenList,
            committedModel,
            coldContext,
            productionExtractor,
            null,
          ).map((e) => e.id),
        );

  const controls = [leakControl, shuffleControl, coldControl, missingControl];

  // --- online: the interleaving ---

  const creditFor = (subset) => {
    const drafted = subset.filter((render) =>
      render.items.some((item) => item.ranking === "candidate"),
    );
    const perClient = new Map();
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const render of drafted) {
      const team = new Map(
        render.items.map((item) => [item.event_id, item.ranking]),
      );
      let candidateClicks = 0;
      let productionClicks = 0;
      for (const id of render.clicks.keys()) {
        if (team.get(id) === "candidate") candidateClicks += 1;
        else if (team.get(id) === "production") productionClicks += 1;
      }
      let outcome = 0;
      if (candidateClicks > productionClicks) {
        wins += 1;
        outcome = 1;
      } else if (candidateClicks < productionClicks) {
        losses += 1;
        outcome = -1;
      } else {
        ties += 1;
      }
      if (!perClient.has(render.client_id)) {
        perClient.set(render.client_id, []);
      }
      perClient.get(render.client_id).push(outcome);
    }
    const units = [...perClient.entries()].flatMap(([client_id, outcomes]) =>
      outcomes.map((value) => ({ client_id, value })),
    );
    const delta = units.length
      ? units.reduce((sum, unit) => sum + unit.value, 0) / units.length
      : null;
    const interval = bootstrapByClient(units, (sample) =>
      sample.length
        ? sample.reduce((sum, unit) => sum + unit.value, 0) / sample.length
        : null,
    );
    return {
      drafted_renders: drafted.length,
      clients: perClient.size,
      wins,
      losses,
      ties,
      delta: round(delta),
      delta_ci95: [round(interval.lower), round(interval.upper)],
      lower_bound_above_zero:
        interval.lower !== null && interval.lower > 0,
    };
  };

  const organicRenderKeys = new Set(
    organicRows.map((row) => `${row.client_id}|${row.session_id}`),
  );
  const organicRenders = renders.filter(
    (render) =>
      render.source === ORGANIC_SOURCE &&
      organicRenderKeys.has(`${render.client_id}|${render.session_id}`),
  );

  const gate = manifest.promotion_gate.organic_gate;
  const organicClients = new Set(organicRows.map((row) => row.client_id));
  const organicDays = new Set(organicRows.map((row) => dayKey(row.ts)));
  const organicImpressions = organicRows.filter(
    (row) => row.type === "impression",
  ).length;
  const organicInteractions = organicRows.length - organicImpressions;
  const gateChecks = {
    organic_impressions: {
      value: organicImpressions,
      required: gate.min_organic_impressions,
      met: organicImpressions >= gate.min_organic_impressions,
    },
    organic_interactions: {
      value: organicInteractions,
      required: gate.min_organic_interactions,
      met: organicInteractions >= gate.min_organic_interactions,
    },
    anonymous_clients: {
      value: organicClients.size,
      required: gate.min_anonymous_clients,
      met: organicClients.size >= gate.min_anonymous_clients,
    },
    full_days: {
      value: organicDays.size,
      required: gate.min_full_days,
      met: organicDays.size >= gate.min_full_days,
    },
  };
  const organicGateMet = Object.values(gateChecks).every((check) => check.met);

  // --- the verdict ---

  const bestBaseline = ["production", "popularity", "recency", "random"]
    .map((name) => ({ name, value: offline[name]["NDCG@10"].mean ?? -1 }))
    .sort((a, b) => b.value - a.value)[0];
  const candidateNdcg = offline.candidate["NDCG@10"].mean;
  const beatsBestBaseline =
    candidateNdcg !== null && candidateNdcg > bestBaseline.value;
  const coverageDrop =
    offline.production.coverage_at_10 === 0
      ? null
      : 1 - offline.candidate.coverage_at_10 / offline.production.coverage_at_10;
  const diversityHeld =
    coverageDrop !== null &&
    coverageDrop <= 0.1 &&
    offline.candidate.regional_coverage_at_10 >=
      offline.production.regional_coverage_at_10;
  const online = creditFor(organicRenders);
  const controlsAllBehaved = controls.every((entry) => entry.behaved_as_expected);

  const promotion = {
    no_leakage: !leakage.detected,
    all_controls_behaved: controlsAllBehaved,
    beats_best_frozen_baseline: beatsBestBaseline,
    best_frozen_baseline: bestBaseline.name,
    wins_organic_interleaving: online.lower_bound_above_zero,
    diversity_held: diversityHeld,
    organic_gate_met: organicGateMet,
  };
  const verdict = organicGateMet
    ? Object.values(promotion).every((value) => value === true || typeof value === "string")
      ? "Promote"
      : "Do not promote"
    : manifest.promotion_gate.verdict_when_organic_gate_unmet;

  const syntheticOnly = (rowsBySource[ORGANIC_SOURCE] ?? 0) === 0;
  const honesty = {
    traffic: syntheticOnly
      ? "SYNTHETIC ONLY. Every row in this log is seeded, synthetic, developer or replay traffic. Nothing here is a measurement of how anybody uses the board."
      : `Mixed: ${rowsBySource[ORGANIC_SOURCE]} organic rows out of ${rows.length}. Only organic rows count towards the gate.`,
    offline_numbers: syntheticOnly
      ? "The offline table below carries NO quality claim. The fixture's reader is a linear function of the same features the ranker gets and is examined at exactly the propensity the trainer assumes, so a win here shows the pipeline runs and a loss would show a bug."
      : "Offline numbers are computed over every row in the log, organic and not. Read the organic section for anything that is a claim about readers.",
    implemented_vs_measured:
      "Implemented and exercised locally. Nothing in this file is an online lift measurement.",
    local_vs_deployed:
      "Produced locally from a committed log. The board has not been deployed with logging enabled by this branch.",
  };

  return {
    offlineReport: {
      generated_from: {
        log: relative(root, logPath),
        log_sha256: createHash("sha256").update(rawLog).digest("hex"),
        rows: rows.length,
        rows_by_source: rowsBySource,
        window: rows.length
          ? [
              new Date(Math.min(...rows.map((row) => row.ts))).toISOString(),
              new Date(Math.max(...rows.map((row) => row.ts))).toISOString(),
            ]
          : null,
        artifact: relative(root, artifactPath),
        artifact_present: committedModel !== null,
        model_version: committedModel ? committedModel.modelVersion : null,
        control_mode: control,
      },
      honesty,
      manifest: {
        path: "results/recommender-manifest.json",
        snapshot_sha256: manifest.production_ordering.snapshot_sha256,
        events_file_sha256: manifest.production_ordering.events_file_sha256,
      },
      leakage,
      split: {
        scheme: manifest.split.scheme,
        rule: manifest.split.rule,
        days_in_log: days.length,
        evaluated_days: evaluationDays.length,
        detail: evaluationDays,
        scored_renders: perRender.length,
        judged_universe: universe.size,
        note: "Each ordering re-ranks only the items its render actually showed, because those are the only items with a label. An ordering that would have surfaced an unlogged event is neither credited nor punished for it.",
      },
      metrics: offline,
      evaluator_matches_the_board: agreement,
      controls,
    },
    onlineReport: {
      generated_from: {
        log: relative(root, logPath),
        control_mode: control,
      },
      honesty,
      interleaving_all_rows: creditFor(renders),
      interleaving_organic_only: online,
      organic_gate: {
        rule: gate.rule,
        checks: gateChecks,
        met: organicGateMet,
        excluded_rows_by_source: Object.fromEntries(
          Object.entries(rowsBySource).filter(([source]) => source !== ORGANIC_SOURCE),
        ),
      },
      promotion,
      verdict,
    },
    verdict,
    leakage,
    controls,
    syntheticOnly,
  };
}

// --- the written report ---

function reportMarkdown(offlineReport, onlineReport) {
  const lines = [];
  const say = (text = "") => lines.push(text);
  const yes = (value) => (value === true ? "yes" : value === false ? "NO" : "n/a");

  say("# Recommender evaluation");
  say();
  say(`Verdict: **${onlineReport.verdict}**`);
  say();
  say("## What this is, and what it is not");
  say();
  say(`- Traffic: ${offlineReport.honesty.traffic}`);
  say(`- Offline numbers: ${offlineReport.honesty.offline_numbers}`);
  say(`- Implemented or measured: ${offlineReport.honesty.implemented_vs_measured}`);
  say(`- Local or deployed: ${offlineReport.honesty.local_vs_deployed}`);
  say();
  const from = offlineReport.generated_from;
  say(
    `Log \`${from.log}\` (${from.rows} rows: ${Object.entries(from.rows_by_source)
      .map(([source, count]) => `${count} ${source}`)
      .join(", ")}), artifact \`${from.artifact}\`${
      from.artifact_present ? ` (${from.model_version})` : " (absent)"
    }${from.control_mode ? `, control mode \`${from.control_mode}\`` : ""}.`,
  );
  say();

  say("## Organic gate");
  say();
  say(onlineReport.organic_gate.rule);
  say();
  say("| Requirement | Have | Need | Met |");
  say("| --- | ---: | ---: | --- |");
  for (const [name, check] of Object.entries(onlineReport.organic_gate.checks)) {
    say(
      `| ${name.replaceAll("_", " ")} | ${check.value} | ${check.required} | ${yes(check.met)} |`,
    );
  }
  say();
  say(
    onlineReport.organic_gate.met
      ? "The gate is met."
      : "The gate is NOT met, so no online result is claimed and the verdict cannot be a promotion.",
  );
  say();

  say("## Leakage");
  say();
  say(offlineReport.leakage.method);
  say();
  say(
    `- Detected: **${offlineReport.leakage.detected ? "YES" : "no"}**`,
  );
  say(`- Reads of engagement at or after the impression: ${offlineReport.leakage.future_reads}`);
  say(`- Features that moved when a disallowed field moved: ${offlineReport.leakage.perturbation_failures}`);
  say();

  say("## Negative controls");
  say();
  say("| Control | Expected | Behaved as expected |");
  say("| --- | --- | --- |");
  for (const control of offlineReport.controls) {
    say(`| ${control.id} | ${control.expectation} | ${yes(control.behaved_as_expected)} |`);
  }
  say();

  say("## Offline");
  say();
  const split = offlineReport.split;
  say(
    `${split.scheme}: ${split.evaluated_days} of ${split.days_in_log} days evaluated, ${split.scored_renders} rendered lists scored over a judged universe of ${split.judged_universe} events.`,
  );
  say();
  say(split.note);
  say();
  say("| Ordering | NDCG@5 | NDCG@10 | MRR | recall@10 | coverage@10 | regions@10 |");
  say("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [name, entry] of Object.entries(offlineReport.metrics)) {
    const cell = (metric) => {
      const value = entry[metric];
      if (value.mean === null) return "n/a";
      const [low, high] = value.ci95;
      return low === null
        ? `${value.mean}`
        : `${value.mean} [${low}, ${high}]`;
    };
    say(
      `| ${name} | ${cell("NDCG@5")} | ${cell("NDCG@10")} | ${cell("MRR")} | ${cell("recall@10")} | ${entry.coverage_at_10} | ${entry.regional_coverage_at_10} |`,
    );
  }
  say();
  say("Intervals are 95 percent percentile bootstrap, 2000 resamples, resampled by client.");
  say();

  say("## Online: team-draft interleaving");
  say();
  for (const [label, section] of [
    ["Every row in the log", onlineReport.interleaving_all_rows],
    ["Organic rows only", onlineReport.interleaving_organic_only],
  ]) {
    say(
      `- **${label}**: ${section.drafted_renders} drafted lists across ${section.clients} clients. ` +
        `${section.wins} wins, ${section.losses} losses, ${section.ties} ties. ` +
        `Delta ${section.delta ?? "n/a"}${
          section.delta_ci95[0] === null
            ? ""
            : ` (95% CI [${section.delta_ci95[0]}, ${section.delta_ci95[1]}])`
        }. Lower bound above zero: ${yes(section.lower_bound_above_zero)}.`,
    );
  }
  say();

  say("## Promotion gate");
  say();
  say("| Condition | Status |");
  say("| --- | --- |");
  for (const [name, value] of Object.entries(onlineReport.promotion)) {
    say(`| ${name.replaceAll("_", " ")} | ${typeof value === "string" ? value : yes(value)} |`);
  }
  say();
  say(`Verdict: **${onlineReport.verdict}**`);
  say();

  say("## Limitations");
  say();
  for (const limitation of LIMITATIONS) say(`- ${limitation}`);
  // No trailing blank line: `git diff --check` treats one as whitespace damage,
  // and this file is committed.
  return `${lines.join("\n")}\n`;
}

export const LIMITATIONS = Object.freeze([
  "No organic traffic exists. Every number above other than the gate counts comes from a synthetic fixture, and the fixture is rigged in the ranker's favour: its reader's taste is linear in the same features the ranker gets, and examination falls at exactly the propensity the trainer assumes.",
  "Offline re-ranking scores only the items a render actually showed, because those are the only items with a label. An ordering that would have surfaced something the reader never saw is neither credited nor punished.",
  "Position bias is corrected with an assumed 1/rank examination curve. It has not been fitted, and fitting it needs a position-swap experiment on real traffic.",
  "Bootstrap units are client ids, and client ids rotate every seven days, so one long-lived reader appears as several clients. The intervals are therefore slightly narrower than the truth, which is an error in the direction of overconfidence.",
  "Regional coverage cannot discriminate on this board: the first paint is a single region, so every ordering scores one region. The check is in place for the day a render spans more.",
  "A save is feed-level on this board, because subscribing covers a whole region. It therefore labels no event, and the click-or-save label is driven entirely by clicks.",
  "The inverse-propensity weight is applied to every training row rather than to the clicked rows alone. That is what the frozen manifest specified and what was run; weighting only the positives is the more standard form of the correction and is the first thing to change in a next round, before any organic data is collected.",
]);

async function main() {
  const control = argOf("control", null);
  if (control && !CONTROLS.includes(control)) {
    console.error(`Unknown control "${control}". One of: ${CONTROLS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const logPath = resolve(root, argOf("log", DEFAULT_LOG));
  const artifactPath =
    control === "missing-artifact"
      ? resolve(root, "data/ranker-this-file-does-not-exist.json")
      : resolve(root, argOf("artifact", DEFAULT_ARTIFACT));
  const outDir = resolve(root, argOf("out-dir", "results"));
  const write = !process.argv.includes("--no-write") && !control;

  const result = await evaluate({ logPath, artifactPath, control });
  const markdown = reportMarkdown(result.offlineReport, result.onlineReport);

  if (write) {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      resolve(outDir, "recommender-offline.json"),
      `${JSON.stringify(result.offlineReport, null, 2)}\n`,
    );
    await writeFile(
      resolve(outDir, "recommender-online.json"),
      `${JSON.stringify(result.onlineReport, null, 2)}\n`,
    );
    await writeFile(resolve(outDir, "recommender-report.md"), markdown);
    console.log(`Wrote ${relative(root, outDir)}/recommender-{offline,online}.json and recommender-report.md`);
  }

  console.log(markdown);

  if (control) {
    const observed = result.controls.find((entry) => entry.id === control);
    const ok = observed ? observed.behaved_as_expected : false;
    console.log(
      `CONTROL ${control}: ${ok ? "behaved as expected" : "DID NOT behave as expected"}`,
    );
    console.log(`CONTROL ${control} detail: ${JSON.stringify(observed)}`);
    // A control that behaves as expected still exits non-zero when the thing it
    // planted is a failure, because that failure is the point: a leaking run
    // must never look like a successful run to anything reading exit codes.
    if (control === "leak-future") {
      console.error(
        result.leakage.detected
          ? "FAILED THE RUN: leakage detected, which is what this control planted."
          : "The leakage detector did not fire. That is a bug in the detector.",
      );
      process.exitCode = 1;
      return;
    }
    if (!ok) process.exitCode = 1;
    return;
  }

  if (result.leakage.detected) {
    console.error("FAILED THE RUN: leakage detected.");
    process.exitCode = 1;
    return;
  }
  const misbehaved = result.controls.filter((entry) => !entry.behaved_as_expected);
  if (misbehaved.length > 0) {
    console.error(
      `FAILED THE RUN: controls did not behave as expected: ${misbehaved
        .map((entry) => entry.id)
        .join(", ")}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
