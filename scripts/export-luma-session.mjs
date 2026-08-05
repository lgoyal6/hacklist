// Export the Luma session from the local profile, so the passes that need a
// signed-in browser can run somewhere that has no profile — CI included.
//
// Prints a JSON array of cookies to stdout and nothing else, so it can be piped
// straight into a secret without the value ever appearing on screen:
//
//   npm run luma:export-session | gh secret set LUMA_SESSION_COOKIES
//
// Only the cookies that constitute the session are exported:
//
//   luma.auth-session-key   the session itself
//   luma.did                the device id Luma pairs with it
//
// Cloudflare's cookies are deliberately excluded. __cf_bm lives about half an
// hour, and cf_clearance is bound to the IP and user agent that earned it, so
// replaying either from a datacenter is worse than letting that machine earn its
// own — a stale clearance token looks to Cloudflare like exactly the thing it is
// built to stop.
//
// This is a real credential. Whoever holds it can act as this account on Luma,
// not merely on one calendar. It goes in an encrypted secret and nowhere else,
// and `luma.auth-session-key` currently runs to September 2027, so this is not a
// weekly chore.
import { launchLocalBrowser, isSignedIn } from "./lib/local-browser.mjs";

const WANTED = new Set(["luma.auth-session-key", "luma.did"]);

// Never read a profile that is itself running on injected cookies; that would
// export whatever was handed in rather than the real profile's session.
if (process.env.LUMA_SESSION_COOKIES) {
  console.error(
    "LUMA_SESSION_COOKIES is set in this environment. Unset it and re-run, or " +
      "this would just echo back the cookies it was given.",
  );
  process.exit(1);
}

const context = await launchLocalBrowser({ headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  if (!(await isSignedIn(page))) {
    console.error(
      "The local profile is not signed in to Luma. Run `npm run luma:sync` once " +
        "headed to sign in, then export.",
    );
    process.exit(1);
  }

  const cookies = (await context.cookies()).filter((cookie) =>
    WANTED.has(cookie.name),
  );
  const missing = [...WANTED].filter(
    (name) => !cookies.some((cookie) => cookie.name === name),
  );
  if (missing.length) {
    console.error(`Missing expected cookie(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  // Normalise to exactly what Playwright's addCookies() wants, dropping anything
  // it would reject and anything that is nobody else's business.
  const exported = cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? "Lax",
  }));

  // stdout is the payload; everything explanatory goes to stderr so a pipe stays
  // clean.
  const soonest = Math.min(
    ...exported.map((cookie) => cookie.expires).filter((value) => value > 0),
  );
  console.error(
    `Exported ${exported.length} cookie(s); earliest expiry ` +
      `${new Date(soonest * 1000).toISOString().slice(0, 10)}.`,
  );
  process.stdout.write(JSON.stringify(exported));
} finally {
  await context.close();
}
