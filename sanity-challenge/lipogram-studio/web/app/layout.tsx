import type {Metadata} from 'next'
import Link from 'next/link'

import './globals.css'

export const metadata: Metadata = {
  title: 'Lipogram Studio',
  description: 'Writing rules stored as content. Tighten one and watch every poem that breaks it turn red.',
}

export default function Layout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <nav>
            <Link href="/" className="brand">Lipogram Studio</Link>
            <Link href="/c/chamber">Pressure chamber</Link>
            <Link href="/c/poetry">Constrained verse</Link>
            <Link href="/c/brand">Style guide mode</Link>
            <Link href="/how">How it works</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
