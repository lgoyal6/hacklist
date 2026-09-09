// Freeze the terms of the experiment, before there is a result to be tempted by.
//
// This writes results/recommender-manifest.json: the ordering we are trying to
// beat, the features the ranker is allowed to see, the split, the baselines, the
// metrics, and the thresholds. It is committed before the evaluator exists in
// the branch, and the numbers in it are never edited afterwards. A gate chosen
// after seeing the result is not a gate.
//
// Run: node scripts/recommender-freeze.mjs
// Check without writing: node scripts/recommender-freeze.mjs --check

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_NAMES,
  RANKING_TIME_EVENT_FIELDS,
  DEFAULT_TRAINING,
  POSITION_BIAS_ETA,
  POSITION_WEIGHT_CAP,
  BOARD_DEFAULT_VIEW,
  productionOrderIds,
} from "../app/ranking.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = resolve(root, "results/recommender-manifest.json");
const EVENTS_PATH = resolve(root, "data/events.json");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The manifest, derived from the committed board so it cannot drift from it.
 *
 * The snapshot is taken at meta.sweepCompletedAt rather than at "now" on
 * purpose. The board's list depends on the render instant (it drops events that
 * have finished), so a snapshot taken at wall-clock time would be a different
 * list tomorrow and could never be checked by a test. The sweep stamp is the
 * one instant the committed data file names, so the snapshot is reproducible
 * forever from the two committed files alone.
 */
