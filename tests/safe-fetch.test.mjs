// Tests for where the sweep is allowed to connect.
//
// Every assertion that matters here is about a fixture server's hit count
// rather than about an error message, because the bug this closes was not "a
// URL looked wrong". It was a request arriving. Before the guard existed,
// fetchPage() given a public host that answered 302 to an internal one followed
// the redirect, and the internal fixture recorded the hit and handed its body
// back as page evidence.
//
// The seam: a machine running these tests has no globally routable address to
// bind a fixture to, so the "public" side of a redirect has to be loopback too.
// createSafeFetch({ allowAddresses }) names exactly one loopback address as
// reachable. The destination on the other side of the redirect is [::1], which
// no test names, so it is refused by the production policy rather than by a
// test-only rule.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { fetchPage } from "../scripts/lib/page-http.mjs";
import { createSafeFetch, refuseAddress, safeFetch } from "../scripts/lib/safe-fetch.mjs";

/** A server that records every request that reaches it. */
function fixture(host, handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = createServer((request, response) => {
      hits.push({ url: request.url, headers: request.headers });
      handler(request, response);
    });
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        hits,
        port,
        origin: host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const html = (body) => (request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(body);
};

const refused = async (run) => {
  const error = await run().then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error, "expected the request to be refused");
  return error;
};

test("the address policy answers for every range a fetcher can be pointed at", () => {
  const refusals = {
    "127.0.0.1": "loopback",
    "127.1.1.1": "loopback",
    "169.254.169.254": "link-local",
    "10.0.0.7": "private",
    "172.16.5.4": "private",
    "192.168.1.1": "private",
    "100.64.0.1": "carrier-grade",
    "0.0.0.0": "unspecified",
    "::1": "loopback",
    "::": "unspecified",
    "fd12:3456::1": "unique local",
    "fe80::1": "link-local",
    // An IPv4-mapped address is a route to that IPv4 address, not a way around
    // its answer.
    "::ffff:127.0.0.1": "loopback",
    "::ffff:169.254.169.254": "link-local",
    "64:ff9b::10.0.0.1": "private",
  };
  for (const [address, expected] of Object.entries(refusals)) {
    const reason = refuseAddress(address);
    assert.ok(reason, `${address} should be refused`);
    assert.match(reason, new RegExp(expected, "i"), `${address}: ${reason}`);
  }
  // Public addresses stay reachable, or the sweep reads nothing at all.
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(refuseAddress(address), null, address);
  }
});

test("a private destination is never connected to, by literal or by name", async () => {
  const internal = await fixture("127.0.0.1", html("<title>internal admin</title>"));
  const v6 = await fixture("::1", html("<title>metadata</title>"));
  try {
    // An IP literal never reaches a DNS hook, so this is the case a lookup-only
    // guard misses.
    await refused(() => fetchPage(`${internal.origin}/admin`, { timeoutMs: 5_000 }));
    // "localhost" is a name, and the name is innocuous. Only the address it
    // resolves to says anything.
    await refused(() =>
      fetchPage(`http://localhost:${internal.port}/admin`, { timeoutMs: 5_000 }),
    );
    await refused(() => fetchPage(`${v6.origin}/latest/meta-data/`, { timeoutMs: 5_000 }));

    assert.equal(internal.hits.length, 0, "loopback fixture must not have been reached");
    assert.equal(v6.hits.length, 0, "[::1] fixture must not have been reached");
  } finally {
    await internal.close();
    await v6.close();
  }
});

// The three address layers overlap on purpose, and a test that only asks
// "was it refused" cannot tell which one did it. Deleting layer 3 and deleting
// layers 1 and 2 both left the rest of this file green, which says the
// overlap was untested rather than that any layer was spare. Each case below
// is one only its own layer can answer.
test("each address layer refuses on its own, not by leaning on the others", async () => {
  // A port with nothing behind it. Layers 1 and 2 answer before a connection
  // is attempted, so the absence of a listener is not what refuses these two:
  // a socket-only guard would report ECONNREFUSED instead.
  const idle = await fixture("127.0.0.1", html("<title>unreachable</title>"));
  const closedPort = idle.port;
  await idle.close();

  // Layer 1: an IP literal, which never reaches a DNS hook.
  const literal = await refused(() => safeFetch(`http://127.0.0.1:${closedPort}/`));
  assert.match(String(literal.message), /^refusing 127\.0\.0\.1: loopback/);

  // Layer 2: a name, which layer 1 has nothing to say about.
  const name = await refused(() => safeFetch(`http://localhost:${closedPort}/`));
  assert.match(String(name.message), /^localhost resolves to .+: loopback/);

  // Layer 3: the address in the URL and the address the socket lands on are
  // not the same string. "[::ffff:127.0.0.1]" is normalized to "::ffff:7f00:1"
  // by the URL parser and reported back by the kernel as "::ffff:127.0.0.1",
  // so an allowlist that satisfies layer 1 says nothing about where the
  // connection actually went. Layer 2 does not run at all for a literal.
  const target = await fixture("127.0.0.1", html("<title>landed</title>"));
  const seam = createSafeFetch({ allowAddresses: ["::ffff:7f00:1"] });
  try {
    const socket = await refused(() =>
      seam(`http://[::ffff:127.0.0.1]:${target.port}/probe`),
    );
    assert.match(String(socket.message), /^connection landed on .+: loopback/);
    assert.equal(target.hits.length, 0, "torn down before the request was written");
  } finally {
    await target.close();
  }
});

