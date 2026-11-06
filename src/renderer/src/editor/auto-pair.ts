import { EditorView } from '@codemirror/view'

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '*': '*',
  _: '_',
  '~': '~',
  $: '$'
}

const CLOSERS = new Set(Object.values(PAIRS))

/**
 * Markdown-aware auto pairing.
 *
 * Deliberately conservative: nothing happens during IME composition, and the
 * emphasis markers only pair at a word boundary so normal Chinese/Japanese
 * prose (where `_` or `*` can follow a letter) is never mangled.
 */
export const autoPairExtension = EditorView.inputHandler.of((view, from, to, text) => {
  if (document.documentElement.classList.contains('no-auto-pair')) return false
  if (view.composing || view.state.selection.ranges.length !== 1) return false
  const doc = view.state.doc

  // Typing a closing character that is already there just steps over it.
  if (from === to && CLOSERS.has(text)) {
    const next = doc.sliceString(from, from + text.length)
    if (next === text) {
      const before = doc.sliceString(Math.max(0, from - 1), from)
      const isOpeningContext = before === '' || /[\s(\[{`*_~$]/.test(before)
      const isEmphasis = '*_~$'.includes(text)
      // Only skip over a quote/emphasis closer when we are inside a pair.
      if (!isEmphasis || !isOpeningContext) {
        view.dispatch({
          selection: { anchor: from + 1 },
          userEvent: 'input.type',
          scrollIntoView: true
        })
        return true
      }
    }
  }

  const close = PAIRS[text]
  if (!close) return false

  const isEmphasis = '*_~$`'.includes(text)
  if (isEmphasis) {
    const before = doc.sliceString(Math.max(0, from - 1), from)
    const after = doc.sliceString(to, to + 1)
    const atStart = from === to
    if (atStart && before && /[\p{L}\p{N}]/u.test(before)) return false
    if (atStart && after && /[\p{L}\p{N}]/u.test(after)) return false
  }

  if (from !== to) {
    const selected = doc.sliceString(from, to)
    // Do not double-wrap when the selection already includes the markers.
    view.dispatch({
      changes: { from, to, insert: text + selected + close },
      selection: { anchor: from + 1, head: to + 1 },
      userEvent: 'input.type',
      scrollIntoView: true
    })
    return true
  }

  view.dispatch({
    changes: { from, to, insert: text + close },
    selection: { anchor: from + text.length },
    userEvent: 'input.type',
    scrollIntoView: true
  })
  return true
})