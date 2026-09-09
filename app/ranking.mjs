// The board's ordering, its features, and the ranker that proposes a second
// ordering. One implementation, shared by the page, the tests, the trainer and
// the evaluator, for the same reason app/i18n/dates.mjs is shared: an ordering
// re-implemented in a script is an ordering nobody has actually measured.
//
// Plain .mjs rather than .ts so the node:test suites can exercise the exact
// code the page renders.
//
// Three rules hold this file together, and each one has a test:
//
// 1. `boardVisible` IS the board's list. app/board.tsx calls it; nothing
//    re-derives the filter or the sort anywhere else. results/recommender-manifest.json
//    carries a snapshot of its output on the committed data/events.json, and a
//    test compares the two.
// 2. Every feature is knowable at render time. A feature that reads engagement,
//    or anything else the future writes onto an event, is leakage; the field
//    allow-list below is what the leakage detector perturbs to prove it.
// 3. Nothing here reads a clock, a locale, or a random source it was not handed.
//    Determinism is the whole reason an interleaved draft can be evaluated.

/** The view the board opens on. */
export const BOARD_DEFAULT_VIEW = "hackathons";

/** The region an event is published under, defaulting the way the feed does. */
export const regionOf = (event, defaultRegion) => event.region ?? defaultRegion;

/**
 * The board's visible list: filter, then sort, exactly as app/board.tsx does.
 *
 * `asOf` is the render instant. The board reads it once on mount rather than
 * during render, so an event that finished since the sweep drops off when it is
 * over rather than when the next sweep runs; the same instant is what an
 * impression records, which is what makes "days until start" a render-time
 * feature and not a guess.
 */
export function boardVisible(events, options) {
  const {
    regionKey,
    coreArea = null,
    defaultRegion,
    view = BOARD_DEFAULT_VIEW,
    query = "",
    asOf,
  } = options;
  const needle = query.trim().toLowerCase();
  return events
    .filter((event) => regionOf(event, defaultRegion) === regionKey)
    .filter((event) => {
      const over = Date.parse(event.end ?? event.start ?? "");
      if (Number.isFinite(over) && over < asOf) return false;
      return true;
    })
    .filter((event) => {
      const haystack = `${event.title} ${event.organizer} ${event.tags.join(" ")} ${event.city ?? ""}`;
      if (needle && !haystack.toLowerCase().includes(needle)) return false;
      if (view === "hackathons") return event.category === "hackathon";
      if (view === "open") return ["Open", "Approval"].includes(event.status);
      if (view === "prizes") return event.prize.includes("$");
      if (view === "city") return event.area === coreArea;
      return true;
    })
    .sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999"));
}

/**
 * The production ordering: the board's first paint, on the default region, in
 * the default view, with no search. This is the frozen baseline every other
 * ordering is measured against.
 *
 * @param {{meta: {defaultRegion: string, regions: Array<{key: string, coreArea: string|null}>}, events: Array<object>}} data
 */
export function productionOrder(data, { asOf }) {
  const defaultRegion = data.meta.defaultRegion;
  const region =
    data.meta.regions.find((entry) => entry.key === defaultRegion) ??
    data.meta.regions[0];
  return boardVisible(data.events, {
    regionKey: region.key,
    coreArea: region.coreArea,
    defaultRegion,
    view: BOARD_DEFAULT_VIEW,
    query: "",
    asOf,
  });
}

/** The production ordering as ids, which is what the manifest freezes. */
export const productionOrderIds = (data, options) =>
  productionOrder(data, options).map((event) => event.id);

// --- features ---
//
// Ranking-time only. Every entry below is a field the sweep wrote before the
// list was rendered, or a comparison against the render instant the impression
// itself records. Engagement counts are deliberately absent: a click total is
// future information relative to the impression that produced it, and a ranker
// trained on it scores itself.

/**
 * The only event fields a feature may read. The leakage detector perturbs
 * everything else on the record and asserts the feature vector does not move,
 * so a feature that reaches for a field not named here fails the run rather
 * than quietly inflating a metric.
 */
export const RANKING_TIME_EVENT_FIELDS = Object.freeze([
  "id",
  "category",
  "platform",
  "start",
  "prize",
  "tags",
  "region",
  "status",
  "going",
  "score",
  "scores",
]);

export const FEATURE_NAMES = Object.freeze([
  "confidence",
  "builderValue",
  "accessibility",
  "freshness",
  "score",
  "isHackathon",
  "isLuma",
  "daysUntilStart",
  "daysUntilStartMissing",
  "hasPrize",
  "tagCount",
  "regionMatch",
  "statusOpen",
  "going",
  "goingMissing",
]);

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const unit = (value, max) => clamp01((Number(value) || 0) / max);

/** How far out the start is, in days, capped: a year out and a month out rank alike. */
const DAYS_HORIZON = 90;
/** Where the "going" count saturates. Above this it stops distinguishing events. */
const GOING_SATURATION = 500;
/** Where the tag count saturates. */
const TAGS_SATURATION = 6;

