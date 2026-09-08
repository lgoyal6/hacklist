import Board from "../board";
import { resolveLocale } from "../i18n";

export default async function LocaleHome({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <Board locale={resolveLocale(locale)} />;
}
