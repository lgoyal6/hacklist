// Outbound HTTP for the discovery sweep, with a destination the sweep is
// allowed to reach.
//
// Why this exists: almost every URL the sweep opens is third-party content
// rather than something this repo wrote down. discover-search hands it URLs a
// search engine returned, discover-devpost fetches the `url` field out of
// Devpost's own API records, discover-lablab and discover-sf follow anchors
// parsed out of pages they just read, and the Luma crawl expands outward from
// link text. Anyone who can get a URL into one of those places chooses where
// this process connects.
//
// Checking the URL string is not the control it looks like, and the sweep's own
// reproduction says so. `fetch(url, { redirect: "follow" })` was given a public
// host that answered 302 to an internal address, followed it, and handed the
// internal service's body back to the classifier as page evidence. A name check
// never saw the second URL. DNS is the same hole from the other side: a
// perfectly ordinary hostname is free to resolve to 169.254.169.254.
//
// So the check is on the address, at the point the socket is about to be
// opened, on every hop:
//
//   1. IP literals in the URL are classified before connecting. net.connect
//      skips the `lookup` hook entirely when the host is already an address,
//      so layer 2 never sees http://127.0.0.1/.
//   2. `lookup` classifies every address DNS returned, before the connection
//      is attempted, and refuses the name if none of them is routable.
//   3. socket.remoteAddress is classified once the connection is up and torn
//      down before a byte of the request is written. This is the layer that
//      holds when the other two are wrong: a rebind between lookup and connect,
//      a proxy, a redirect handled somewhere this file did not expect.
//
// Redirects are followed here rather than by the transport so every hop faces
// all three layers, and so credentials can be dropped when the origin changes.
//
// Honest scope: these scripts run in GitHub Actions, not in a request-serving
// process, so there is no session to ride and no VPC of internal services to
// pivot into. The metadata endpoint of a hosted runner is the sharpest thing in
// reach, and the classifier publishing whatever it read is the other. That is a
// smaller blast radius than the same bug in a server, and it is still a fetcher
// that will follow a stranger's redirect to 169.254.169.254 and print what it
// finds.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  constants as zlibConstants,
} from "node:zlib";

/** Schemes an event page can plausibly live behind. Everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Wire bytes and decoded bytes are capped separately on purpose. A 60KB gzip of
// zeros is a perfectly ordinary-sized response until it is decompressed, and the
// reproduction expanded one to 60MB and took the process to 287MB RSS. Capping
// only the wire would not have stopped it, and capping only the decoded size
// would still let a plain 12MB page through the socket first.
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 24 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Headers that describe the request rather than authenticate this process.
// Everything else is dropped when a redirect changes the origin.
//
// That is the opposite default from the fetch spec's, which names three headers
// (authorization, cookie, proxy-authorization) and forwards the rest. Measured
// against a local fixture, node's fetch does drop those three and carries
// `x-api-key` and `x-subscription-token` to the new origin intact, because the
// spec says nothing about them. Listing the ones to drop only works while
// someone remembers to extend the list: this repo already sends a fourth key
// header, `x-luma-api-key`, from sync-luma-calendar. An allowlist is the rule
// that does not need maintaining, and nothing the sweep sends outside this set
// has any business surviving a stranger's redirect.
const FORWARDABLE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  // Kept because a 307 or 308 preserves the method and body, and a POST that
  // arrives without its content-type is a different request.
  "content-length",
  "content-type",
  "host",
  "user-agent",
]);

const digits = (text, radix) => Number.parseInt(text, radix);

/** The four octets of a dotted-quad, or null if it is not one. */
function ipv4Bytes(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? digits(part, 10) : -1));
  return bytes.every((value) => value >= 0 && value <= 255) ? bytes : null;
}

