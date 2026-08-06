// Telling a misconfigured source apart from a blocked one.
//
// The seed passes that go through a search engine fail in two ways that look
// identical from the outside — no seeds either way — but want opposite
// responses:
//
//   * Blocked. The engine refuses this address, which is the ordinary condition
//     on a CI runner and resolves itself when the pass next runs somewhere with
//     a residential IP. Warn; failing here would cry wolf twice a day.
//   * Misconfigured. The service quotes the credential or the request body back
//     at you. Nobody is coming to fix that on their own, and it stays broken
//     across every run until a human changes something.
//
// Getting this wrong in the quiet direction is expensive: the zone was sent
// empty for four days, the gate read a cumulative seed count instead of the
// recorded problems, and every run reported the source as healthy.
const MISCONFIGURED = /HTTP 40[01]\b|auth|not allowed|validation/i;

/**
 * Does this recorded problem mean the pass is misconfigured rather than blocked?
 *
 * Accepts either a problem object (`{ error }`, as the passes record) or a bare
 * string, because the two seed files differ in shape.
 */
export function isMisconfiguration(problem) {
  return MISCONFIGURED.test(String(problem?.error ?? problem ?? ""));
}
