// POST /api/events: the only thing that writes a reader's behaviour anywhere.
//
// Plain .mjs so the node:test suite exercises this exact handler rather than a
// re-implementation of it, the same reason app/i18n/dates.mjs is .mjs.
//
// Three things this file deliberately does not do:
//
// - It never reads the request's address, user-agent or referrer. Not "reads
//   them and discards them": the strings never enter a variable. Cloudflare
//   puts CF-Connecting-IP and request.cf on every request, so the only reason
//   they are absent from the stored row is that nothing here asks for them.
// - It never logs the payload. A console.log in a Worker is a durable log line,
//   which would make the log a second copy of the data with none of the rules.
// - It never counts anything per client. The client id is random and rotates,
//   so a per-client limit would be both trivially evaded and the one piece of
//   per-person state this design refuses to keep. The limits are on the size of
//   a single request: bytes, then batch length. No bans, no deny list, nothing
//   that could punish an account.

import {
  MAX_BODY_BYTES,
  toDataPoint,
  validateBatch,
} from "../app/telemetry-schema.mjs";

export const EVENTS_PATH = "/api/events";

/**
 * Where validated events go.
 *
 * Two implementations and no flag between them. Which one is in use is decided
 * by whether the binding exists in the environment the Worker was actually
 * deployed with: capability detection, not configuration. `wrangler dev`
 * without the binding, a unit test, and a preview built before the binding
 * landed all get the null sink and a 204, which keeps the board working and
 * stores nothing.
 */
export const nullSink = Object.freeze({
  kind: "none",
  write() {},
});

export function analyticsEngineSink(dataset) {
  return {
    kind: "analytics-engine",
    write(point) {
      dataset.writeDataPoint(point);
    },
  };
}

export function sinkFor(env) {
  const dataset = env?.EVENTS;
  if (dataset && typeof dataset.writeDataPoint === "function") {
    return analyticsEngineSink(dataset);
  }
  return nullSink;
}

const refuse = (status, reason) =>
  new Response(`${reason}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * @param {Request} request
 * @param {{EVENTS?: {writeDataPoint(point: object): void}}} env
 * @param {{now?: number, sink?: {write(point: object): void}}} [options]
 */
export async function handleEventsRequest(request, env, options = {}) {
  if (request.method !== "POST") {
    return refuse(405, "POST only");
  }

  // sendBeacon posts text/plain by default and fetch keepalive posts JSON. Both
  // are the same body; anything else is not this client.
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (contentType && !["application/json", "text/plain"].includes(contentType)) {
    return refuse(415, `unsupported content-type: ${contentType}`);
  }

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(413, `body of ${declared} bytes exceeds ${MAX_BODY_BYTES}`);
  }

  const text = await request.text();
  // Checked again after reading: content-length is a claim, not a fact.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BODY_BYTES) {
    return refuse(413, `body of ${bytes} bytes exceeds ${MAX_BODY_BYTES}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "body is not JSON");
  }

  const validated = validateBatch(body, { now: options.now ?? Date.now() });
  if (!validated.ok) {
    return refuse(400, validated.reason);
  }

  const sink = options.sink ?? sinkFor(env);
  for (const event of validated.events) {
    sink.write(toDataPoint(event));
  }

  // 204 whether the sink stored anything or not. The browser has no business
  // knowing which sink is behind this, and a beacon has nowhere to put a body.
  return new Response(null, { status: 204 });
}
