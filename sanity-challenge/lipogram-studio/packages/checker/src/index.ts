// The one implementation of every constraint.
//
// The Studio input highlights with it as you type, the Sanity Function re-checks
// with it when a constraint changes, the publish action refuses with it, and
// the public site and the console preview with it. One implementation, so the
// four can never disagree about whether a poem is valid.
//
// Pure: no I/O, no randomness, no dates. Same text and same constraint, same verdict.

import {syllable} from 'syllable'

export type ConstraintKind =
  | 'lipogram'
  | 'univocalic'
  | 'reuseWord'
  | 'syllables'
  | 'acrostic'
  | 'noRepeat'
  | 'bannedWords'
  | 'maxLineLength'
  | 'lineCount'
  | 'forbiddenPattern'

export interface ConstraintParams {
  /** lipogram: letters that may not appear. */
  letters?: string
  /** univocalic: the only vowel allowed. */
  vowel?: string
  /** reuseWord: minimum length of the shared word. */
  minWordLength?: number
  /** syllables: syllables per line, repeating; e.g. [5, 7, 5]. */
  pattern?: number[]
  /** acrostic: first letters of lines spell this. */
  word?: string
  /** noRepeat: ignore these words (articles and so on). */
  ignore?: string[]
  /** bannedWords: words or phrases that may not appear. */
  words?: string[]
  /** maxLineLength: characters per line. */
  maxChars?: number
  /** lineCount */
  minLines?: number
  maxLines?: number
  /** forbiddenPattern: a regular expression source, and why it is forbidden. */
  regex?: string
  reason?: string
}

export interface Constraint {
  _id?: string
  title?: string
  kind: ConstraintKind
  params: ConstraintParams
}

export interface Failure {
  /** 0-based line index, or -1 for whole-poem failures. */
  line: number
  start: number
  end: number
  message: string
}

export interface Verdict {
  ok: boolean
  failures: Failure[]
}