test("a redirect that starts public and lands private is refused at the hop", async () => {
  // Stands in for a cloud metadata endpoint: reachable, and holding something
  // worth reading.
  const internal = await fixture("::1", html("<title>metadata</title>AKIAEXAMPLE"));
  const public_ = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(302, { location: `http://[::1]:${internal.port}/latest/meta-data/` });
    response.end();
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    const error = await refused(() =>
      fetchPage(`${public_.origin}/hackathon`, { timeoutMs: 5_000, fetchImpl }),
    );
    assert.match(String(error), /loopback/);
    assert.equal(public_.hits.length, 1, "the public hop is a normal read");
    assert.equal(internal.hits.length, 0, "nothing may reach the internal fixture");
  } finally {
    await internal.close();
    await public_.close();
  }
});

test("a redirect chain is refused at whichever hop turns private", async () => {
  const internal = await fixture("::1", html("<title>metadata</title>"));
  let hopTwoPort = 0;
  const hopTwo = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(302, { location: `http://[::1]:${internal.port}/` });
    response.end();
  });
  hopTwoPort = hopTwo.port;
  const hopOne = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${hopTwoPort}/next` });
    response.end();
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    await refused(() => fetchPage(`${hopOne.origin}/start`, { timeoutMs: 5_000, fetchImpl }));
    assert.equal(hopOne.hits.length, 1);
    assert.equal(hopTwo.hits.length, 1, "a public second hop is followed");
    assert.equal(internal.hits.length, 0, "the private third hop is not");
  } finally {
    await internal.close();
    await hopTwo.close();
    await hopOne.close();
  }
});

test("a redirect loop stops rather than running forever", async () => {
  let self;
  self = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${self.port}/again` });
    response.end();
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"], maxRedirects: 3 });
  try {
    const error = await refused(() => fetchImpl(`${self.origin}/start`));
    assert.match(String(error), /more than 3 redirects/);
    assert.equal(self.hits.length, 4, "the first read plus its three redirects");
  } finally {
    await self.close();
  }
});

test("schemes that are not the web are refused before anything is opened", async () => {
  for (const url of [
    "file:///etc/passwd",
    "gopher://127.0.0.1:70/1",
    "ftp://example.com/x",
    "data:text/html,<title>x</title>",
  ]) {
    const error = await refused(() => safeFetch(url));
    assert.match(String(error), /unsupported scheme/, url);
  }
});

