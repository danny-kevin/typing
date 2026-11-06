import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { continueList, tableContextAt, applyTableOp, lineRangeAt } from '../../../shared/markdown'

/** Enter inside a list continues it; on an empty item it ends the list. */
function handleEnter(view: EditorView): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (sel.from !== sel.to) return false
  const pos = sel.from
  const edit = continueList(view.state.doc.toString(), pos)
  if (!edit) {
    // Inside a table, Enter at the end of a row adds a row (Typora-like).
    const ctx = tableContextAt(view.state.doc.toString(), pos)
    if (ctx) {
      const lineEnd = view.state.doc.lineAt(pos).to
      if (pos === lineEnd) {
        const op = applyTableOp(view.state.doc.toString(), pos, { kind: 'addRowBelow' })
        if (op) {
          view.dispatch({ changes: op.changes, selection: op.selection, scrollIntoView: true })
          return true
        }
      }
    }
    return false
  }
  view.dispatch({
    changes: edit.changes,
    selection: edit.selection,
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

function indentList(view: EditorView, outdent: boolean): boolean {
  const sel = view.state.selection.main
  const doc = view.state.doc.toString()
  const { from, to } = lineRangeAt(doc, sel.from)
  const line = doc.slice(from, to)
  if (!/^\s*([-*+]|\d+[.)])\s+/.test(line)) return false
  const change = outdent
    ? { from, to: Math.min(to, from + 2), insert: line.slice(0, 2) === '  ' ? '' : '' }
    : { from, to: from, insert: '  ' }
  if (outdent && line.startsWith('  ')) {
    view.dispatch({ changes: { from, to: from + 2, insert: '' }, scrollIntoView: true })
    return true
  }
  if (outdent) return true
  view.dispatch({ changes: change, scrollIntoView: true })
  return true
}

export const listKeymap = Prec.high(
  keymap.of([
    { key: 'Enter', run: handleEnter },
    { key: 'Tab', run: (v) => indentList(v, false) },
    { key: 'Shift-Tab', run: (v) => indentList(v, true) }
  ])
)