const WORD = /[\p{L}\p{N}']+/gu

function words(line: string): {word: string; start: number; end: number}[] {
  return [...line.matchAll(WORD)].map((m) => ({word: m[0], start: m.index!, end: m.index! + m[0].length}))
}

/** Lines that carry text. Blank lines are stanza breaks and are skipped by line-based rules. */
function textLines(lines: string[]): {text: string; index: number}[] {
  return lines.map((text, index) => ({text, index})).filter((l) => l.text.trim().length > 0)
}

const VOWELS = 'aeiou'

/**
 * Syllable count from the `syllable` package (rule-based English, with an
 * exceptions list). It is not a dictionary: it says "poem" is one syllable,
 * which some readers dispute. The same function runs on every surface, so a
 * poem's verdict never depends on where it was checked. Stated in the README.
 */
export function syllableCount(word: string): number {
  return word.replace(/[^\p{L}']/gu, '') ? syllable(word) : 0
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function check(lines: string[], c: Constraint): Verdict {
  const failures: Failure[] = []
  const p = c.params ?? {}
  const fail = (line: number, start: number, end: number, message: string) => failures.push({line, start, end, message})

  switch (c.kind) {
    case 'lipogram': {
      const banned = new Set((p.letters ?? '').toLowerCase().replace(/[^\p{L}]/gu, ''))
      lines.forEach((line, i) => {
        ;[...line].forEach((ch, j) => {
          if (banned.has(ch.toLowerCase())) fail(i, j, j + 1, `uses the letter "${ch.toLowerCase()}"`)
        })
      })
      break
    }
    case 'univocalic': {
      const allowed = (p.vowel ?? 'a').toLowerCase()
      lines.forEach((line, i) => {
        ;[...line].forEach((ch, j) => {
          const l = ch.toLowerCase()
          if (VOWELS.includes(l) && l !== allowed) fail(i, j, j + 1, `uses the vowel "${l}"; only "${allowed}" is allowed`)
        })
      })
      break
    }
    case 'reuseWord': {
      const min = p.minWordLength ?? 3
      const tl = textLines(lines)
      for (let k = 1; k < tl.length; k++) {
        const prev = new Set(words(tl[k - 1].text).filter((w) => w.word.length >= min).map((w) => w.word.toLowerCase()))
        const cur = words(tl[k].text)
        if (!cur.some((w) => w.word.length >= min && prev.has(w.word.toLowerCase()))) {
          fail(tl[k].index, 0, tl[k].text.length, `shares no word of ${min}+ letters with the line above`)
        }
      }
      break
    }
    case 'syllables': {
      const pattern = p.pattern?.length ? p.pattern : [5, 7, 5]
      const tl = textLines(lines)
      tl.forEach((l, k) => {
        const want = pattern[k % pattern.length]
        const got = words(l.text).reduce((n, w) => n + syllableCount(w.word), 0)
        if (got !== want) fail(l.index, 0, l.text.length, `has ${got} syllables; the pattern wants ${want}`)
      })
      break
    }
    case 'acrostic': {
      const target = (p.word ?? '').toLowerCase().replace(/[^\p{L}]/gu, '')
      const tl = textLines(lines)
      if (tl.length !== target.length) fail(-1, 0, 0, `has ${tl.length} lines; "${target}" needs ${target.length}`)
      tl.forEach((l, k) => {
        const first = words(l.text)[0]
        const want = target[k]
        if (want && first && first.word[0].toLowerCase() !== want) {
          fail(l.index, first.start, first.start + 1, `starts with "${first.word[0]}"; the acrostic wants "${want}"`)
        }
      })
      break
    }
    case 'noRepeat': {
      const ignore = new Set((p.ignore ?? ['a', 'an', 'the', 'and', 'of', 'to', 'in', 'i']).map((w) => w.toLowerCase()))
      const seen = new Map<string, number>()
      lines.forEach((line, i) => {
        for (const w of words(line)) {
          const key = w.word.toLowerCase()
          if (ignore.has(key)) continue
          if (seen.has(key)) fail(i, w.start, w.end, `repeats "${key}" (first used on line ${seen.get(key)! + 1})`)
          else seen.set(key, i)
        }
      })
      break
    }
    case 'bannedWords': {
      const list = (p.words ?? []).filter(Boolean)
      if (!list.length) break
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
      lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) fail(i, m.index!, m.index! + m[0].length, `uses the banned word "${m[0]}"`)
      })
      break
    }
    case 'maxLineLength': {
      const max = p.maxChars ?? 60
      lines.forEach((line, i) => {
        if (line.length > max) fail(i, max, line.length, `is ${line.length} characters; the limit is ${max}`)
      })
      break
    }
    case 'lineCount': {
      const n = textLines(lines).length
      if (p.minLines !== undefined && n < p.minLines) fail(-1, 0, 0, `has ${n} lines; at least ${p.minLines} required`)
      if (p.maxLines !== undefined && n > p.maxLines) fail(-1, 0, 0, `has ${n} lines; at most ${p.maxLines} allowed`)
      break
    }
    case 'forbiddenPattern': {
      let re: RegExp
      try {
        re = new RegExp(p.regex ?? '(?!)', 'gu')
      } catch {
        fail(-1, 0, 0, `the constraint's pattern is not a valid regular expression`)
        break
      }
      lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) {
          if (m[0].length === 0) break
          fail(i, m.index!, m.index! + m[0].length, p.reason ? `"${m[0]}": ${p.reason}` : `matches the forbidden pattern`)
        }
      })
      break
    }
  }
  return {ok: failures.length === 0, failures}
}

/** Split Portable-Text-free plain text into lines the way every surface does. */
export function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/** Check against several constraints; returns per-constraint verdicts keyed by constraint id or index. */
export function checkAll(lines: string[], constraints: Constraint[]): {constraint: Constraint; verdict: Verdict}[] {
  return constraints.map((constraint) => ({constraint, verdict: check(lines, constraint)}))
}

/** One-line human summary of a constraint, used in lists and the console. */
export function describe(c: Constraint): string {
  const p = c.params ?? {}
  switch (c.kind) {
    case 'lipogram': return `Never use the letter${(p.letters ?? '').length > 1 ? 's' : ''} ${[...(p.letters ?? '')].join(', ')}`
    case 'univocalic': return `Only one vowel: ${p.vowel ?? 'a'}`
    case 'reuseWord': return `Every line reuses a word (${p.minWordLength ?? 3}+ letters) from the line above`
    case 'syllables': return `Syllables per line: ${(p.pattern ?? [5, 7, 5]).join('-')}`
    case 'acrostic': return `First letters spell ${(p.word ?? '').toUpperCase()}`
    case 'noRepeat': return 'No word used twice'
    case 'bannedWords': return `Never say: ${(p.words ?? []).join(', ')}`
    case 'maxLineLength': return `Lines at most ${p.maxChars ?? 60} characters`
    case 'lineCount': return `Between ${p.minLines ?? 0} and ${p.maxLines ?? '∞'} lines`
    case 'forbiddenPattern': return p.reason ? `No ${p.reason}` : `Nothing matching /${p.regex}/`
  }
}