test("credentials are dropped when a redirect changes the origin", async () => {
  // Different port, same host: a different origin, and a different recipient.
  const other = await fixture("127.0.0.1", html("<title>elsewhere</title>"));
  const start = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${other.port}/landed` });
    response.end();
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    await fetchImpl(`${start.origin}/start`, {
      headers: {
        authorization: "Bearer BRIGHTDATA-KEY",
        cookie: "luma.auth-session-key=secret",
        // Not headers the fetch spec knows about, so nothing strips them for
        // free. This repo sends x-api-key to Serper, x-subscription-token to
        // Brave, and x-luma-api-key from the calendar sync; the last one is
        // here because it is exactly the header an enumerated deny list would
        // have missed.
        "x-api-key": "SERPER-KEY",
        "x-subscription-token": "BRAVE-KEY",
        "x-luma-api-key": "LUMA-KEY",
        "x-hacklist-invented-tomorrow": "FUTURE-KEY",
        accept: "text/html",
      },
    });
    const sent = other.hits[0].headers;
    assert.equal(sent.authorization, undefined);
    assert.equal(sent.cookie, undefined);
    assert.equal(sent["x-api-key"], undefined);
    assert.equal(sent["x-subscription-token"], undefined);
    assert.equal(sent["x-luma-api-key"], undefined);
    assert.equal(sent["x-hacklist-invented-tomorrow"], undefined);
    // Everything that describes the request still travels, or the read changes.
    assert.equal(sent.accept, "text/html");
    assert.equal(sent.host, `127.0.0.1:${other.port}`);
  } finally {
    await start.close();
    await other.close();
  }
});

test("credentials survive a redirect that stays on the same origin", async () => {
  const server = await fixture("127.0.0.1", (request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/landed" });
      return response.end();
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>same origin</title>");
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    await fetchImpl(`${server.origin}/start`, {
      headers: { authorization: "Bearer BRIGHTDATA-KEY" },
    });
    assert.equal(server.hits[1].headers.authorization, "Bearer BRIGHTDATA-KEY");
  } finally {
    await server.close();
  }
});

test("an oversized response is refused rather than buffered", async () => {
  const huge = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    // Chunked, so the cap cannot lean on a declared content-length.
    for (let sent = 0; sent < 40; sent += 1) response.write("A".repeat(256 * 1024));
    response.end();
  });
  const fetchImpl = createSafeFetch({
    allowAddresses: ["127.0.0.1"],
    maxWireBytes: 512 * 1024,
  });
  try {
    const error = await refused(() => fetchImpl(`${huge.origin}/`));
    assert.match(String(error), /cap on the wire/);
  } finally {
    await huge.close();
  }
});

test("a response that declares an oversized length is refused before reading it", async () => {
  const body = "A".repeat(600 * 1024);
  const huge = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  const fetchImpl = createSafeFetch({
    allowAddresses: ["127.0.0.1"],
    maxWireBytes: 512 * 1024,
  });
  try {
    const error = await refused(() => fetchImpl(`${huge.origin}/`));
    assert.match(String(error), /declares \d+ bytes/);
  } finally {
    await huge.close();
  }
});

test("a decompression bomb is refused on its decoded size, not its wire size", async () => {
  const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x41));
  const zip = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    response.end(bomb);
  });
  const fetchImpl = createSafeFetch({
    allowAddresses: ["127.0.0.1"],
    // Comfortably above what arrives on the wire, so only the decoded cap can
    // be what refuses this.
    maxWireBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 2 * 1024 * 1024,
  });
  try {
    assert.ok(bomb.length < 1024 * 1024, `bomb is ${bomb.length} bytes on the wire`);
    const error = await refused(() => fetchImpl(`${zip.origin}/`));
    assert.match(String(error), /decoded cap/);
  } finally {
    await zip.close();
  }
});

test("an allowed source is still read, compressed or not", async () => {
  const server = await fixture("127.0.0.1", (request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      return response.end(gzipSync(Buffer.from("<title>Some Hackathon</title>")));
    }
    if (request.url === "/moved") {
      response.writeHead(301, { location: "/final" });
      return response.end();
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Some Hackathon</title><a href=\"/x\">Register</a>");
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    const plain = await fetchPage(`${server.origin}/final`, { fetchImpl, timeoutMs: 5_000 });
    assert.equal(plain.title, "Some Hackathon");
    assert.deepEqual(plain.links, [{ href: "/x", text: "Register" }]);

    const compressed = await fetchImpl(`${server.origin}/gzip`);
    assert.equal(await compressed.text(), "<title>Some Hackathon</title>");
    assert.equal(compressed.headers.get("Content-Type"), "text/html");
    assert.equal(compressed.ok, true);

    const redirected = await fetchPage(`${server.origin}/moved`, {
      fetchImpl,
      timeoutMs: 5_000,
    });
    assert.equal(redirected.title, "Some Hackathon");
  } finally {
    await server.close();
  }
});

test("a non-2xx answer still reads as a status rather than as a refusal", async () => {
  const server = await fixture("127.0.0.1", (request, response) => {
    response.writeHead(429, { "content-type": "text/html" });
    response.end("slow down");
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    const response = await fetchImpl(`${server.origin}/`);
    assert.equal(response.ok, false);
    assert.equal(response.status, 429);
    // The pacer's back-off depends on this text, so it has to survive the swap.
    const error = await refused(() => fetchPage(`${server.origin}/`, { fetchImpl }));
    assert.match(String(error), /HTTP 429/);
  } finally {
    await server.close();
  }
});

test("a POST body and its JSON answer survive the swap", async () => {
  const server = await fixture("127.0.0.1", (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ echoed: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    const response = await fetchImpl(`${server.origin}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zone: "unlocker", url: "https://luma.com/x" }),
    });
    assert.deepEqual(await response.json(), {
      echoed: { zone: "unlocker", url: "https://luma.com/x" },
    });
  } finally {
    await server.close();
  }
});

test("an abort signal still stops a read", async () => {
  const slow = await fixture("127.0.0.1", () => {
    // Never answers, which is exactly what the timeouts are for.
  });
  const fetchImpl = createSafeFetch({ allowAddresses: ["127.0.0.1"] });
  try {
    await refused(() => fetchImpl(`${slow.origin}/`, { signal: AbortSignal.timeout(300) }));
  } finally {
    await slow.close();
  }
});
