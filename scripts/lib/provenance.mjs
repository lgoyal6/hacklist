// Where a published event came from, precisely enough to check.
//
// The board used to say `discoveredVia`, which is the URL a candidate was found
// on. That answers "which site", not "which version of which file". Two sweeps
// a week apart produce the same `discoveredVia` and different events, so an
// event could not be tied back to the input that actually produced it.
//
// Two identities fix that:
//
//   - an **input version**: the sha256 of a whole candidate file, plus its byte
//     length. That names one exact revision of one input.
//   - a **content hash**: the sha256 of the fields of a single candidate that
//     the published event is derived from. That names the record inside it.
//
// A published event carries both, and `meta.inputs` lists every input version
// the run read. Given an event you can say which file version it came from;
// given a file you can say whether it is the one a board was built from.

import { createHash } from "node:crypto";

/**
 * How a published event came to be on the board.
 *
 * `observed` means this sweep read the record out of an input file. A sweep
 * that cannot reach a source republishes the listing from the previous
 * snapshot instead of dropping it, and that record is `carried-forward`: real,
 * but not re-confirmed today. Both modules that stamp events take the strings
 * from here, so one field answers "was this seen this sweep" everywhere.
 */
export const PROVENANCE_KIND = Object.freeze({
  observed: "observed",
  carriedForward: "carried-forward",
});

/** Hash of arbitrary bytes or text. Hex, full length; these are not ids. */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A versioned identity for one input file.
 *
 * Content-addressed rather than timestamped: mtime changes when a file is
 * rewritten with identical content, and does not change when a file is
 * restored from elsewhere. The hash is the thing that actually identifies a
 * revision.
 */
export function inputVersion(file, raw) {
  return {
    file,
    sha256: sha256(raw),
    bytes: Buffer.byteLength(raw),
  };
}

// The candidate fields a published event is actually derived from. Hashing the
// whole candidate object would make the hash change when a field nothing reads
// changes, which makes "did this record change" unanswerable.
const HASHED_FIELDS = [
  "url",
  "title",
  "category",
  "discoveredVia",
  "confidence",
  "relevance",
  "evidence",
];

/**
 * Content hash of one candidate.
 *
 * Field order is fixed by HASHED_FIELDS rather than by object key order, so two
 * candidates with the same values hash the same however they were built. A
 * missing field hashes as absent rather than as the empty string, so "no
 * evidence" and "evidence: ''" are different records.
 */
export function contentHash(candidate) {
  const canonical = HASHED_FIELDS.map((field) =>
    Object.hasOwn(candidate, field) && candidate[field] !== undefined
      ? [field, candidate[field]]
      : [field, null],
  );
  return sha256(JSON.stringify(canonical));
}

/**
 * Collects input versions as files are read, and hands out the provenance
 * stamp for a candidate that came from one of them.
 */
export class Provenance {
  constructor() {
    this.inputs = [];
    this.byFile = new Map();
  }

  /** Record one input file version. Reading the same file twice is one entry. */
  record(file, raw) {
    if (this.byFile.has(file)) return this.byFile.get(file);
    const version = inputVersion(file, raw);
    this.inputs.push(version);
    this.byFile.set(file, version);
    return version;
  }

  /** The `meta.inputs` list, ordered so two identical runs produce one diff. */
  manifest() {
    return [...this.inputs].sort((a, b) => a.file.localeCompare(b.file));
  }

  /**
   * The stamp that goes on a published event.
   *
   * `inputs` is a list because a published event can come from more than one:
   * the deduplicator merges an event found on Luma with the same event found on
   * Devpost, and the result is derived from both files. Naming one of them
   * would be a provenance record that is wrong a quarter of the time.
   *
   * A file this run did not record contributes a null sha256 rather than a
   * guessed one. The gate treats that as a failure: an event whose input cannot
   * be named is what this module exists to prevent.
   *
   * The `kind` says this sweep read the record. It is not decoration: the other
   * way onto the board is being carried forward from a snapshot, and a reader
   * that cannot tell the two apart will report a listing nobody has confirmed
   * for three days as current.
   */
  stamp(files, candidate) {
    const inputs = [...files]
      .sort()
      .map((file) => ({ file, sha256: this.byFile.get(file)?.sha256 ?? null }));
    return {
      kind: PROVENANCE_KIND.observed,
      inputs,
      contentSha256: contentHash(candidate),
    };
  }
}
