import test from "node:test";
import assert from "node:assert/strict";

import { reportOrganic } from "../scripts/recommender-organic-report.mjs";

const row = (type, source, ts, position, event_id, ranking = "production", model_version = null) => ({
  type, ts, client_id: "client_1234567890", session_id: "session_1234567890",
  locale: "en", event_id, position, ranking, model_version, viewport: "wide", source,
});

test("organic report uses only web impressions and their clicks", () => {
  const rows = [
    row("impression", "web", 1_800_000_000_000, 1, "event_a", "candidate", "ranker-1"),
    row("click", "web", 1_800_000_000_100, 1, "event_a", "candidate", "ranker-1"),
    row("impression", "synthetic", 1_800_000_000_000, 1, "event_b", "candidate", "ranker-1"),
    row("impression", "seeded", 1_800_000_000_000, 2, "event_c"),
  ];
  const report = reportOrganic(rows);
  assert.equal(report.status, "DESCRIPTIVE_ORGANIC_SAMPLE");
  assert.equal(report.impressions, 1);
  assert.equal(report.arms[0].clicks, 1);
  assert.equal(report.arms[0].click_rate, 1);
  assert.deepEqual(report.excluded_rows_by_source, { synthetic: 1, seeded: 1 });
});

test("no real web exposures remains explicitly inconclusive", () => {
  const report = reportOrganic([row("impression", "synthetic", 1_800_000_000_000, 1, "event_a")]);
  assert.equal(report.status, "NO_ORGANIC_DATA");
  assert.equal(report.impressions, 0);
  assert.deepEqual(report.arms, []);
});
