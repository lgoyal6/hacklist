'use client'
import {useRouter, useSearchParams} from 'next/navigation'
import {useState} from 'react'

const PRESETS: Record<string, [number, number, number]> = {
  'La Jolla, CA': [32.8801, -117.234, 100],
  'Mount Laguna, CA': [32.8418, -116.4278, 1859],
  'London, UK': [51.5074, -0.1278, 20],
  'Pune, India': [18.5204, 73.8567, 560],
  'Sydney, Australia': [-33.8688, 151.2093, 20],
  'Santiago, Chile': [-33.4489, -70.6693, 570],
}

export function SiteForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [lat, setLat] = useState(params.get('lat') ?? '32.8801')
  const [lon, setLon] = useState(params.get('lon') ?? '-117.234')
  const [date, setDate] = useState(params.get('date') ?? new Date().toISOString().slice(0, 10))
  const [aperture, setAperture] = useState(params.get('aperture') ?? '')
  const [depth, setDepth] = useState(params.get('depth') ?? '')

  function go(next?: Partial<Record<string, string>>) {
    const q = new URLSearchParams({lat, lon, date, ...(aperture && {aperture}), ...(depth && {depth}), ...next})
    router.push(`/?${q}`)
  }

  return (
    <form className="controls panel" onSubmit={(e) => { e.preventDefault(); go() }}>
      <label>Place
        <select onChange={(e) => { const p = PRESETS[e.target.value]; if (p) { setLat(String(p[0])); setLon(String(p[1])) } }} defaultValue="">
          <option value="" disabled>Choose a preset</option>
          {Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}
        </select>
      </label>
      <label>Latitude<input value={lat} onChange={(e) => setLat(e.target.value)} size={9} /></label>
      <label>Longitude<input value={lon} onChange={(e) => setLon(e.target.value)} size={9} /></label>
      <label>Evening of<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label>Telescope
        <select value={aperture} onChange={(e) => setAperture(e.target.value)}>
          <option value="">Any</option>
          <option value="6">6 inch</option>
          <option value="8">8 inch</option>
          <option value="12">12 inch</option>
          <option value="16">16 inch</option>
        </select>
      </label>
      <label>Min depth (mmag)<input value={depth} onChange={(e) => setDepth(e.target.value)} size={4} placeholder="any" /></label>
      <button type="button" onClick={() => navigator.geolocation?.getCurrentPosition((p) => { setLat(p.coords.latitude.toFixed(4)); setLon(p.coords.longitude.toFixed(4)) })}>Use my location</button>
      <button type="submit">Show transits</button>
    </form>
  )
}
