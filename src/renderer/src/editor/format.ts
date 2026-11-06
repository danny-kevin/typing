import { EditorView } from '@codemirror/view'
import * as md from '../../../shared/markdown'

function run(view: EditorView, edit: md.Edit | null): boolean {
  if (!edit) return false
  view.dispatch({ changes: edit.changes, selection: edit.selection, scrollIntoView: true, userEvent: 'input.format' })
  view.focus()
  return true
}

const primary = (view: EditorView): { from: number; to: number } => {
  const r = view.state.selection.main
  return { from: r.from, to: r.to }
}

export function toggleInline(view: EditorView, marker: string): boolean {
  const { from, to } = primary(view)
  return run(view, md.toggleInline(view.state.doc.toString(), from, to, marker))
}

export function setHeading(view: EditorView, level: number): boolean {
  const { from, to } = primary(view)
  return run(view, md.setHeadingLevel(view.state.doc.toString(), from, to, level))
}

export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const { from, to } = primary(view)
  return run(view, md.toggleLinePrefix(view.state.doc.toString(), from, to, prefix))
}

/** Toggle a bullet/ordered/task list on the selected lines. */
export function toggleList(view: EditorView, kind: 'ul' | 'ol' | 'task'): boolean {
  const text = view.state.doc.toString()
  const { from, to } = primary(view)
  const start = md.lineRangeAt(text, from).from
  const end = md.lineRangeAt(text, Math.min(text.length, to)).to
  const block = text.slice(start, end)
  const lines = block.split('\n')
  const prefixFor = (i: number): string => (kind === 'ul' ? '- ' : kind === 'task' ? '- [ ] ' : `${i + 1}. `)
  const escaped = kind === 'ol' ? 'ol' : kind
  const stripRe = kind === 'ol' ? /^\s*\d+[.)]\s+/ : kind === 'task' ? /^\s*[-*+]\s+\[[ xX]\]\s+/ : /^\s*[-*+]\s+/
  const already = lines.every((l) => l.trim() === '' || stripRe.test(l))
  const next = lines.map((l, i) => {
    if (l.trim() === '') return l
    if (already) return l.replace(stripRe, '')
    return prefixFor(i) + l.replace(stripRe, '')
  })
  const insert = next.join('\n')
  return run(view, {
    changes: [{ from: start, to: end, insert }],
    selection: { anchor: from + (insert.length - block.length), head: to + (insert.length - block.length) }
  })
}

export function insertTable(view: EditorView): boolean {
  const pos = view.state.selection.main.from
  return run(view, md.insertTable(view.state.doc.toString(), pos))
}

export function tableOp(view: EditorView, op: md.TableOp): boolean {
  const pos = view.state.selection.main.from
  const edit = md.applyTableOp(view.state.doc.toString(), pos, op)
  return run(view, edit)
}

/** Insert a fenced block at the caret's line, keeping the caret inside it. */
export function insertFencedBlock(view: EditorView, info: string, body = ''): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const { from, to } = md.lineRangeAt(text, sel.from)
  const selected = text.slice(sel.from, sel.to)
  const inner = selected || body
  const needsLeading = from > 0 && text[from - 1] !== '\n'
  const insert = `${needsLeading ? '\n' : ''}\`\`\`${info}\n${inner}\n\`\`\`\n`
  const caret = from + (needsLeading ? 1 : 0) + 3 + info.length + 1
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: caret + (selected ? inner.length : 0) },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  void to
  return true
}

export function insertMathBlock(view: EditorView): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const { from } = md.lineRangeAt(text, sel.from)
  const selected = text.slice(sel.from, sel.to)
  const needsLeading = from > 0 && text[from - 1] !== '\n'
  const insert = `${needsLeading ? '\n' : ''}$$\n${selected}\n$$\n`
  const caret = from + (needsLeading ? 1 : 0) + 3
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: caret, head: caret + selected.length },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertHr(view: EditorView): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const { from } = md.lineRangeAt(text, sel.from)
  const needsLeading = from > 0 && text[from - 1] !== '\n'
  const insert = `${needsLeading ? '\n' : ''}---\n`
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertFootnote(view: EditorView): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const used = new Set([...text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])))
  let n = 1
  while (used.has(n)) n++
  const insert = `[^${n}]`
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true
  })
  const definition = `\n[^${n}]: `
  view.dispatch({
    changes: { from: view.state.doc.length, to: view.state.doc.length, insert: definition },
    selection: { anchor: view.state.doc.length },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertLink(view: EditorView, url?: string): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const selected = text.slice(sel.from, sel.to)
  if (typeof url === 'string' && url !== '') {
    const insert = `[${selected || url}](${url})`
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.format'
    })
    view.focus()
    return true
  }
  // No URL yet: insert the skeleton and select the target placeholder.
  const insert = `[${selected}](url)`
  const targetStart = sel.from + 1 + selected.length + 2
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: targetStart, head: targetStart + 3 },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertImage(view: EditorView, alt: string, src: string): boolean {
  const sel = view.state.selection.main
  const insert = `![${alt}](${src})`
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertText(view: EditorView, text: string): boolean {
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function clearFormatting(view: EditorView): boolean {
  const sel = view.state.selection.main
  const text = view.state.doc.toString()
  const start = md.lineRangeAt(text, sel.from).from
  const end = md.lineRangeAt(text, Math.min(text.length, sel.to)).to
  const cleaned = text
    .slice(start, end)
    .split('\n')
    .map((l) => md.stripInline(l.replace(/^ {0,3}#{1,6}\s+/, '').replace(/^ {0,3}>\s?/, '')))
    .join('\n')
  view.dispatch({
    changes: { from: start, to: end, insert: cleaned },
    selection: { anchor: start, head: start + cleaned.length },
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function toggleTask(view: EditorView): boolean {
  const pos = view.state.selection.main.from
  const edit = md.toggleTaskAt(view.state.doc.toString(), pos)
  if (edit) return run(view, edit)
  return toggleList(view, 'task')
}