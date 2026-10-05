// A poem with the parts that break a rule marked. Failures come from the
// verdict documents the function wrote, not from the browser.
type Failure = {line: number; start: number; end: number; message: string}

export function PoemText({text, failures}: {text: string; failures: Failure[]}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return (
    <div className="poem">
      {lines.map((line, i) => {
        const fs = failures.filter((f) => f.line === i)
        const whole = fs.some((f) => f.start === 0 && f.end >= line.length && line.length > 0)
        if (!fs.length) return <div key={i}>{line || ' '}</div>
        if (whole) return <div key={i} className="wavy" title={fs.map((f) => f.message).join('; ')}>{line}</div>
        const marked = new Array(line.length).fill(false)
        for (const f of fs) for (let j = f.start; j < Math.min(f.end, line.length); j++) marked[j] = true
        const parts: {t: string; m: boolean}[] = []
        for (let j = 0; j < line.length; j++) {
          const last = parts[parts.length - 1]
          if (last && last.m === marked[j]) last.t += line[j]
          else parts.push({t: line[j], m: marked[j]})
        }
        return (
          <div key={i} title={fs.map((f) => f.message).join('; ')}>
            {parts.map((p, k) => (p.m ? <mark key={k} className="bad">{p.t}</mark> : <span key={k}>{p.t}</span>))}
          </div>
        )
      })}
    </div>
  )
}
