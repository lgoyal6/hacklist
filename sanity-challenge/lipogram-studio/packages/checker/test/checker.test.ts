import {describe, expect, it} from 'vitest'

import {check, describe as describeC, syllableCount, toLines} from '../src/index'

const lines = (s: string) => toLines(s.trim())

describe('lipogram', () => {
  it('passes text without the letter', () => {
    expect(check(lines('A moon was full,\nits light a calm warm gold'), {kind: 'lipogram', params: {letters: 'e'}}).ok).toBe(true)
  })
  it('marks every offending letter with its position', () => {
    const v = check(['the sun'], {kind: 'lipogram', params: {letters: 'e'}})
    expect(v.failures).toEqual([{line: 0, start: 2, end: 3, message: 'uses the letter "e"'}])
  })
  it('is case-insensitive', () => {
    expect(check(['Eagle'], {kind: 'lipogram', params: {letters: 'e'}}).failures).toHaveLength(2)
  })
})

describe('univocalic', () => {
  it('allows only the one vowel', () => {
    expect(check(['Hannah can scan a chart'], {kind: 'univocalic', params: {vowel: 'a'}}).ok).toBe(true)
    expect(check(['Hannah sings'], {kind: 'univocalic', params: {vowel: 'a'}}).ok).toBe(false)
  })
})

describe('reuseWord', () => {
  it('requires each line to share a word with the previous text line, skipping stanza breaks', () => {
    const ok = lines('the river runs\nthe river sleeps\n\nsleeps under stone')
    expect(check(ok, {kind: 'reuseWord', params: {minWordLength: 4}}).ok).toBe(true)
    const bad = lines('the river runs\na cat sat')
    const v = check(bad, {kind: 'reuseWord', params: {minWordLength: 4}})
    expect(v.failures.map((f) => f.line)).toEqual([1])
  })
})

describe('syllables', () => {
  it('counts common words', () => {
    expect(['the', 'river', 'beautiful', 'quiet', 'fire', 'cake', 'sky', '—'].map(syllableCount)).toEqual([1, 2, 3, 2, 1, 1, 1, 0])
  })
  it('checks a haiku pattern', () => {
    const haiku = lines('an old silent pond\na frog jumps into the pond\nsplash silence again')
    expect(check(haiku, {kind: 'syllables', params: {pattern: [5, 7, 5]}}).ok).toBe(true)
  })
})

describe('acrostic', () => {
  it('spells the word with first letters', () => {
    expect(check(lines('Every night\nArrives late\nRain on glass\nTo the morning\nHome'), {kind: 'acrostic', params: {word: 'earth'}}).ok).toBe(true)
    const v = check(lines('Every night\nBrrives'), {kind: 'acrostic', params: {word: 'ea'}})
    expect(v.failures[0]).toMatchObject({line: 1, start: 0, end: 1})
  })
  it('fails on the wrong number of lines', () => {
    expect(check(['Every'], {kind: 'acrostic', params: {word: 'ea'}}).failures[0].line).toBe(-1)
  })
})

describe('noRepeat', () => {
  it('flags the second use of a word, not stopwords', () => {
    const v = check(['the sea and the sky', 'the sea again'], {kind: 'noRepeat', params: {}})
    expect(v.failures).toHaveLength(1)
    expect(v.failures[0]).toMatchObject({line: 1, message: 'repeats "sea" (first used on line 1)'})
  })
})

describe('bannedWords', () => {
  it('matches whole words and phrases only', () => {
    const c = {kind: 'bannedWords' as const, params: {words: ['utilize', 'synergy', 'circle back']}}
    expect(check(['We utilize synergy.'], c).failures).toHaveLength(2)
    expect(check(['utilized'], c).ok).toBe(true)
    expect(check(["Let's circle back tomorrow"], c).failures[0]).toMatchObject({start: 6, end: 17})
  })
})

describe('maxLineLength and lineCount', () => {
  it('limits characters per line', () => {
    expect(check(['x'.repeat(61)], {kind: 'maxLineLength', params: {maxChars: 60}}).failures[0]).toMatchObject({start: 60, end: 61})
  })
  it('limits lines, ignoring blank ones', () => {
    expect(check(['a', '', 'b'], {kind: 'lineCount', params: {maxLines: 2}}).ok).toBe(true)
    expect(check(['a', 'b', 'c'], {kind: 'lineCount', params: {maxLines: 2}}).ok).toBe(false)
  })
})

describe('forbiddenPattern', () => {
  it('reports matches with the reason', () => {
    const v = check(['Great news!!'], {kind: 'forbiddenPattern', params: {regex: '!+', reason: 'exclamation marks'}})
    expect(v.failures).toEqual([{line: 0, start: 10, end: 12, message: '"!!": exclamation marks'}])
  })
  it('reports a broken pattern instead of throwing', () => {
    expect(check(['x'], {kind: 'forbiddenPattern', params: {regex: '('}}).failures[0].line).toBe(-1)
  })
})

describe('describe', () => {
  it('summarizes', () => {
    expect(describeC({kind: 'lipogram', params: {letters: 'e'}})).toBe('Never use the letter e')
    expect(describeC({kind: 'syllables', params: {pattern: [5, 7, 5]}})).toBe('Syllables per line: 5-7-5')
  })
})
