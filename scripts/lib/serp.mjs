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
