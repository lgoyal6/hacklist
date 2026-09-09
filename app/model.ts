// The model artifact, if this build has one.
//
// import.meta.glob is resolved by the bundler at build time and yields an empty
// object when the file is not there. So "does this build carry a ranker" is a
// fact about what was built, discovered the same way the Worker discovers
// whether it has an Analytics Engine binding: capability detection, not
// configuration. Deleting data/ranker.json is a complete and sufficient way to
// turn the candidate ordering off, and it needs no code change, no environment
// variable and no flag that could disagree with reality.
import { validateModel } from "./ranking.mjs";

const artifacts = import.meta.glob("../data/ranker.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

/** A usable model, or null. Null is the production ordering, deterministically. */
export const model = validateModel(artifacts["../data/ranker.json"] ?? null);
