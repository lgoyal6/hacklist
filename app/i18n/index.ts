// The UI message catalogs and how the site picks between them.
//
// Two hard rules, both tested:
// - Only the chrome is translated. Event titles, organizer names and anything
//   else an organizer wrote are data, not copy, and pass through untouched.
// - The locale changes words, never behavior. The same board, the same feed
//   URL, the same event identity, whichever language it is read in.
import en from "./en.json";
import es from "./es.json";

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

type Catalog = Record<string, string>;
const catalogs: Record<Locale, Catalog> = { en, es };

/**
 * An unrecognised locale segment falls back to English rather than 404ing.
 * The feed refuses an unknown region because a subscription is a standing
 * order and serving the wrong metro forever is worse than an error; a page
 * in the wrong language is read once, noticed immediately, and one click
 * from the right one.
 */
export function resolveLocale(raw: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(raw ?? "")
    ? (raw as Locale)
    : DEFAULT_LOCALE;
}

/** Where a locale's board lives. English keeps the bare path it has always had. */
export function localePath(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "/" : `/${locale}`;
}

/** Whether the default catalog defines a key, for copy that is optional per region. */
export function hasMessage(key: string): boolean {
  return key in catalogs[DEFAULT_LOCALE];
}

export type Translator = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  plural: (
    key: string,
    count: number,
    vars?: Record<string, string | number>,
  ) => string;
};

export function translator(locale: Locale): Translator {
  const catalog = catalogs[locale];
  const base = catalogs[DEFAULT_LOCALE];
  const rules = new Intl.PluralRules(locale);

  const t = (key: string, vars?: Record<string, string | number>): string => {
    // A key missing from one catalog falls back to English, and a key missing
    // from both surfaces as the raw key, which the tests treat as a failure:
    // an untranslated internal key must never look like working copy.
    let text = catalog[key] ?? base[key] ?? key;
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };

  const plural = (
    key: string,
    count: number,
    vars?: Record<string, string | number>,
  ): string => {
    // CLDR gives some languages forms beyond one/other (Spanish grew "many"
    // for millions). A catalog only carries the forms its copy distinguishes,
    // so an unwritten form falls back to "other" rather than leaking a key.
    const form = `${key}.${rules.select(count)}`;
    const chosen = catalog[form] ?? base[form] ? form : `${key}.other`;
    return t(chosen, { count: count.toLocaleString(locale), ...vars });
  };

  return { t, plural };
}
