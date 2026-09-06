// Fetch a path from the built worker in a cold process.
//
// Importing dist/server/index.js twice in one process does not give two reads
// of the build. A cache-busting query on the entry re-evaluates the entry, but
// the chunks it lazily imports keep their own specifiers and stay cached, so a
// route that lives in one of those chunks answers with the data from the first
// build. That is how a deletion check can watch the ICS feed update while the
// board appears frozen, and conclude the board is broken when the harness is.
//
// So each fetch gets its own process. Slower, and the only way the answer means
// what it says.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function fetchBuilt(path) {
  const script = `
const { default: worker } = await import(${JSON.stringify(resolve(root, "dist/server/index.js"))});
const response = await worker.fetch(
  new Request("http://localhost" + ${JSON.stringify(path)}, { headers: { accept: "text/html" } }),
  { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } },
  { waitUntil() {}, passThroughOnException() {} },
);
process.stdout.write(await response.text());
`;
  const out = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) {
    throw new Error(`fetch ${path} failed: ${out.stderr}`);
  }
  return out.stdout;
}
