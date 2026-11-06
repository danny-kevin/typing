import { StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

export interface Match {
  from: number
  to: number
}

export const setSearchHighlights = StateEffect.define<Match[]>()

const matchMark = Decoration.mark({ class: 'cm-search-match' })
const currentMark = Decoration.mark({ class: 'cm-search-current' })

export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlights)) {
        const ranges: Range<Decoration>[] = effect.value.map((m) => matchMark.range(m.from, m.to))
        next = Decoration.set(ranges, true)
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const setCurrentMatch = StateEffect.define<Match | null>()

export const currentMatchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setCurrentMatch)) {
        next = effect.value ? Decoration.set([currentMark.range(effect.value.from, effect.value.to)]) : Decoration.none
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findMatches(text: string, query: string, opts: SearchOptions): Match[] {
  if (!query) return []
  const out: Match[] = []
  const limit = 20000
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, opts.caseSensitive ? 'gm' : 'gim')
    } catch {
      return []
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) && out.length < limit) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      out.push({ from: m.index, to: m.index + m[0].length })
    }
    return out
  }
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const haystack = opts.caseSensitive ? text : text.toLowerCase()
  let i = 0
  while (out.length < limit) {
    const idx = haystack.indexOf(needle, i)
    if (idx === -1) break
    const before = text[idx - 1]
    const after = text[idx + needle.length]
    const wordOk =
      !opts.wholeWord ||
      ((!before || !/[\p{L}\p{N}_]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after)))
    if (wordOk) out.push({ from: idx, to: idx + needle.length })
    i = idx + Math.max(1, needle.length)
  }
  return out
}

export function highlightQuery(query: string, opts: SearchOptions): string {
  if (!query) return ''
  return opts.regex ? query : escapeRegExp(query)
}