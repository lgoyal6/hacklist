'use client'
// Times are computed in UTC on the server and shown in the viewer's own zone.
import {useEffect, useState} from 'react'

export function LocalTime({iso, withDate = false}: {iso: string; withDate?: boolean}) {
  const [text, setText] = useState(iso.slice(11, 16) + ' UTC')
  useEffect(() => {
    const d = new Date(iso)
    setText(
      d.toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        ...(withDate ? {month: 'short', day: 'numeric'} : {}),
      }),
    )
  }, [iso, withDate])
  return <time dateTime={iso} title={iso}>{text}</time>
}
