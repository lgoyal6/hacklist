// Run all four negative controls and say whether each one failed the way it is
// supposed to.
//
// A control that passes is worthless. The point of each of these is that it
// plants a specific defect and the machinery must notice: a feature reading the
// future must fail the run, a model trained on shuffled labels must not beat
// the board, and both fallbacks must land on exactly the frozen ordering rather
// than on something merely similar to it.
//
// Exits non-zero if any control did NOT behave as expected, including the
// leaking one: there, "as expected" means the detector fired.
//
// Run: npm run recommender:controls

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLS, evaluate } from "./recommender-eval.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
};

async function main() {
  const logPath = resolve(
    root,
    argOf("log", "tests/fixtures/recommender-synthetic-events.jsonl"),
  );
  const results = [];
  for (const control of CONTROLS) {
    const artifactPath =
      control === "missing-artifact"
        ? resolve(root, "data/ranker-this-file-does-not-exist.json")
        : resolve(root, argOf("artifact", "data/ranker.json"));
    const run = await evaluate({ logPath, artifactPath, control });
    const observed = run.controls.find((entry) => entry.id === control);
    results.push({ control, observed, leakage: run.leakage.detected });
    const line =
      control === "leak-future"
        ? `leakage detected: ${run.leakage.detected}, run failed: ${run.leakage.detected}`
        : JSON.stringify(observed);
    console.log(
      `${observed.behaved_as_expected ? "as expected" : "NOT AS EXPECTED"}  ${control}  ${line}`,
    );
  }

  const wrong = results.filter((entry) => !entry.observed.behaved_as_expected);
  if (wrong.length > 0) {
    console.error(
      `Controls that did not behave as expected: ${wrong.map((entry) => entry.control).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("All four controls behaved as expected.");
}

await main();
