// The evaluation, checked by running it.
//
// Deliberately NOT in test:artifact: it trains a model per evaluation day and
// takes seconds, and that gate must stay fast enough that nobody is tempted to
// skip it. It runs in the full suite, where "does the leakage detector actually
// fire" is worth the wait.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONTROLS, LIMITATIONS, evaluate } from "../scripts/recommender-eval.mjs";

const logPath = fileURLToPath(
  new URL("./fixtures/recommender-synthetic-events.jsonl", import.meta.url),
);
const artifactPath = fileURLToPath(new URL("../data/ranker.json", import.meta.url));
const missingPath = fileURLToPath(
  new URL("../data/ranker-this-file-does-not-exist.json", import.meta.url),
);

const standing = await evaluate({ logPath, artifactPath });

test("the standing run finds no leakage and every control behaves", () => {
  assert.equal(standing.leakage.detected, false, JSON.stringify(standing.leakage));
  assert.equal(standing.leakage.future_reads, 0);
  assert.equal(standing.leakage.perturbation_failures, 0);
  for (const control of standing.controls) {
    assert.equal(
      control.behaved_as_expected,
      true,
      `${control.id} did not behave as expected: ${JSON.stringify(control)}`,
    );
  }
  assert.deepEqual(
    standing.controls.map((control) => control.id).sort(),
    [...CONTROLS].sort(),
    "a control named in the manifest is not run",
  );
});

test("planting a feature that reads the future fails the run", async () => {
  const leaking = await evaluate({ logPath, artifactPath, control: "leak-future" });
  assert.equal(
    leaking.leakage.detected,
    true,
    "a feature reading engagement after the impression was not detected",
  );
  assert.ok(
    leaking.leakage.future_reads > 0,
    "the alarmed accessor recorded nothing",
  );
  assert.match(
    leaking.leakage.future_reads_sample[0].reason,
    /after the impression/,
  );
  const control = leaking.controls.find((entry) => entry.id === "leak-future");
  assert.equal(control.behaved_as_expected, true);
});

test("the evaluator ranks with the same function the board ranks with", () => {
  assert.equal(
    standing.offlineReport.evaluator_matches_the_board,
    true,
    "the evaluator's candidate ordering is not the board's candidate ordering",
  );
});

test("the split never evaluates a day it trained on", () => {
  const split = standing.offlineReport.split;
  assert.ok(split.evaluated_days > 5, `only ${split.evaluated_days} days evaluated`);
  assert.ok(split.scored_renders > 50);
  for (const day of split.detail) {
    assert.ok(
      day.training_rows >= 200,
      `${day.day} was evaluated on ${day.training_rows} training rows`,
    );
    assert.ok(day.evaluated_renders > 0);
  }
  // Days are strictly increasing and each one is evaluated once.
  const days = split.detail.map((entry) => entry.day);
  assert.deepEqual(days, [...days].sort());
  assert.equal(new Set(days).size, days.length);
});

test("a synthetic log produces no organic anything and no promotion", () => {
  const online = standing.onlineReport;
  assert.equal(online.organic_gate.met, false);
  for (const [name, check] of Object.entries(online.organic_gate.checks)) {
    assert.equal(check.value, 0, `${name} was not zero on a synthetic log`);
    assert.equal(check.met, false);
  }
  assert.equal(online.interleaving_organic_only.drafted_renders, 0);
  assert.equal(online.interleaving_organic_only.clients, 0);
  assert.equal(online.interleaving_organic_only.lower_bound_above_zero, false);
  assert.equal(online.verdict, "Implemented result pending");
  assert.equal(standing.syntheticOnly, true);
  assert.match(standing.offlineReport.honesty.traffic, /SYNTHETIC ONLY/);
  assert.match(standing.offlineReport.honesty.offline_numbers, /NO quality claim/);
});

test("the interleaving on the log's own drafted lists is a real comparison", () => {
  // Not an organic result, and the verdict above refuses to treat it as one.
  // What it does check is that the credit machinery works at all: the fixture
  // drafted for half its window, so there must be drafted lists to credit.
  const all = standing.onlineReport.interleaving_all_rows;
  assert.ok(all.drafted_renders > 20, `${all.drafted_renders} drafted lists`);
  assert.equal(all.wins + all.losses + all.ties, all.drafted_renders);
  assert.ok(all.clients > 1, "the bootstrap had fewer than two clients to resample");
  assert.ok(all.delta_ci95[0] !== null, "no interval was produced");
  assert.ok(all.delta_ci95[0] <= all.delta && all.delta <= all.delta_ci95[1]);
});

test("every baseline the manifest names was actually run", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../results/recommender-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const measured = Object.keys(standing.offlineReport.metrics);
  for (const baseline of manifest.baselines) {
    assert.ok(
      measured.includes(baseline.id),
      `the manifest names the ${baseline.id} baseline and the run did not measure it`,
    );
  }
  for (const metric of ["NDCG@5", "NDCG@10", "MRR", "recall@10"]) {
    for (const name of measured) {
      const entry = standing.offlineReport.metrics[name][metric];
      assert.ok(entry.mean !== null, `${name} has no ${metric}`);
      assert.ok(entry.scored_renders > 0);
      assert.ok(
        entry.ci95[0] <= entry.mean && entry.mean <= entry.ci95[1],
        `${name} ${metric} mean ${entry.mean} is outside its own interval`,
      );
    }
  }
  // The random baseline must be the worst of them, or something is wrong with
  // the metric rather than impressive about the orderings.
  const ndcg = (name) => standing.offlineReport.metrics[name]["NDCG@10"].mean;
  for (const name of ["production", "popularity", "candidate"]) {
    assert.ok(
      ndcg(name) > ndcg("random"),
      `${name} did not beat a seeded shuffle`,
    );
  }
});

test("pointing the run at a missing artifact is the production ordering", async () => {
  const without = await evaluate({
    logPath,
    artifactPath: missingPath,
    control: "missing-artifact",
  });
  const control = without.controls.find((entry) => entry.id === "missing-artifact");
  assert.equal(control.artifact_present, false);
  assert.equal(control.ordering, "production");
  assert.equal(control.matches_frozen_snapshot, true);
  assert.equal(control.deterministic, true);
  assert.equal(control.behaved_as_expected, true);
});

test("the report says what it cannot support", () => {
  assert.ok(LIMITATIONS.length >= 5);
  const joined = LIMITATIONS.join(" ");
  for (const subject of [
    "No organic traffic",
    "assumed 1/rank",
    "rotate every seven days",
    "feed-level",
  ]) {
    assert.ok(joined.includes(subject), `the limitations do not mention ${subject}`);
  }
});