export async function buildManifest() {
  const rawEvents = await readFile(EVENTS_PATH, "utf8");
  const data = JSON.parse(rawEvents);
  const asOfIso = data.meta.sweepCompletedAt;
  const asOf = Date.parse(asOfIso);
  const ids = productionOrderIds(data, { asOf });

  return {
    manifest_version: 1,
    frozen_at: "2026-09-09",
    subject: "hacklist board ordering: production versus a learned candidate",
    claim_state: "Implemented, not measured on organic traffic.",
    honesty: {
      traffic: "No organic traffic exists yet. Every number produced before a deploy collects real impressions is synthetic.",
      implemented_vs_measured:
        "The logging, the ranker, the interleaving and the evaluator are implemented and exercised locally. Nothing here is a measurement of how people use the board.",
      local_vs_deployed:
        "Everything in this manifest was produced locally. The Analytics Engine binding takes effect only on the next deploy of the repo's existing workflow.",
    },

    production_ordering: {
      description:
        "The board's first paint: default region, default view, no search, sorted by start date ascending with a stable tie-break on the order data/events.json already carries (hackathon before adjacent, then score descending).",
      implementation: "app/ranking.mjs -> productionOrder / boardVisible",
      called_by: "app/board.tsx (the page calls the same function; nothing re-implements the ordering)",
      view: BOARD_DEFAULT_VIEW,
      region: data.meta.defaultRegion,
      as_of: asOfIso,
      as_of_rationale:
        "The board drops events that have already finished, so its list depends on the render instant. Freezing at meta.sweepCompletedAt makes the snapshot reproducible from the committed files alone.",
      events_file: "data/events.json",
      events_file_sha256: sha256(rawEvents),
      snapshot_length: ids.length,
      snapshot_sha256: sha256(JSON.stringify(ids)),
      snapshot: ids,
    },

    features: {
      rule: "Ranking-time only. A feature may read a field the sweep wrote before the list was rendered, or compare against the render instant the impression records. Engagement counts are excluded: a click total is future information relative to the impression that produced it.",
      names: [...FEATURE_NAMES],
      allowed_event_fields: [...RANKING_TIME_EVENT_FIELDS],
      excluded_on_purpose: [
        "clicks, saves or impressions for the event (future information relative to an impression)",
        "anything derived from the reader beyond the anonymous client id: no IP, no email, no name, no user-agent, no referrer",
      ],
    },

    model: {
      family: "logistic regression, binary, predicting click-or-save from the feature vector",
      optimizer: "full-batch gradient descent in plain JavaScript, no dependencies",
      regularization: `L2 on the weights only, lambda = ${DEFAULT_TRAINING.l2}`,
      learning_rate: DEFAULT_TRAINING.learningRate,
      iterations: DEFAULT_TRAINING.iterations,
      initialization: "zeros",
      position_bias_correction: {
        method: "inverse propensity weighting by rank",
        propensity: "1 / rank^eta",
        eta: POSITION_BIAS_ETA,
        weight_cap: POSITION_WEIGHT_CAP,
        status: "ASSUMED, NOT MEASURED. Hacklist has no position-swap experiment, so this curve is borrowed rather than fitted.",
      },
      artifact: "data/ranker.json",
      determinism:
        "Full-batch, zero-initialized, fixed step count: the weights are a function of the rows and the hyperparameters, not of row order or a seed.",
    },

    split: {
      scheme: "prequential, rolling by calendar day (UTC)",
      rule: "For each evaluation day d, train on every row strictly before the start of day d and evaluate on day d only. No row is ever both trained on and evaluated.",
      minimum_training_rows: 200,
      minimum_evaluation_days: 1,
    },

    baselines: [
      { id: "production", description: "the frozen production ordering above" },
      {
        id: "popularity",
        description:
          "clicks accumulated strictly before the impression instant, descending; ties fall back to production order",
      },
      { id: "recency", description: "soonest start first; undated last" },
      { id: "random", description: "seeded shuffle, seed fixed in the evaluator" },
      { id: "candidate", description: "the trained model's ordering (the thing on trial)" },
    ],

    metrics: [
      "NDCG@5",
      "NDCG@10",
      "MRR",
      "click recall@10",
      "coverage (distinct events appearing in any top 10)",
      "regional coverage (distinct regions appearing in any top 10)",
    ],
    interval_method:
      "bootstrap, 2000 resamples, resampled by client rather than by row, 95 percent percentile interval",

    promotion_gate: {
      all_of: [
        "the leakage detector reports no leakage",
        "all four negative controls behave as expected",
        "the candidate beats the best frozen offline baseline on NDCG@10",
        "the candidate wins the organic team-draft interleaving with a lower 95 percent bootstrap bound above zero",
        "no material diversity or regional-coverage drop: coverage@10 within 10 percent of production, and regional coverage not lower than production",
      ],
      organic_gate: {
        rule: "Only rows tagged source=web count. Seeded, synthetic, developer and replay rows never count.",
        min_organic_impressions: 500,
        min_organic_interactions: 50,
        min_anonymous_clients: 25,
        min_full_days: 7,
      },
      verdict_when_organic_gate_unmet: "Implemented result pending",
    },

    negative_controls: [
      {
        id: "leak-future",
        expectation: "the leakage detector FAILS the run",
        mechanism:
          "a feature is added that reads engagement written after the impression; the detector perturbs every event field outside the allow-list and the feature vector moves",
      },
      {
        id: "shuffle-labels",
        expectation: "the candidate FAILS promotion",
        mechanism: "labels are shuffled within the training window, so the model has nothing to learn",
      },
      {
        id: "cold-start",
        expectation: "a client with no history receives EXACTLY the production ordering",
        mechanism: "no client id means no draft seed, so rankedList returns the production rows",
      },
      {
        id: "missing-artifact",
        expectation: "a missing model artifact yields the production ordering, deterministically",
        mechanism: "validateModel returns null for an absent or malformed artifact and rankedList falls back",
      },
    ],

    privacy: {
      stored_fields: [
        "type",
        "ts",
        "client_id",
        "session_id",
        "locale",
        "event_id",
        "position",
        "ranking",
        "model_version",
        "viewport",
        "source",
      ],
      never_stored: ["IP address", "email", "name", "user-agent", "referrer", "any server-derived identity"],
      client_id:
        "random 16 bytes from crypto.getRandomValues, base64url, generated in the browser, stored in localStorage with its creation time, rotated every 7 days. The server never derives, enriches or joins it.",
      rotation_days: 7,
      consequence:
        "Rotation caps how long any per-client analysis can reach back, and the interleaving credit is per client per day, which is well inside the window.",
    },

    storage: {
      decision: "Cloudflare Workers Analytics Engine, binding EVENTS, dataset hacklist_events",
      plan_basis:
        "The Workers Free plan includes 100,000 data points written and 10,000 read queries per day, and datasets are created on first write with no dashboard or API provisioning step.",
      docs: [
        "https://developers.cloudflare.com/analytics/analytics-engine/pricing/",
        "https://developers.cloudflare.com/analytics/analytics-engine/get-started/",
        "https://developers.cloudflare.com/analytics/analytics-engine/limits/",
        "https://developers.cloudflare.com/analytics/analytics-engine/sql-api/",
      ],
      provisioning: "none; the binding is declared in wrangler.jsonc and takes effect on the next deploy",
      no_resource_created_in_this_branch:
        "Nothing was deployed and no Cloudflare resource was created while writing this. The binding is configuration only.",
    },
  };
}

const canonical = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

async function main() {
  const manifest = await buildManifest();
  const text = canonical(manifest);
  if (process.argv.includes("--check")) {
    const existing = await readFile(MANIFEST_PATH, "utf8");
    if (existing !== text) {
      console.error(
        "results/recommender-manifest.json does not match the committed board.\n" +
          "The manifest is frozen: if data/events.json changed, that is a new experiment, not an edit to this one.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("Manifest matches the committed board.");
    return;
  }
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, text);
  console.log(
    `Wrote results/recommender-manifest.json: ${manifest.production_ordering.snapshot_length} events, ` +
      `snapshot sha256 ${manifest.production_ordering.snapshot_sha256}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
