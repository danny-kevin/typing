import { EditorState, Compartment, EditorSelection } from '@codemirror/state'
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  placeholder as placeholderExt
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches } from '@codemirror/search'
import { livePreview, livePreviewOptions } from './live-preview'
import { editorTheme, markdownHighlight } from './theme'
import { autoPairExtension } from './auto-pair'
import { smartPasteExtension } from './smart-paste'
import { listKeymap } from './list-keys'
import { currentMatchField, searchHighlightField } from '../search'

export interface EditorHooks {
  onChange: () => void
  onSelection: () => void
  onScroll: () => void
  onFocus: () => void
  onBlur: () => void
}

export interface EditorController {
  view: EditorView
  setText: (text: string) => void
  getText: () => string
  setSourceMode: (source: boolean) => void
  setFocusMode: (on: boolean) => void
  setSpellCheck: (on: boolean) => void
  setAutoPair: (on: boolean) => void
  setSmartPaste: (on: boolean) => void
  undo: () => void
  redo: () => void
  apply: (changes: { from: number; to: number; insert: string }, selection?: { anchor: number; head?: number }) => void
  setSelection: (from: number, to?: number, scroll?: boolean) => void
  focus: () => void
  centerCursor: () => void
}

const previewConf = new Compartment()
const historyConf = new Compartment()

export function createEditor(parent: HTMLElement, hooks: EditorHooks): EditorController {
  let sourceMode = false

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) hooks.onChange()
    if (u.selectionSet || u.docChanged) hooks.onSelection()
    if (u.focusChanged) (u.view.hasFocus ? hooks.onFocus : hooks.onBlur)()
  })

  const state = EditorState.create({
    doc: '',
    extensions: [
      historyConf.of(history()),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      highlightActiveLine(),
      searchHighlightField,
      currentMatchField,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
        'aria-label': 'Document editor'
      }),
      placeholderExt('Start writing…'),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
      syntaxHighlighting(markdownHighlight),
      editorTheme,
      previewConf.of(livePreview),
      autoPairExtension,
      smartPasteExtension,
      listKeymap,
      keymap.of([
        indentWithTab,
        // Bindings owned by the application (menu bar commands) must not be
        // swallowed by the editor keymap: removing them lets the key event
        // reach the menu accelerator, which dispatches the app command.
        ...defaultKeymap.filter(
          (b) => !['Mod-/', 'Mod-[', 'Mod-]', 'Mod-Enter'].includes(b.key ?? '')
        ),
        ...closeBracketsKeymap,
        ...historyKeymap
      ]),
      updateListener,
      EditorView.domEventHandlers({
        scroll: () => {
          hooks.onScroll()
          return false
        }
      })
    ]
  })

  const view = new EditorView({ state, parent })

  return {
    view,
    setText(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: false
      })
      // A new document starts with an empty undo history: ⌘Z must never restore
      // text from the file that was open a moment ago. Reconfiguring the history
      // compartment out and back re-initialises its state field.
      view.dispatch({ effects: historyConf.reconfigure([]) })
      view.dispatch({ effects: historyConf.reconfigure(history()) })
      view.scrollDOM.scrollTop = 0
    },
    getText: () => view.state.doc.toString(),
    setSourceMode(source: boolean) {
      sourceMode = source
      view.dispatch({ effects: previewConf.reconfigure(source ? [] : livePreview) })
      document.documentElement.classList.toggle('source-mode', source)
    },
    setFocusMode(on: boolean) {
      livePreviewOptions.focusMode = on
      document.documentElement.classList.toggle('focus-mode', on)
      view.dispatch({ effects: previewConf.reconfigure(sourceMode ? [] : livePreview) })
      if (!sourceMode) {
        // Force an immediate decoration rebuild so dimming appears at once.
        view.dispatch({ selection: { anchor: view.state.selection.main.anchor } })
      }
    },
    setSpellCheck(on: boolean) {
      view.contentDOM.spellcheck = on
      view.contentDOM.setAttribute('autocorrect', on ? 'on' : 'off')
    },
    setAutoPair(on: boolean) {
      document.documentElement.classList.toggle('no-auto-pair', !on)
    },
    setSmartPaste(on: boolean) {
      document.documentElement.classList.toggle('no-smart-paste', !on)
    },
    undo: () => {
      undo(view)
    },
    redo: () => {
      redo(view)
    },
    apply(changes, selection) {
      view.dispatch({
        changes,
        selection: selection ? { anchor: selection.anchor, head: selection.head ?? selection.anchor } : undefined,
        scrollIntoView: true
      })
      view.focus()
    },
    setSelection(from: number, to?: number, scroll = true) {
      const anchor = Math.max(0, Math.min(from, view.state.doc.length))
      const head = Math.max(0, Math.min(to ?? from, view.state.doc.length))
      view.dispatch({ selection: EditorSelection.single(anchor, head), scrollIntoView: scroll })
      view.focus()
    },
    focus: () => view.focus(),
    centerCursor() {
      const head = view.state.selection.main.head
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
    }
  }
}

export { livePreviewOptions }