#!/usr/bin/env node
// Descriptive report for real web exposure. Synthetic, seeded, dev, and replay
// rows are counted as exclusions and never enter the numerator or denominator.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { organicCounts, groupRenders, readEventLog } from "./lib/recommender-log.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : process.argv[i + 1] ?? null;
}

function wilson(clicks, impressions) {
  if (!impressions) return null;
  const z = 1.96;
  const p = clicks / impressions;
  const d = 1 + z * z / impressions;
  const center = (p + z * z / (2 * impressions)) / d;
  const radius = z * Math.sqrt(p * (1 - p) / impressions + z * z / (4 * impressions ** 2)) / d;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export function reportOrganic(rows) {
  const counts = organicCounts(rows);
  const organic = rows.filter((row) => row.source === "web");
  const renders = groupRenders(organic);
  const arms = new Map();
  for (const render of renders) {
    for (const item of render.items) {
      const key = `${item.ranking}:${render.model_version ?? "none"}`;
      const arm = arms.get(key) ?? { ranking: item.ranking, model_version: render.model_version, impressions: 0, clicks: 0 };
      arm.impressions += 1;
      if (render.clicks.has(item.event_id)) arm.clicks += 1;
      arms.set(key, arm);
    }
  }
  const byArm = [...arms.values()].sort((a, b) => a.ranking.localeCompare(b.ranking) || String(a.model_version).localeCompare(String(b.model_version)))
    .map((arm) => ({ ...arm, click_rate: arm.impressions ? arm.clicks / arm.impressions : null, descriptive_wilson_95: wilson(arm.clicks, arm.impressions) }));
  return {
    schema_version: 1,
    status: counts.impressions ? "DESCRIPTIVE_ORGANIC_SAMPLE" : "NO_ORGANIC_DATA",
    source: "web",
    impressions: counts.impressions,
    interactions: counts.interactions,
    rotating_client_ids: counts.clients,
    active_days: counts.days,
    excluded_rows_by_source: counts.excluded_rows_by_source,
    arms: byArm,
    independent_unit: "client_id rotates every seven days; counts do not establish unique people or independent users",
    limitations: [
      "This report is descriptive and does not establish a causal ranking effect.",
      "The client identifier rotates every seven days, so repeat use and unique people cannot be inferred across rotations.",
      "Feed-level saves are not attributed to individual event impressions.",
      "No task-completion event is present in the closed telemetry schema.",
    ],
  };
}

async function main() {
  const input = arg("input");
  const output = arg("out");
  if (!input) {
    console.error("Usage: node scripts/recommender-organic-report.mjs --input PATH [--out PATH]");
    process.exitCode = 2;
    return;
  }
  const rows = await readEventLog(resolve(root, input));
  const report = reportOrganic(rows);
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const path = resolve(root, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encoded);
  }
  process.stdout.write(encoded);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
