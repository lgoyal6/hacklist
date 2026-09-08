// The English board keeps the bare paths it has always had: "/" must go on
// meaning what it meant before a second language existed. So English is a
// route group with its own root layout rather than a segment under /[locale].
import type { Metadata } from "next";
import { localizedMetadata } from "../i18n/metadata";
import "../globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("en");
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