/** The sixteen bytes of an IPv6 address, or null if it is not one. */
function ipv6Bytes(text) {
  // A zone index ("fe80::1%en0") names an interface, not part of the address.
  let addr = text.split("%")[0];
  if (addr.includes(".")) {
    // "::ffff:127.0.0.1" and "64:ff9b::1.2.3.4" write their last two groups as
    // an IPv4 address. Rewriting those groups as hex, rather than peeling them
    // off, keeps any "::" in the remaining text intact.
    const cut = addr.lastIndexOf(":");
    if (cut < 0) return null;
    const quad = ipv4Bytes(addr.slice(cut + 1));
    if (!quad) return null;
    const group = (high, low) => ((high << 8) | low).toString(16);
    addr = `${addr.slice(0, cut + 1)}${group(quad[0], quad[1])}:${group(quad[2], quad[3])}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const groups = [
    ...head,
    ...Array(8 - head.length - tail.length).fill("0"),
    ...tail,
  ];
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = digits(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** Why this IPv4 address is not somewhere the sweep may connect, or null. */
function refuseIpv4(bytes) {
  const [a, b] = bytes;
  if (a === 0) return "unspecified or this-network address";
  if (a === 127) return "loopback address";
  if (a === 10) return "private address";
  if (a === 172 && b >= 16 && b <= 31) return "private address";
  if (a === 192 && b === 168) return "private address";
  if (a === 169 && b === 254) return "link-local address (cloud metadata range)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT address";
  if (a === 192 && b === 0 && bytes[2] === 0) return "IETF protocol assignment";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking address";
  if (a >= 224) return "multicast or reserved address";
  return null;
}

/** Why this IPv6 address is not somewhere the sweep may connect, or null. */
function refuseIpv6(bytes) {
  const zeroPrefix = (count) => bytes.slice(0, count).every((value) => value === 0);
  if (bytes.every((value) => value === 0)) return "unspecified address";
  if (zeroPrefix(15) && bytes[15] === 1) return "loopback address";
  // An IPv4-mapped or NAT64-translated address is a route to that IPv4 address,
  // so it gets that address's answer rather than a pass for being IPv6.
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return refuseIpv4(bytes.slice(12));
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  ) {
    return refuseIpv4(bytes.slice(12));
  }
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((v) => v === 0)) {
    return "discard-only address";
  }
  if ((bytes[0] & 0xfe) === 0xfc) return "unique local address";
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local address";
  if (bytes[0] === 0xff) return "multicast address";
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return "documentation address";
  }
  return null;
}

/**
 * Why the sweep may not connect to this address, or null if it may.
 *
 * Exported because it is the whole policy, and a policy worth having is worth
 * testing directly rather than only through a socket.
 */
export function refuseAddress(address) {
  const text = String(address ?? "");
  const family = isIP(text);
  if (family === 4) {
    const bytes = ipv4Bytes(text);
    return bytes ? refuseIpv4(bytes) : "unparseable address";
  }
  if (family === 6) {
    const bytes = ipv6Bytes(text);
    return bytes ? refuseIpv6(bytes) : "unparseable address";
  }
  return "not an IP address";
}

/** A refusal the caller can tell apart from an ordinary network failure. */
export class BlockedRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedRequestError";
    this.blocked = true;
  }
}

const sameOrigin = (a, b) =>
  a.protocol === b.protocol && a.host === b.host;

function decompressorFor(encoding) {
  const name = String(encoding ?? "").trim().toLowerCase();
  if (name === "gzip" || name === "x-gzip") return createGunzip();
  if (name === "deflate") return createInflate();
  if (name === "br") {
    // Tell Brotli the ceiling up front so a bomb is refused by the decoder
    // rather than after it has already allocated its way past the cap.
    return createBrotliDecompress({
      params: { [zlibConstants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 0 },
    });
  }
  return null;
}

/** The body, refusing anything that exceeds either cap while it streams. */
function readBody(response, { maxWireBytes, maxDecodedBytes }) {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxWireBytes) {
      response.destroy();
      reject(
        new BlockedRequestError(
          `response declares ${declared} bytes, over the ${maxWireBytes} byte cap`,
        ),
      );
      return;
    }
    const decoder = decompressorFor(response.headers["content-encoding"]);
    const chunks = [];
    let wire = 0;
    let decoded = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      response.destroy();
      decoder?.destroy();
      reject(error);
    };
    response.on("data", (chunk) => {
      wire += chunk.length;
      if (wire > maxWireBytes) {
        fail(
          new BlockedRequestError(
            `response exceeded the ${maxWireBytes} byte cap on the wire`,
          ),
        );
      }
    });
    response.on("error", fail);
    const sink = decoder ?? response;
    if (decoder) {
      response.pipe(decoder);
      decoder.on("error", fail);
    }
    sink.on("data", (chunk) => {
      decoded += chunk.length;
      if (decoded > maxDecodedBytes) {
        fail(
          new BlockedRequestError(
            `response expanded past the ${maxDecodedBytes} byte decoded cap`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    sink.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * A fetch-shaped reader that will only connect to a globally routable address.
 *
 * `allowAddresses` is the seam the tests use, in the same spirit as the
 * `fetchImpl` argument fetchPage already takes: a machine running these tests
 * has no public address to bind a fixture to, so one loopback address is named
 * as reachable and everything else, the fixture standing in for the internal
 * service included, is judged by the real policy.
 */
export function createSafeFetch({
  allowAddresses = [],
  maxWireBytes = MAX_WIRE_BYTES,
  maxDecodedBytes = MAX_DECODED_BYTES,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  const allowed = new Set(allowAddresses);
  const refuse = (address) => (allowed.has(String(address)) ? null : refuseAddress(address));

  // Layer 2. `all: true` because a name is only safe if every address it
  // answers with is: resolving to one public and one private address and
  // picking the public one leaves the private one a race away.
  const guardedLookup = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const bad = list.find((entry) => refuse(entry.address));
      if (bad) {
        return callback(
          new BlockedRequestError(
            `${hostname} resolves to ${bad.address}: ${refuse(bad.address)}`,
          ),
        );
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };

  // Layer 3. Registered before the socket is handed to the HTTP client, so this
  // listener runs first and can tear the connection down before the request
  // line is written.
  const verifyOnConnect = (socket, request) => {
    const check = () => {
      const address = socket.remoteAddress;
      if (!address) return;
      const reason = refuse(address);
      if (!reason) return;
      const error = new BlockedRequestError(
        `connection landed on ${address}: ${reason}`,
      );
      socket.destroy(error);
      request.destroy(error);
    };
    if (socket.remoteAddress) check();
    else socket.once("connect", check);
  };

  const hop = (target, { method, headers, body, signal }) =>
    new Promise((resolve, reject) => {
      const secure = target.protocol === "https:";
      const options = {
        method,
        headers,
        // Spelled out because the default is the agent's. Without an agent
        // there is nothing holding defaultPort, and an https URL with no port
        // in it connects to 80 and fails the handshake against a plaintext
        // listener with "wrong version number".
        port: target.port || (secure ? 443 : 80),
        // No agent, deliberately, and not `agent: false` either: http.request
        // only honours options.createConnection when options.agent is left
        // undefined, and `false` quietly substitutes a fresh pooling agent that
        // would open the socket itself and never see the check below. The
        // absence of a pool is wanted too. A pooled socket is classified once,
        // for whichever request opened it, and reusing it hands a later request
        // a connection this file never judged.
        createConnection: (connectOptions) => {
          const base = { ...connectOptions, lookup: guardedLookup };
          return secure
            ? tlsConnect({ ...base, servername: target.hostname })
            : netConnect(base);
        },
      };
      const send = secure ? httpsRequest : httpRequest;
      const request = send(target, options, (response) => resolve({ request, response }));
      request.on("socket", (socket) => verifyOnConnect(socket, request));
      request.on("error", reject);
      if (signal) {
        if (signal.aborted) {
          request.destroy(signal.reason ?? new Error("aborted"));
        } else {
          signal.addEventListener(
            "abort",
            () => request.destroy(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        }
      }
      if (body !== undefined && body !== null) request.write(body);
      request.end();
    });

  return async function safeFetch(input, init = {}) {
    let target;
    try {
      target = new URL(String(input));
    } catch {
      throw new BlockedRequestError(`not a URL: ${String(input).slice(0, 80)}`);
    }
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    const headers = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (value !== undefined && value !== null) headers[key.toLowerCase()] = String(value);
    }
    if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";

    for (let redirects = 0; ; redirects += 1) {
      if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
        throw new BlockedRequestError(`unsupported scheme ${target.protocol}`);
      }
      // Layer 1. An IP literal never reaches the lookup hook, because
      // net.connect resolves nothing when it is handed an address.
      if (isIP(target.hostname.replace(/^\[|\]$/g, ""))) {
        const reason = refuse(target.hostname.replace(/^\[|\]$/g, ""));
        if (reason) {
          throw new BlockedRequestError(`refusing ${target.hostname}: ${reason}`);
        }
      }
      headers.host = target.host;
      const { response } = await hop(target, {
        method,
        headers,
        body,
        signal: init.signal,
      });
      const location = response.headers.location;
      const isRedirect =
        response.statusCode >= 300 && response.statusCode <= 399 && location;
      if (!isRedirect || init.redirect === "manual") {
        const buffer = await readBody(response, { maxWireBytes, maxDecodedBytes });
        return makeResponse(target, response, buffer);
      }
      response.resume();
      if (redirects >= maxRedirects) {
        throw new BlockedRequestError(`more than ${maxRedirects} redirects`);
      }
      let next;
      try {
        next = new URL(location, target);
      } catch {
        throw new BlockedRequestError(`unparseable redirect to ${String(location).slice(0, 80)}`);
      }
      if (!sameOrigin(next, target)) {
        // The new origin was not the one this process authenticated to, and a
        // redirect is the attacker's choice of recipient.
        for (const name of Object.keys(headers)) {
          if (!FORWARDABLE_HEADERS.has(name)) delete headers[name];
        }
      }
      if (response.statusCode === 303 || (method === "POST" && response.statusCode < 307)) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      target = next;
    }
  };
}

function makeResponse(url, response, buffer) {
  const status = response.statusCode;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: response.statusMessage ?? "",
    url: url.toString(),
    redirected: false,
    headers: {
      get: (name) => {
        const value = response.headers[String(name).toLowerCase()];
        return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
      },
      has: (name) => response.headers[String(name).toLowerCase()] !== undefined,
    },
    text: async () => buffer.toString("utf8"),
    json: async () => JSON.parse(buffer.toString("utf8")),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

/** The reader every unattended fetch in the sweep goes through. */
export const safeFetch = createSafeFetch();
