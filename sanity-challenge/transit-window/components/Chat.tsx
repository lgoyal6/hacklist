'use client'
import {useState} from 'react'

const EXAMPLES = [
  'Which transit tonight is best for an 8 inch telescope in San Diego?',
  'Why should I not trust the NASA timing for XO-3b?',
  'Is the orbit of WASP-12b decaying?',
  'When is the next transit of HAT-P-37b, and how far off is the NASA default?',
]

type Msg = {role: 'user' | 'assistant'; content: string; tools?: string[]; checked?: {ok: boolean; unsupported: string[]}}

export function Chat() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(text: string) {
    if (!text.trim() || busy) return
    const next = [...messages, {role: 'user' as const, content: text}]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({messages: next.map(({role, content}) => ({role, content}))}),
      })
      const data = await res.json()
      setMessages([...next, {role: 'assistant', content: data.answer ?? data.error ?? 'No answer.', tools: data.tools, checked: data.checked}])
    } catch (e) {
      setMessages([...next, {role: 'assistant', content: `Request failed: ${String(e)}`}])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat">
      {messages.length === 0 && (
        <div className="panel small">
          Try:{' '}
          {EXAMPLES.map((e) => (
            <button key={e} type="button" style={{margin: 4}} onClick={() => send(e)}>{e}</button>
          ))}
        </div>
      )}
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          {m.content}
          {m.tools && m.tools.length > 0 && <div className="tool">tools: {m.tools.join(' → ')}</div>}
          {m.checked && (
            <div className="tool">
              {m.checked.ok ? 'every number checked against retrieved data' : `numbers not found in retrieved data: ${m.checked.unsupported.join(', ')}`}
            </div>
          )}
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); send(input) }} style={{display: 'flex', gap: 8}}>
        <input style={{flex: 1}} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about tonight's transits or any planet" />
        <button disabled={busy}>{busy ? 'Thinking' : 'Ask'}</button>
      </form>
    </div>
  )
}
