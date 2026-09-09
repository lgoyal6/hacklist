// Pull the logged events out of Analytics Engine, into a JSONL file.
//
// A LOCAL PASS. It needs a Cloudflare API token with Account Analytics: Read,
// which is a real credential, and it therefore belongs beside the other
// signed-in passes in scripts/local-passes.sh and never in GitHub Actions. See
// CONTRIBUTING.md: the local passes never run in CI, and no CI job may spend
// money. This one would not spend money (the Workers Free plan includes 10,000
// read queries a day) but it would put an account-scoped token on a runner,
// which is the same mistake with a different bill.
//
// Writes to .agent-work/ by default rather than to data/. The rows are
// anonymous, but they are also a log that grows every day, and a repository
// that accumulates one is a repository nobody can clone. Pass an explicit --out
// to put them somewhere else, and pass that path to the evaluator.
//
// With no credentials it prints how to get them and exits 0, so a checkout with
// no secrets is not a broken checkout.
//
// Run: node scripts/recommender-export-events.mjs
// Options: --out PATH --days N

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOB_COLUMNS,
  DOUBLE_COLUMNS,
  fromQueryRow,
  validateEvent,
} from "../app/telemetry-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = "hacklist_events";
const DEFAULT_OUT = ".agent-work/recommender-events.jsonl";
/** Analytics Engine keeps three months, so asking for more is asking for nothing. */
const MAX_DAYS = 90;

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
};

const HOW_TO_GET_CREDENTIALS = `
No export taken: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not both set.

This is a local pass and needs a token that can read the account's analytics:

  1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token
  2. Permissions: Account | Account Analytics | Read. Nothing else; this token
     needs no write access to anything, and should be given none.
  3. Account Resources: the account that owns the hacklist-sf Worker.
  4. Then, in your shell:

       export CLOUDFLARE_ACCOUNT_ID=...      # the account id, from the dashboard URL
       export CLOUDFLARE_API_TOKEN=...       # the token you just created
       node scripts/recommender-export-events.mjs

Keep it out of CI. The local passes never run in GitHub Actions on purpose
(CONTRIBUTING.md), and an account-scoped token on a runner is exactly the shape
of credential that rule exists to keep off one.

Reading is free on the Workers Free plan (10,000 read queries a day):
https://developers.cloudflare.com/analytics/analytics-engine/pricing/
`.trim();

/** The SQL API: POST the query as the body, authenticate with a bearer token. */
export function buildQuery(days) {
  const columns = [
    ...BLOB_COLUMNS.map((name, i) => `blob${i + 1}`),
    ...DOUBLE_COLUMNS.map((name, i) => `double${i + 1}`),
  ].join(", ");
  return `SELECT ${columns} FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY ORDER BY timestamp ASC FORMAT JSON`;
}

export async function fetchEvents({ accountId, token, days, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: buildQuery(days),
    },
  );
  if (!response.ok) {
    // Deliberately does not print the body of a failed auth response, and never
    // prints the token.
    throw new Error(
      `Analytics Engine SQL API answered ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : (payload.data ?? []);
  const events = [];
  const rejected = [];
  for (const row of rows) {
    const candidate = fromQueryRow(row);
    // Validated on the way out as well as on the way in. The dataset is
    // append-only and three months deep, so it can still hold rows written by
    // an older client than the one this checkout describes.
    const result = validateEvent(candidate, { checkClock: false });
    if (result.ok) events.push(result.event);
    else rejected.push(result.reason);
  }
  return { events, rejected };
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.log(HOW_TO_GET_CREDENTIALS);
    return;
  }

  const days = Math.min(MAX_DAYS, Number(argOf("days", 30)) || 30);
  const out = resolve(root, argOf("out", DEFAULT_OUT));
  const { events, rejected } = await fetchEvents({ accountId, token, days });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  const bySource = {};
  for (const event of events) bySource[event.source] = (bySource[event.source] ?? 0) + 1;
  console.log(`Wrote ${events.length} events from the last ${days} days to ${relative(root, out)}`);
  console.log(`By source: ${JSON.stringify(bySource)}`);
  if (rejected.length > 0) {
    console.log(
      `Skipped ${rejected.length} rows that no longer match the schema (first: ${rejected[0]})`,
    );
  }
  console.log(
    `Evaluate it with: npm run recommender:eval -- --log ${relative(root, out)}`,
  );
  console.log(
    "Only rows tagged source=web are organic. The evaluator excludes the rest from the gate.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
