import type { Metadata } from "next";
import { headers } from "next/headers";
import { LOCALES, localePath, translator, type Locale } from "./index";

/**
 * The page metadata, in the page's language. Every locale's page also names
 * every other locale's address (alternates.languages), so a crawler, and a
 * reader on the wrong board, can find the same page in the other language.
 */
export async function localizedMetadata(locale: Locale): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3001";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const { t } = translator(locale);
  const title = t("meta.title");
  const description = t("meta.description");

  return {
    title,
    description,
    alternates: {
      languages: Object.fromEntries(
        LOCALES.map((entry) => [entry, `${origin}${localePath(entry)}`]),
      ),
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}
