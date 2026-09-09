// Train data/ranker.json from an event log.
//
// The artifact is a pure function of the log and the hyperparameters: zero
// initialization, full-batch gradient descent, a fixed step count, and no
// timestamp of when it was trained. Run this twice on the same log and you get
// the same bytes, which is what makes "this model came from that data" a
// checkable claim rather than a note in a commit message.
//
// The artifact also carries what it was trained on, by source. A model built
// from synthetic rows says so in its own version string, so a board serving it
// cannot quietly be described as personalized by real behaviour.
//
// Run: node scripts/recommender-train.mjs
// Options: --log PATH --out PATH

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TRAINING,
  FEATURE_NAMES,
  POSITION_BIAS_ETA,
  POSITION_WEIGHT_CAP,
  logLoss,
  trainLogistic,
  validateModel,
} from "../app/ranking.mjs";
import { ORGANIC_SOURCE } from "../app/telemetry-schema.mjs";
import {
  buildTrainingRows,
  groupRenders,
  productionExtractor,
  readEventLog,
} from "./lib/recommender-log.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOG = "tests/fixtures/recommender-synthetic-events.jsonl";
const DEFAULT_OUT = "data/ranker.json";

/** How many rows the trainer refuses to produce a model below. */
export const MINIMUM_TRAINING_ROWS = 200;

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
};

/**
 * Build a model artifact from a log.
 *
 * @param {string} logPath
 */
export async function trainFromLog(logPath) {
  const raw = await readFile(logPath, "utf8");
  const rows = await readEventLog(logPath);
  const data = JSON.parse(await readFile(resolve(root, "data/events.json"), "utf8"));
  const defaultRegion = data.meta.defaultRegion;
  const catalog = new Map(data.events.map((event) => [event.id, event]));

  const renders = groupRenders(rows);
  const trainingRows = buildTrainingRows(renders, {
    catalog,
    defaultRegion,
    regionKey: defaultRegion,
    extractor: productionExtractor,
    index: null,
  });

  if (trainingRows.length < MINIMUM_TRAINING_ROWS) {
    throw new Error(
      `only ${trainingRows.length} training rows in ${logPath}; the manifest's floor is ${MINIMUM_TRAINING_ROWS}`,
    );
  }

  const trained = trainLogistic(trainingRows);
  const bySource = {};
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
  }
  const organicRows = bySource[ORGANIC_SOURCE] ?? 0;
  // A model's version says where its evidence came from, in the first three
  // characters, because that is the claim people get wrong.
  const tag = organicRows === 0 ? "syn" : "web";
  const timestamps = trainingRows.map((row) => row.ts);
  const window = {
    from: new Date(Math.min(...timestamps)).toISOString(),
    to: new Date(Math.max(...timestamps)).toISOString(),
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        features: FEATURE_NAMES,
        hyperparameters: DEFAULT_TRAINING,
        eta: POSITION_BIAS_ETA,
        cap: POSITION_WEIGHT_CAP,
        rows: trainingRows.length,
        log: createHash("sha256").update(raw).digest("hex"),
      }),
    )
    .digest("hex")
    .slice(0, 10);

  const artifact = {
    model_version: `${tag}-${fingerprint}`,
    feature_names: [...FEATURE_NAMES],
    weights: trained.weights,
    bias: trained.bias,
    family: "logistic regression, binary, click-or-save",
    l2: trained.l2,
    learning_rate: trained.learningRate,
    iterations: trained.iterations,
    position_bias: {
      method: "inverse propensity weighting by rank",
      eta: POSITION_BIAS_ETA,
      weight_cap: POSITION_WEIGHT_CAP,
      status: "assumed, not measured",
    },
    training_window: window,
    training_days: new Set(trainingRows.map((row) => row.day)).size,
    trained_rows: trainingRows.length,
    positive_rows: trainingRows.filter((row) => row.label === 1).length,
    weighted_log_loss: Number(logLoss(trainingRows, trained).toFixed(6)),
    log: {
      path: relative(root, resolve(logPath)),
      sha256: createHash("sha256").update(raw).digest("hex"),
      rows: rows.length,
      rows_by_source: bySource,
      organic_rows: organicRows,
    },
    honesty:
      organicRows === 0
        ? "Trained entirely on synthetic rows. This artifact carries no claim about real readers, and no number derived from it is a measurement of the board."
        : `Trained on a log containing ${organicRows} organic rows. Check results/recommender-online.json for whether the organic gate was met before describing this as measured.`,
    reproduce: `node scripts/recommender-train.mjs --log ${relative(root, resolve(logPath))}`,
  };

  if (!validateModel(artifact)) {
    throw new Error("the trainer produced an artifact its own validator refuses");
  }
  return { artifact, trainingRows };
}

async function main() {
  const logPath = resolve(root, argOf("log", DEFAULT_LOG));
  const out = resolve(root, argOf("out", DEFAULT_OUT));
  const { artifact } = await trainFromLog(logPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${relative(root, out)}: ${artifact.model_version}`);
  console.log(
    `${artifact.trained_rows} rows (${artifact.positive_rows} positive) over ${artifact.training_days} days, weighted log loss ${artifact.weighted_log_loss}`,
  );
  for (const [name, weight] of FEATURE_NAMES.map((name, i) => [
    name,
    artifact.weights[i],
  ]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`  ${name.padEnd(24)} ${weight.toFixed(4)}`);
  }
  console.log(artifact.honesty);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
