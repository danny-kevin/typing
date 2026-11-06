import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Everything visual comes from CSS custom properties in style.css so the light
 * and dark themes (and user font preferences) switch without re-creating the
 * editor.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 17px)',
    color: 'var(--text)',
    backgroundColor: 'transparent'
  },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font-family)',
    lineHeight: 'var(--editor-line-height, 1.75)',
    overflow: 'auto',
    padding: '0 0 45vh 0'
  },
  '.cm-content': {
    padding: 'clamp(24px, 6vh, 72px) 0 0 0',
    maxWidth: 'var(--editor-width, 720px)',
    margin: '0 auto',
    caretColor: 'var(--accent)',
    width: '100%'
  },
  '.cm-line': {
    padding: '0 clamp(8px, 2vw, 24px)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important'
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--code-bg)', border: 'none', color: 'var(--muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    color: 'var(--text)',
    boxShadow: 'var(--shadow)'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'normal' },
  '.cm-gutters': { display: 'none' }
})

export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono-font-family)', fontSize: '0.9em' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.list, color: 'var(--text)' },
  { tag: t.comment, color: 'var(--muted)' },
  { tag: t.keyword, color: 'var(--syntax-keyword)' },
  { tag: t.string, color: 'var(--syntax-string)' },
  { tag: t.number, color: 'var(--syntax-number)' },
  { tag: t.bool, color: 'var(--syntax-number)' },
  { tag: t.function(t.variableName), color: 'var(--syntax-function)' },
  { tag: t.typeName, color: 'var(--syntax-type)' },
  { tag: t.propertyName, color: 'var(--syntax-property)' },
  { tag: t.operator, color: 'var(--syntax-operator)' },
  { tag: t.punctuation, color: 'var(--syntax-punct)' },
  { tag: t.invalid, color: 'var(--danger)' }
])