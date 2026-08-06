// Reading a search-engine response.
//
// Pure functions, no network, no top-level work, so the tests can exercise them.

/**
 * Pull result links out of a Google SERP's HTML.
 *
 * Needed because the zone type decides the response format: a Bright Data SERP
 * API zone honours brd_json=1 and returns parsed JSON, while a Web Unlocker zone
 * returns the page itself. Rejecting HTML as "not JSON" would make the whole
 * search leg silently useless on a perfectly good account.
 */
export function linksFromSerpHtml(html) {
  const found = [];
  // Google wraps real results in /url?q=<target>&...; the rest is its own chrome.
  for (const match of String(html).matchAll(/\/url\?q=([^&"'<>]+)/g)) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (/^https?:\/\//.test(decoded)) found.push(decoded);
    } catch {
      // skip malformed percent-encoding
    }
  }
  // Newer markup links directly; keep absolute hrefs that are not Google's own.
  for (const match of String(html).matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    if (!isGoogleOwned(match[1])) found.push(match[1]);
  }
  return [...new Set(found)];
}

function isGoogleOwned(url) {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*(?:google|gstatic|googleusercontent|youtube|googleapis|schema)\.[a-z.]+/i.test(
    url,
  );
}

/**
 * Normalize a Bright Data /request response into a list of result URLs,
 * whichever shape the zone produced.
 */
export function serpResults(text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not a SERP-API zone; read the page instead.
  }
  const organic = body?.organic ?? body?.results?.organic ?? null;
  if (Array.isArray(organic)) {
    return organic
      .filter((result) => result.link ?? result.url)
      .map((result) => ({
        link: result.link ?? result.url,
        text: `${result.title ?? ""} ${result.description ?? result.snippet ?? ""}`.trim(),
      }));
  }
  // HTML zone: links only, no snippets.
  return linksFromSerpHtml(text).map((link) => ({ link, text: "" }));
}

const BRIGHTDATA_ENDPOINT = "https://api.brightdata.com/request";

/**
 * One search through Bright Data's SERP API.
 *
 * Details that cost live debugging to establish, all against a real zone:
 *
 *   * `format` is required in the body; omitting it is a 400.
 *   * Do NOT put brd_json in the URL. The zone carries its own data_format
 *     ("parsed_light" for a Light JSON zone), and specifying it again makes
 *     Bright Data answer 200 with an empty body and x-brd-error-code:
 *     expect_body — a success status with nothing in it.
 *   * A first attempt fails with expect_body/502 often enough to matter: Bright
 *     Data's own fetch of Google comes back empty. The retry succeeds. Without
 *     retrying, the whole leg loses queries to a transient upstream blip.
 *   * After a failed query Bright Data imposes a ~15s cooldown on that exact
 *     query and answers 429 failed_query_rejected inside it, so the retry has to
 *     wait it out rather than fire immediately.
 *   * /status reporting can_make_requests:false is not a signal — it checks
 *     proxy credentials this path does not use.
 */
export async function brightDataSearch(query, options = {}) {
  const {
    // `||`, not `??`. An unset GitHub secret does not arrive as undefined — the
    // workflow interpolates `${{ secrets.X }}` to an EMPTY STRING, which `??`
    // happily passes straight through. BRIGHTDATA_SERP_ZONE has never been set
    // as a secret, so every CI sweep since 2026-08-04 sent zone:"" and got back
    // 400 `"zone" is not allowed to be empty`, losing the whole search leg in
    // silence — the pass exits 0 by design, so the sweep just carried on.
    zone: zoneOption,
    apiKey = process.env.BRIGHTDATA_API_KEY,
    timeoutMs = 60_000,
    cooldownMs = Number(process.env.BRIGHTDATA_COOLDOWN_MS ?? 17_000),
    attempts = 2,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  // Blank is absent, wherever it came from: an unset secret, an empty line in
  // .env, or an explicitly-passed "".
  const zone = zoneOption || process.env.BRIGHTDATA_SERP_ZONE || "serp_api";

  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", query);
  target.searchParams.set("num", "20");

  let lastError = "no attempt made";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(cooldownMs);
    let response;
    try {
      response = await fetchImpl(BRIGHTDATA_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ zone, url: target.toString(), format: "raw" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = `brightdata: ${String(error).slice(0, 90)}`;
      continue;
    }
    // Bright Data reports upstream trouble in headers while still answering 200.
    const brdError = response.headers.get("x-brd-error-code");
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      lastError = `brightdata HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`;
      continue;
    }
    if (brdError || !text.trim()) {
      lastError = `brightdata ${brdError ?? "empty body"}${
        text ? `: ${text.slice(0, 100)}` : ""
      }`;
      continue;
    }
    const results = serpResults(text);
    if (results.length) return { results };
    lastError = "brightdata: response parsed to no results";
  }
  return { results: [], error: lastError };
}
