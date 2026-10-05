// What a visitor may change, and how far. Everything outside these bounds is
// refused, so the public button cannot be used to write arbitrary content.
export type SandboxParams = Record<string, unknown>

export function validateParams(kind: string, raw: any): {ok: true; params: SandboxParams} | {ok: false; error: string} {
  switch (kind) {
    case 'lipogram': {
      const letters = String(raw?.letters ?? '').toLowerCase()
      if (!/^[a-z]{1,8}$/.test(letters)) return {ok: false, error: 'Ban 1 to 8 letters, a to z.'}
      return {ok: true, params: {letters: [...new Set(letters)].sort().join('')}}
    }
    case 'maxLineLength': {
      const maxChars = Number(raw?.maxChars)
      if (!Number.isInteger(maxChars) || maxChars < 12 || maxChars > 140) return {ok: false, error: 'Line width must be 12 to 140.'}
      return {ok: true, params: {maxChars}}
    }
    case 'lineCount': {
      const maxLines = Number(raw?.maxLines)
      if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 20) return {ok: false, error: 'Poem length must be 1 to 20 lines.'}
      return {ok: true, params: {minLines: 1, maxLines}}
    }
    case 'bannedWords': {
      const words = Array.isArray(raw?.words) ? raw.words.map((w: unknown) => String(w).trim().toLowerCase()).filter(Boolean) : []
      if (words.length > 20 || words.some((w: string) => !/^[a-z][a-z' -]{0,29}$/.test(w))) return {ok: false, error: 'Up to 20 plain words.'}
      return {ok: true, params: {words: [...new Set(words)]}}
    }
    case 'forbiddenPattern': {
      // Visitors toggle the existing rule only; they cannot supply a regex.
      return {ok: false, error: 'This rule is not editable from the site.'}
    }
    default:
      return {ok: false, error: 'This rule is not editable from the site.'}
  }
}