/**
 * One event's feature vector, in FEATURE_NAMES order.
 *
 * @param {object} event a record from data/events.json
 * @param {{asOf: number, regionKey: string, defaultRegion: string}} context
 */
export function extractFeatures(event, context) {
  const scores = event.scores ?? {};
  const startMs = event.start ? Date.parse(event.start) : Number.NaN;
  const hasStart = Number.isFinite(startMs);
  const daysUntil = hasStart ? (startMs - context.asOf) / 86400000 : 0;
  const going = event.going;
  const goingKnown = typeof going === "number" && Number.isFinite(going);
  return [
    unit(scores.confidence, 100),
    unit(scores.builderValue, 100),
    unit(scores.accessibility, 100),
    unit(scores.freshness, 100),
    unit(event.score, 100),
    event.category === "hackathon" ? 1 : 0,
    event.platform === "luma" ? 1 : 0,
    hasStart ? unit(daysUntil, DAYS_HORIZON) : 0,
    hasStart ? 0 : 1,
    typeof event.prize === "string" &&
    event.prize.length > 0 &&
    event.prize !== "Not listed"
      ? 1
      : 0,
    unit((event.tags ?? []).length, TAGS_SATURATION),
    regionOf(event, context.defaultRegion) === context.regionKey ? 1 : 0,
    event.status === "Open" ? 1 : 0,
    goingKnown ? unit(going, GOING_SATURATION) : 0,
    goingKnown ? 0 : 1,
  ];
}

// --- the ranker ---
//
// L2-regularized logistic regression, full-batch gradient descent, no
// dependencies. Chosen because it is the smallest model that can be read off
// the artifact and argued with: fifteen weights and a bias, each one a named
// feature, so a wrong ordering can be traced to a wrong coefficient rather than
// to an opaque ensemble. It is also deterministic given the rows and the
// hyperparameters, which is what lets the same artifact be rebuilt and checked.

/**
 * Position-bias correction, and the assumption behind it.
 *
 * A click on rank 1 and a click on rank 20 are not equal evidence: rank 1 was
 * almost certainly looked at and rank 20 very likely was not. Training on raw
 * clicks therefore learns "was shown high", which is the ordering we already
 * have. The standard fix is inverse-propensity weighting, and the propensity
 * has to come from somewhere.
 *
 * ASSUMED, NOT MEASURED: examination probability falls as 1/rank (eta = 1),
 * the usual first approximation, so a row at rank k carries weight k. Hacklist
 * has no eye-tracking and no swap experiment, so this curve is borrowed rather
 * than fitted; the cap keeps one deep click from dominating a small sample.
 * Fitting eta from a position-swap experiment is the honest upgrade, and it
 * needs the organic traffic the deploy has not collected yet.
 */
export const POSITION_BIAS_ETA = 1;
export const POSITION_WEIGHT_CAP = 10;

export function positionWeight(position, eta = POSITION_BIAS_ETA) {
  const rank = Math.max(1, Math.floor(position) + 1);
  return Math.min(POSITION_WEIGHT_CAP, Math.pow(rank, eta));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export const DEFAULT_TRAINING = Object.freeze({
  learningRate: 0.5,
  iterations: 2000,
  l2: 0.01,
});

/**
 * Train weights and a bias from weighted rows.
 *
 * Full-batch: the gradient sums over every row before a step, so the result
 * does not depend on row order at all, let alone on a shuffle seed. Zeros for
 * the initial weights, a fixed step count, no early stopping.
 *
 * @param {Array<{features: number[], label: number, weight?: number}>} rows
 */
export function trainLogistic(rows, options = {}) {
  const { learningRate, iterations, l2 } = { ...DEFAULT_TRAINING, ...options };
  const width = rows.length ? rows[0].features.length : 0;
  const weights = new Array(width).fill(0);
  let bias = 0;
  const totalWeight =
    rows.reduce((sum, row) => sum + (row.weight ?? 1), 0) || 1;

  for (let step = 0; step < iterations; step += 1) {
    const gradient = new Array(width).fill(0);
    let biasGradient = 0;
    for (const row of rows) {
      const weight = row.weight ?? 1;
      let z = bias;
      for (let i = 0; i < width; i += 1) z += weights[i] * row.features[i];
      const error = sigmoid(z) - row.label;
      const scaled = (error * weight) / totalWeight;
      for (let i = 0; i < width; i += 1) {
        gradient[i] += scaled * row.features[i];
      }
      biasGradient += scaled;
    }
    for (let i = 0; i < width; i += 1) {
      // L2 on the weights only. Penalizing the bias would pull the base rate
      // towards a half, which is not a claim anybody wants to make.
      weights[i] -= learningRate * (gradient[i] + l2 * weights[i]);
    }
    bias -= learningRate * biasGradient;
  }
  return { weights, bias, learningRate, iterations, l2 };
}

/** Log-loss on weighted rows, for the training log. */
export function logLoss(rows, model) {
  if (!rows.length) return 0;
  let total = 0;
  let weightSum = 0;
  for (const row of rows) {
    const weight = row.weight ?? 1;
    let z = model.bias;
    for (let i = 0; i < row.features.length; i += 1) {
      z += model.weights[i] * row.features[i];
    }
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
    total += -weight * (row.label * Math.log(p) + (1 - row.label) * Math.log(1 - p));
    weightSum += weight;
  }
  return total / (weightSum || 1);
}

/**
 * Accept a model artifact, or refuse it.
 *
 * Capability detection, not a switch: the caller gets a model when the build
 * carries a usable one and null when it does not, and null means the board and
 * the evaluator both fall back to the production ordering. There is no flag in
 * between, because a flag is a second thing that can be wrong.
 */
export function validateModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { feature_names: names, weights, bias, model_version: version } = raw;
  if (!Array.isArray(names) || !Array.isArray(weights)) return null;
  if (names.length !== FEATURE_NAMES.length) return null;
  if (weights.length !== FEATURE_NAMES.length) return null;
  // A model trained on a different feature list is not a model for this board.
  for (let i = 0; i < FEATURE_NAMES.length; i += 1) {
    if (names[i] !== FEATURE_NAMES[i]) return null;
  }
  if (!weights.every((w) => typeof w === "number" && Number.isFinite(w))) {
    return null;
  }
  if (typeof bias !== "number" || !Number.isFinite(bias)) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  return {
    modelVersion: version,
    featureNames: names.slice(),
    weights: weights.slice(),
    bias,
  };
}

