// Shared scoring for sources that arrive as structured data rather than as a
// rendered page.
//
// The headless sweep scores a candidate from the text it read off the event page
// (scorePage in scripts/discover-sf.mjs). API-shaped sources — Luma's discover
// feed, Y Combinator, Devpost — never see that page, so they synthesize evidence
// text and score it here. The formula is deliberately identical to the sweep's:
// a confidence of 78 has to mean the same thing whichever source produced it, or
// the normalizer's 40% confidence weighting is comparing different units.
export function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildPatterns(config) {
  return {
    candidate: new RegExp(
      `(${config.candidateTerms.map(escapeTerm).join("|")})`,
      "i",
    ),
    place: new RegExp(
      `\\b(${config.placeTerms.map(escapeTerm).join("|")})\\b`,
      "i",
    ),
    build: /\b(build|prototype|ship|demo|project|team up|submission)\b/i,
    competition:
      /\b(prize|prizes|judg(?:e|es|ing)|winner|leaderboard|award|bounty|track)\b/i,
    negativeTitle:
      /\b(meet[-\s]?ups?|conference|summit|webinar|expo|mixer|happy hour|fireside|panel|screening|dinner|networking|workshop|office hours|pitch night|demo night|launch party|party|social|talk|talks|showcase|open house|salons?|series|roundtable|symposium|forum|town hall|book club|concert|film)\b/i,
  };
}

/** Cities the board treats as local, lowercased, from config.areas. */
export function localCitySet(config) {
  return new Set(
    Object.values(config.areas ?? {})
      .flat()
      .map((city) => city.toLowerCase()),
  );
}

export function scoreCandidate(title, evidence, patterns) {
  const combined = `${title}\n${evidence}`;
  const direct = patterns.candidate.test(combined);
  const builds = patterns.build.test(combined);
  const competes = patterns.competition.test(combined);
  const negative = patterns.negativeTitle.test(title);
  const local = patterns.place.test(combined);

  let confidence = direct ? 62 : 20;
  if (builds) confidence += 16;
  if (competes) confidence += 16;
  if (negative && !(builds && competes)) confidence -= 30;
  confidence = Math.max(0, Math.min(100, confidence));

  let relevance = Math.round(confidence * 0.65);
  if (local) relevance += 20;
  if (/\b(open|register|apply|application|request to join)\b/i.test(combined)) {
    relevance += 8;
  }
  if (/\b(prize|bount(?:y|ies)|cash|credits?)\b/i.test(combined)) relevance += 7;
  relevance = Math.max(0, Math.min(100, relevance));

  return {
    confidence,
    relevance,
    signals: {
      directHackathonTerm: direct,
      buildEvidence: builds,
      competitionEvidence: competes,
      sfBayAreaEvidence: local,
      negativeTitleEvidence: negative,
    },
  };
}

/**
 * Resolve a long-hand location string to one of the configured city names.
 * "San Francisco, California, United States" -> "San Francisco".
 */
export function resolveCity(raw, config, localCities, patterns) {
  const text = raw ?? "";
  for (const segment of text.split(",")) {
    const candidate = segment.trim();
    if (candidate && localCities.has(candidate.toLowerCase())) return candidate;
  }
  const match = text.match(patterns.place);
  if (match) {
    return match[1]
      .split(" ")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
  }
  return null;
}
