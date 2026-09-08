// The catalog contract: every locale answers for every key.
//
// This is the check that makes a missing translation a red run rather than a
// silent English (or raw-key) leak in one language's UI. It runs inside
// test:artifact, so nothing is promoted while the catalogs disagree.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../app/i18n/${name}.json`, import.meta.url), "utf8"),
  );

const en = await load("en");
const es = await load("es");
const catalogs = { en, es };

test("every locale defines exactly the keys English defines", () => {
  const base = Object.keys(en).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const keys = Object.keys(catalog).sort();
    const missing = base.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !base.includes(key));
    assert.deepEqual(
      missing,
      [],
      `${locale} is missing translations for: ${missing.join(", ")}`,
    );
    assert.deepEqual(
      extra,
      [],
      `${locale} has keys English does not: ${extra.join(", ")}`,
    );
  }
});

test("no catalog value is empty or accidentally the key itself", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string", `${locale}:${key} is not a string`);
      assert.ok(value.trim().length > 0, `${locale}:${key} is empty`);
      assert.notEqual(value, key, `${locale}:${key} is its own key`);
    }
  }
});

test("placeholders agree across locales, so no variable is dropped in translation", () => {
  const placeholders = (value) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en)) {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      if (!(key in catalog)) continue; // the parity test already reports this
      assert.deepEqual(
        placeholders(catalog[key]),
        placeholders(en[key]),
        `${locale}:${key} does not carry the same {placeholders} as English`,
      );
    }
  }
});

test("every key the app asks for by name exists in the catalogs", async () => {
  const appDir = new URL("../app/", import.meta.url);
  const sources = [];
  for (const entry of await readdir(appDir, { recursive: true })) {
    if (/\.(tsx?|mjs)$/.test(entry) && !entry.endsWith(".json")) {
      sources.push(await readFile(new URL(entry, appDir), "utf8"));
    }
  }
  const source = sources.join("\n");
  // Literal lookups: t("key"), plural("key", ...). Pluralized keys resolve to
  // key.one / key.other at runtime.
  const used = new Set(
    [...source.matchAll(/\b(?:t|plural|hasMessage)\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    ),
  );
  const pluralUsed = new Set(
    [...source.matchAll(/\bplural\(\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  assert.ok(used.size > 10, "expected the app to reference catalog keys");
  for (const key of used) {
    const resolved = pluralUsed.has(key) ? [`${key}.one`, `${key}.other`] : [key];
    for (const name of resolved) {
      assert.ok(
        name in en,
        `app asks for "${name}" but en.json does not define it`,
      );
    }
  }
});