/** The model's score for one event: the linear part, which is all an ordering needs. */
export function scoreEvent(model, event, context) {
  const features = extractFeatures(event, context);
  let z = model.bias;
  for (let i = 0; i < features.length; i += 1) z += model.weights[i] * features[i];
  return z;
}

/**
 * The candidate ordering: the same set the board would show, sorted by the
 * model. Ties fall back to the incoming (production) order, so the result is a
 * total order with no dependence on the sort implementation.
 */
export function candidateOrder(events, model, context) {
  return events
    .map((event, index) => ({ event, index, z: scoreEvent(model, event, context) }))
    .sort((a, b) => b.z - a.z || a.index - b.index)
    .map((entry) => entry.event);
}

// --- seeded randomness ---

/** FNV-1a, 32-bit. A stable integer for a string, on every engine. */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and identical everywhere, which is the point. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The draft seed for one client on one day: same client, same day, same draft. */
export const draftSeed = (clientId, dayKey) => hashSeed(`${clientId}|${dayKey}`);

/**
 * Team-draft interleaving (Radlinski, Kurup and Joachims). Two orderings of the
 * same set take turns picking their next unpicked item; whoever has picked less
 * so far goes next, and a tie is broken by the seeded coin. Every item lands
 * exactly once, and the team that picked it owns any click on it.
 *
 * This is the only design here that can produce an online comparison from
 * ordinary browsing: both orderings are on the same page for the same person,
 * so the interest of the reader is held constant instead of being averaged
 * across two populations.
 *
 * @returns {Array<{event: object, team: "production"|"candidate"}>}
 */
export function teamDraftInterleave(production, candidate, seed) {
  const rng = mulberry32(seed);
  const picked = new Set();
  const out = [];
  let indexA = 0;
  let indexB = 0;
  let countA = 0;
  let countB = 0;
  const advance = (list, from) => {
    let index = from;
    while (index < list.length && picked.has(list[index].id)) index += 1;
    return index;
  };
  const take = (list, index, team) => {
    const event = list[index];
    picked.add(event.id);
    out.push({ event, team });
    return event;
  };

  while (out.length < production.length) {
    indexA = advance(production, indexA);
    indexB = advance(candidate, indexB);
    const aAvailable = indexA < production.length;
    const bAvailable = indexB < candidate.length;
    if (!aAvailable && !bAvailable) break;
    let fromA;
    if (!bAvailable) fromA = true;
    else if (!aAvailable) fromA = false;
    else if (countA !== countB) fromA = countA < countB;
    else fromA = rng() < 0.5;
    if (fromA) {
      take(production, indexA, "production");
      countA += 1;
    } else {
      take(candidate, indexB, "candidate");
      countB += 1;
    }
  }
  return out;
}

/**
 * The list the board renders, and how it got that way.
 *
 * `model` null (no artifact, or one that failed validation) or `clientId` null
 * (a first visit, and the server render, which has no client identity at all)
 * both give the production ordering, deterministically. That is the cold start
 * and the fallback, and they are the same code path rather than two.
 */
export function rankedList({ visible, model, clientId, dayKey, context }) {
  if (!model || !clientId) {
    return {
      rows: visible.map((event) => ({ event, team: "production" })),
      ordering: "production",
      modelVersion: model ? model.modelVersion : null,
      chronological: true,
    };
  }
  const candidate = candidateOrder(visible, model, context);
  return {
    rows: teamDraftInterleave(visible, candidate, draftSeed(clientId, dayKey)),
    ordering: "interleaved",
    modelVersion: model.modelVersion,
    chronological: false,
  };
}

/** The UTC day a draft is seeded from: one draft per client per day. */
export const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
