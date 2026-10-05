export default function About() {
  return (
    <>
      <h1>About</h1>
      <p className="lede">
        Transit Window is an entry for the DEV x Sanity Challenge. It answers one question for amateur observers:
        which exoplanet transits can I see tonight, and when exactly, given that published timings disagree.
      </p>
      <h2>Data</h2>
      <ul>
        <li>NASA Exoplanet Archive, Planetary Systems table: every published transit ephemeris (about 31,000 rows).</li>
        <li>ExoClock Project catalogue: homogeneous ephemerides for 776 planets, fitted to recent amateur, literature and space observations.</li>
        <li>Paper abstracts and quoted ephemerides from arXiv, for the Knowledge Base.</li>
      </ul>
      <h2>How a timing is chosen</h2>
      <p>
        Code, not the model, picks the solution. A solution must be corroborated by at least one other published solution.
        Among those, ExoClock is used when its uncertainty tonight is close to the smallest; otherwise the solution with
        the smallest uncertainty propagated to tonight wins. Midtimes in an unknown time system are never used, because
        barycentric versus geocentric is an 8-minute ambiguity.
      </p>
      <h2>Limits</h2>
      <ul>
        <li>Systems with transit timing variations are flagged; a straight-line ephemeris is not reliable for them.</li>
        <li>Coverage is the 776 planets ExoClock monitors, which are the ones a small telescope can usually catch.</li>
        <li>Times are for the Earth&apos;s centre; the observer offset is under 0.03 s.</li>
      </ul>
    </>
  )
}
