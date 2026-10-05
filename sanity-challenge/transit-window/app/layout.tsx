import type {Metadata} from 'next'
import Link from 'next/link'

import './globals.css'

export const metadata: Metadata = {
  title: 'Transit Window',
  description: 'Which exoplanet transits you can see tonight, and which published timing to trust.',
}

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <nav>
            <Link href="/" className="brand">Transit Window</Link>
            <Link href="/">Tonight</Link>
            <Link href="/ask">Ask</Link>
            <Link href="/proof">Proof</Link>
            <Link href="/about">About</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
