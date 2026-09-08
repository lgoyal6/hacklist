// Every language other than English lives at /<locale>. The segment is
// dynamic rather than a hardcoded /es so that an unknown locale falls back to
// the English board (resolveLocale says why fallback, not 404), and the
// <html lang> attribute always states the language actually rendered, never
// the one the URL asked for.
import type { Metadata } from "next";
import { resolveLocale } from "../i18n";
import { localizedMetadata } from "../i18n/metadata";
import "../globals.css";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({
  params,
}: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  return localizedMetadata(resolveLocale(locale));
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  return (
    <html lang={resolveLocale(locale)}>
      <body>{children}</body>
    </html>
  );
}
