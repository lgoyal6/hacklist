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

// Organisers invent a new "-a-thon" every week (dog-a-thon, make-a-thon,
// print-a-thon), so match the shape rather than trying to list them. The
// separator before "a" is required so this does not fire on "marathon".
const ATHON = /\b[a-z]{3,}[-\s]a[-\s]?thon\b/i;

// "Hack" on its own is a format word in a name -- "Himalaya Robotics Hack",
// "Open Model Hack", "Mango Hacks" -- but not in body text, where "hack" is a
// verb and "hacks" is a listicle. So it is matched against names only, via
// namesHackathonFormat, and never folded into the vocabulary used on page text.
//
// Kept honest by measurement rather than taste: across the 949 events in Luma's
// SF feed it admits five names the vocabulary misses, four of them real
// hackathons (Open Model Hack, Mango Hacks, FutureForge Hacks, Recursive Self
// Improvement Hack) and one that is not (Hack The Bot And Build Your Career).
const STANDALONE_HACK = /\bhacks?\b/i;

export function buildPatterns(config) {
  // Word boundaries, plus an optional plural. The boundaries matter: without
  // them "hackathonic" and any substring counts. The plural matters too --
  // "Hackathons, all around the world" is a calendar's own description of
  // itself, and a scorer that could not see it read a real hackathon as a
  // 52 against a bar of 54.
  const vocabulary = new RegExp(
    `\\b(${config.candidateTerms.map(escapeTerm).join("|")})s?\\b`,
    "i",
  );
  return {
    // An object rather than a RegExp because two shapes have to agree here, and
    // every caller only ever asks `.test()`. One definition, so a confidence of
    // 78 means the same thing whichever pass produced it.
    candidate: {
      source: vocabulary.source,
      test: (text) => vocabulary.test(text) || ATHON.test(text),
    },
    titleFormat: STANDALONE_HACK,
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

/**
 * Does this name say "hackathon", in any of the ways organisers write it?
 *
 * Names get a wider vocabulary than body text, because a name is a claim about
 * the format and a passing mention is not.
 */
export function namesHackathonFormat(name, patterns) {
  const text = name ?? "";
  return patterns.candidate.test(text) || patterns.titleFormat.test(text);
}

export function scoreCandidate(title, evidence, patterns) {
  const combined = `${title}\n${evidence}`;
  const direct =
    patterns.candidate.test(combined) || patterns.titleFormat.test(title ?? "");
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
 * Whether a structured location names a region the board does not serve.
 *
 * schema.org's addressRegion is the event's own statement of where it is, and it
 * outranks any place term read out of page text. A host blurb listing the cities
 * a community spans -- "Singapore, Tokyo, Seoul, and San Francisco Bay Area" --
 * reads as local to a text scan while the address underneath says South Korea,
 * which is how a Seoul hackathon was once published as an SF one. Every source
 * that reports a region at all reports California for a Bay Area event, so a
 * region that is not California is a statement that the event is elsewhere.
 *
 * An absent region is not evidence either way: "Online Event", "TBD - South Bay"
 * and a bare venue name all arrive without one, so those are left to the
 * caller's other checks rather than being refused here.
 */
export function namesNonLocalRegion(location) {
  const region = location?.region?.trim();
  if (!region) return false;
  return !/^(CA|California)$/i.test(region);
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
