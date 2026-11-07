import './style.css'
import 'katex/dist/katex.min.css'
import { EditorView } from '@codemirror/view'
import type { Prefs, FileReadResult, SaveOutcome } from '../../shared/types'
import { DEFAULT_PREFS } from '../../shared/types'
import type { Eol } from '../../shared/doc'
import {
  countStats,
  extractOutline,
  tableContextAt,
  lineRangeAt,
  toggleTaskAt
} from '../../shared/markdown'
import { scanInlineLine } from '../../shared/inline'
import { createEditor, type EditorController } from './editor/editor'
import { setDocContext, resolveAssetUrl } from './editor/widgets'
import * as fmt from './editor/format'
import {
  findMatches,
  searchHighlightField,
  currentMatchField,
  setSearchHighlights,
  setCurrentMatch,
  type Match
} from './search'
import * as ui from './ui'
import { buildExportHtml } from './export'
import { livePreviewOptions } from './editor/live-preview'
import { commandForEvent, displayAccelerator, isMacPlatform } from '../../shared/commands'
import { baseName, dirName, joinPath, prettyPath, relativePath, toPosixPath } from '../../shared/paths'

interface Api {
  call: (method: string, ...args: unknown[]) => Promise<any>
  on: (cb: (name: string, payload: any) => void) => () => void
  pathForFile: (file: File) => string
  refreshMenu: () => void
  platform: string
  testMode: boolean
}

const api = (window as unknown as { typing: Api }).typing

interface DocState {
  path: string | null
  baseMtimeMs: number
  /** sha256 of the bytes on disk the last time we read or wrote them. */
  baseHash: string
  eol: Eol
  /** Ending of each line on disk: 'c' CRLF, 'l' LF, 'r' lone CR. */
  lineEndings: string
  bom: boolean
  /** False when the file holds bytes that only decode with replacement chars. */
  validUtf8: boolean
  savedText: string
  externalChange: boolean
}

const doc: DocState = {
  path: null,
  baseMtimeMs: 0,
  baseHash: '',
  eol: '\n',
  lineEndings: '',
  bom: false,
  validUtf8: true,
  savedText: '',
  externalChange: false
}

/**
 * Bumped every time a different document is installed in the editor. An async
 * save compares it before it writes and before it adopts a result, so a save
 * started for one file can never land in (or relabel) another one.
 */
let docGeneration = 0
const isMac = isMacPlatform(api.platform)
/** The user's home directory, for `~`-shortened paths in the status bar. */
let homeDir: string | null = null

let prefs: Prefs = { ...DEFAULT_PREFS }
let editor: EditorController
let folderRoot: string | null = null
let folderFiles: string[] = []
let fileTree: ui.FileTree
let statusTimer = 0
let outlineTimer = 0
let autosaveTimer = 0
let draftTimer = 0
let findState = { matches: [] as Match[], index: -1, replaceMode: false }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  prefs = await api.call('prefs.get')
  applyThemeClass()
  document.documentElement.dataset.platform = api.platform
  document.documentElement.classList.add(`platform-${api.platform}`)
  document.documentElement.classList.toggle('platform-mac', isMac)
  try {
    const info = await api.call('appInfo')
    homeDir = typeof info?.home === 'string' ? info.home : null
  } catch {
    homeDir = null
  }
  applyShortcutLabels()

  editor = createEditor($('editor-host'), {
    onChange: onDocChange,
    onSelection: onSelectionChange,
    onScroll: () => {},
    onFocus: () => {},
    onBlur: () => {}
  })
  wireButtons()
  wireFindBar()
  wireDragAndDrop()
  wireLinks()
  wireGlobalKeys()
  applyPrefs()
  rebuildOutline()

  api.on((name, payload) => {
    switch (name) {
      case 'menu:command':
        void runCommand(payload.command)
        break
      case 'file:open-request':
        if (payload?.path) void openFile(payload.path)
        break
      case 'folder:open-request':
        if (payload?.path) void loadFolder(payload.path)
        break
      case 'file:external-change':
        void onExternalChange(payload.path)
        break
      case 'theme:changed':
        applyThemeClass()
        break
      default:
        break
    }
  })

  if (prefs.lastFolder) {
    folderRoot = prefs.lastFolder
    void loadFolder(prefs.lastFolder, false)
  }
  updateTitle()
  updateStatus()
  await offerRecovery()
  editor.focus()
}

function applyThemeClass(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** Print this platform's shortcut form into the toolbar tooltips. */
function applyShortcutLabels(): void {
  const set = (id: string, base: string, command: string): void => {
    const el = document.getElementById(id)
    if (!el) return
    const keys = displayAccelerator(command, api.platform)
    el.setAttribute('title', `${base} (${keys})`)
  }
  set('btn-source', 'Source code mode', 'view.source')
  set('btn-outline', 'Outline', 'view.outline')
  set('btn-sidebar', 'File sidebar', 'view.sidebar')
  set('find-prev', 'Previous', 'find.prev')
  set('find-next', 'Next', 'find.next')
  set('btn-open-folder', 'Open folder', 'doc.openFolder')
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeClass)

function applyPrefs(): void {
  const root = document.documentElement
  root.style.setProperty('--editor-font-size', `${prefs.fontSize}px`)
  root.style.setProperty('--editor-width', `${prefs.editorWidth}px`)
  root.style.setProperty('--editor-line-height', String(prefs.lineHeight))
  if (prefs.fontFamily) root.style.setProperty('--editor-font-family', prefs.fontFamily)
  else root.style.removeProperty('--editor-font-family')
  root.classList.toggle('source-mode', prefs.sourceMode)
  editor.setSourceMode(prefs.sourceMode)
  editor.setSpellCheck(prefs.spellCheck)
  editor.setAutoPair(prefs.autoPair)
  editor.setSmartPaste(prefs.smartPaste)
  livePreviewOptions.focusMode = prefs.focusMode
  editor.setFocusMode(prefs.focusMode)
  $('outline').classList.toggle('hidden', !prefs.showOutline)
  setToggleState('btn-outline', prefs.showOutline)
  setToggleState('btn-source', prefs.sourceMode)
  setToggleState('btn-sidebar', !$('sidebar').classList.contains('hidden'))
  updateModeChip()
  api.refreshMenu()
}

/** Keep the title-bar toggle buttons in sync with the state they control. */
function setToggleState(id: string, on: boolean): void {
  const el = $(id)
  el.classList.toggle('active', on)
  el.setAttribute('aria-pressed', String(on))
}

async function setPrefs(patch: Partial<Prefs>): Promise<void> {
  prefs = { ...prefs, ...patch }
  await api.call('prefs.set', patch)
  applyPrefs()
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

function isDirty(): boolean {
  return editor.getText() !== doc.savedText
}

function onDocChange(): void {
  updateTitle()
  document.documentElement.classList.toggle('dirty', isDirty())
  scheduleStatus()
  scheduleOutline()
  scheduleAutosave()
  scheduleDraft()
  if (findState.matches.length) computeMatches()
}

function onSelectionChange(): void {
  updateCursorStatus()
  scheduleOutline()
  if (prefs.typewriterMode) editor.centerCursor()
  if (findState.matches.length) updateCurrentMatch()
}

function scheduleStatus(): void {
  if (statusTimer) window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(updateStatus, 220)
}

function scheduleOutline(): void {
  if (outlineTimer) window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(rebuildOutline, 250)
}

function scheduleAutosave(): void {
  if (!prefs.autoSave || !doc.path) return
  // A file whose bytes are not valid UTF-8 must never be rewritten in place by
  // a background write; the user has to choose Save As explicitly.
  if (!doc.validUtf8) return
  // While a change on disk is unresolved, autosave would quietly rewrite the
  // file as a conflict copy; wait for the user's answer instead.
  if (doc.externalChange) return
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    if (doc.path && isDirty()) void save(false, { autosave: true })
  }, prefs.autoSaveMs)
}

function scheduleDraft(): void {
  if (draftTimer) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    if (!isDirty()) return
    void api.call('recovery.save', {
      path: doc.path,
      text: editor.getText(),
      savedAt: Date.now(),
      baseMtimeMs: doc.baseMtimeMs
    })
  }, 900)
}

/** Drop the writes that were scheduled for the document we are leaving. */
function cancelPendingWrites(): void {
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  if (draftTimer) window.clearTimeout(draftTimer)
  autosaveTimer = 0
  draftTimer = 0
}

function updateTitle(): void {
  const name = doc.path ? baseName(doc.path) : 'Untitled'
  const dirty = isDirty()
  const title = `${dirty ? '• ' : ''}${name} — Typing`
  document.title = title
  $('doc-title').textContent = `${dirty ? '• ' : ''}${name}${doc.externalChange ? ' (changed on disk)' : ''}`
  void api.call('window.setTitle', title, doc.path ?? '')
  void api.call('window.setDocumentEdited', dirty)
}

function updateStatus(): void {
  const text = editor.getText()
  const stats = countStats(text)
  $('status-words').textContent = `${stats.words} words · ${stats.chars} chars`
  $('status-left').textContent = doc.path ? prettyPath(doc.path, homeDir) : 'Not saved yet'
  updateCursorStatus()
  updateSaveChip()
  updateModeChip()
}

function updateCursorStatus(): void {
  const sel = editor.view.state.selection.main
  const line = editor.view.state.doc.lineAt(sel.from)
  const col = sel.from - line.from + 1
  const selected = sel.to - sel.from
  $('status-cursor').textContent = selected
    ? `Ln ${line.number}, Col ${col} · ${selected} selected`
    : `Ln ${line.number}, Col ${col}`
}

function updateSaveChip(): void {
  const chip = $('status-save')
  if (!doc.path) chip.textContent = 'unsaved'
  else if (doc.externalChange) {
    chip.textContent = 'changed on disk'
    chip.classList.add('warn')
    return
  } else if (isDirty()) chip.textContent = prefs.autoSave ? 'autosaving…' : 'unsaved changes'
  else chip.textContent = 'saved'
  chip.classList.remove('warn')
}

function updateModeChip(): void {
  const chip = $('status-mode')
  const bits: string[] = []
  if (prefs.sourceMode) bits.push('source')
  else bits.push('live')
  if (prefs.focusMode) bits.push('focus')
  if (prefs.typewriterMode) bits.push('typewriter')
  chip.textContent = bits.join(' · ')
}

function setDocument(
  text: string,
  meta: Partial<DocState> & { path: string | null }
): void {
  docGeneration++
  cancelPendingWrites()
  resetFindState()
  doc.path = meta.path
  doc.baseMtimeMs = meta.baseMtimeMs ?? 0
  doc.baseHash = meta.baseHash ?? ''
  doc.eol = meta.eol ?? '\n'
  doc.lineEndings = meta.lineEndings ?? ''
  doc.bom = meta.bom ?? false
  doc.validUtf8 = meta.validUtf8 ?? true
  doc.externalChange = false
  doc.savedText = text
  setDocContext(meta.path ?? '')
  editor.setText(text)
  doc.savedText = editor.getText()
  ui.hideBanner()
  updateTitle()
  updateStatus()
  rebuildOutline()
  if (meta.path) fileTree?.select(meta.path)
  void api.call('window.setRepresentedFile', meta.path ?? '')
  $('editor-host').scrollTop = 0
  editor.setSelection(0, 0, false)
}

/** Search results belong to one document; a switch must not keep them. */
function resetFindState(): void {
  findState = { matches: [], index: -1, replaceMode: findState.replaceMode }
  editor.view.dispatch({ effects: [setSearchHighlights.of([]), setCurrentMatch.of(null)] })
  const count = $('find-count')
  if (count) count.textContent = ''
}

/**
 * The one gate every document switch goes through (new, open, quick open, file
 * tree, recents, drag and drop, an external open request, close and quit).
 *
 * Returns true only when it is safe to replace the editor's contents: the save
 * the user asked for finished, or the user explicitly chose to discard. A failed
 * save, a cancelled Save As, or an unresolved conflict with another writer all
 * return false so the switch is abandoned and the text stays put.
 *
 * Kept deliberately small and side-effect free: the tab support that follows is
 * expected to call this same function.
 */
let guardInFlight = false

async function guardUnsavedWork(): Promise<boolean> {
  if (!isDirty()) return true
  if (guardInFlight) return false
  const name = doc.path ? (doc.path.split('/').pop() ?? 'Untitled') : 'Untitled'
  guardInFlight = true
  try {
    const choice = await ui.choiceDialog(
      'Unsaved changes',
      `“${name}” has changes that are not saved.`,
      [
        { label: 'Cancel', value: 'cancel' },
        { label: "Don't Save", value: 'discard' },
        { label: 'Save', value: 'save', primary: true }
      ]
    )
    if (choice === 'save') return await save(false)
    return choice === 'discard'
  } finally {
    guardInFlight = false
  }
}

async function newDocument(): Promise<boolean> {
  if (!(await guardUnsavedWork())) return false
  setDocument('', { path: null, baseMtimeMs: 0, baseHash: '', eol: '\n', lineEndings: '', bom: false })
  ui.toast('New document')
  return true
}

async function openFile(path: string, options: { alreadyGuarded?: boolean } = {}): Promise<boolean> {
  if (!options.alreadyGuarded && !(await guardUnsavedWork())) return false
  const result = (await api.call('file.read', path)) as FileReadResult & { ok: boolean; error?: string }
  if (!result.ok) {
    ui.showBanner(`Could not open ${path}: ${result.error}`, [{ label: 'Dismiss', onClick: ui.hideBanner }])
    return false
  }
  setDocument(result.text, {
    path: result.path,
    baseMtimeMs: result.mtimeMs,
    baseHash: result.hash,
    eol: result.eol,
    lineEndings: result.lineEndings,
    bom: result.bom,
    validUtf8: result.validUtf8
  })
  if (!result.validUtf8) promptInvalidUtf8()
  return true
}

async function openFileDialog(): Promise<void> {
  const path = await api.call('dialog.openFile')
  if (path) await openFile(path)
}

async function loadFolder(dir: string, persist = true): Promise<void> {
  folderRoot = dir
  $('sidebar').classList.remove('hidden')
  $('btn-sidebar').classList.add('active')
  if (persist) await setPrefs({ lastFolder: dir })
  fileTree = fileTree ?? new ui.FileTree($('file-tree'), {
    list: (d) => api.call('dir.list', d),
    onOpen: (p) => void openFile(p),
    isMarkdown: (name) => /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(name)
  })
  await fileTree.setRoot(dir)
  folderFiles = await api.call('dir.walk', dir, 4000)
  if (doc.path) fileTree.select(doc.path)
}

interface SaveOptions {
  /** The user explicitly agreed to replace bytes that are not valid UTF-8. */
  acceptInvalidUtf8?: boolean
  /**
   * A background write. It never renames the document into a conflict copy:
   * if someone else has the file, it asks the user instead.
   */
  autosave?: boolean
}

async function save(saveAs = false, options: SaveOptions = {}): Promise<boolean> {
  // Snapshot the document *before* the first await: whatever happens while a
  // dialog or an IPC call is outstanding, this save writes this text to this
  // path and never the text of a document that replaced it.
  const generation = docGeneration
  const text = editor.getText()
  const baseMtimeMs = doc.baseMtimeMs
  const baseHash = doc.baseHash
  const { eol, bom } = doc

  let path = doc.path
  if (!path || saveAs) {
    const suggested = path ?? (folderRoot ? joinPath(folderRoot, 'Untitled.md') : 'Untitled.md')
    const picked = await api.call('dialog.saveAs', suggested)
    if (!picked) return false
    path = String(picked)
    saveAs = true
  }
  if (generation !== docGeneration) return false

  // A file that is not valid UTF-8 holds bytes decoding had to replace; never
  // rewrite it in place without an explicit choice.
  if (!saveAs && !options.acceptInvalidUtf8 && !doc.validUtf8 && text !== doc.savedText) {
    promptInvalidUtf8()
    return false
  }

  // `force` is only used when writing to a path the user just chose; an in-place
  // save always lets the main process protect a file that changed underneath us.
  const payload = {
    path,
    text,
    baseMtimeMs,
    baseHash,
    eol,
    bom,
    force: saveAs,
    acceptInvalidUtf8: options.acceptInvalidUtf8 === true,
    onConflict: options.autosave ? 'report' : 'copy'
  }
  const result = (saveAs ? await api.call('file.saveAs', payload) : await api.call('file.save', payload)) as SaveOutcome
  if (generation !== docGeneration) return false
  if (!result || !('ok' in result) || !result.ok) {
    const failure = result as { error?: string; code?: string } | null
    if (failure?.code === 'invalid-utf8') {
      promptInvalidUtf8()
      return false
    }
    if (failure?.code === 'conflict') {
      // An autosave found someone else's version: stop writing and ask.
      await promptExternalChange()
      return false
    }
    const error = failure?.error ?? 'unknown error'
    ui.showBanner(`Could not save: ${error}`, [
      { label: 'Try again', primary: true, onClick: () => void save(saveAs, options) },
      { label: 'Dismiss', onClick: ui.hideBanner }
    ])
    return false
  }
  const reopened = result.recreated === true
  if (result.conflictCopy) {
    // The main process protected the file on disk; adopt the copy we just wrote.
    doc.path = result.conflictCopy
    doc.baseMtimeMs = result.mtimeMs
    doc.baseHash = result.hash
    doc.lineEndings = result.lineEndings
    doc.savedText = text
    doc.externalChange = false
    setDocContext(doc.path)
    await api.call('recovery.clear', path)
    updateTitle()
    updateStatus()
    ui.showBanner(`The original file changed on disk. Your version was saved as “${baseName(result.conflictCopy)}”.`, [
      { label: isMac ? 'Show in Finder' : 'Show in Explorer', onClick: () => void api.call('shell.showItemInFolder', result.conflictCopy!) },
      { label: 'Dismiss', onClick: ui.hideBanner }
    ])
    await refreshFolderFiles()
    // Not a save in place: anything that was waiting on this result (a close, a
    // document switch) stays where it is until the user has seen the copy.
    return false
  }
  doc.path = path
  doc.baseMtimeMs = result.mtimeMs
  doc.baseHash = result.hash
  doc.lineEndings = result.lineEndings
  doc.savedText = text
  doc.externalChange = false
  setDocContext(path)
  void api.call('recovery.clear', path)
  ui.hideBanner()
  updateTitle()
  updateStatus()
  if (reopened) ui.toast('Saved — the file had been deleted on disk and was created again')
  else if (!result.unchanged) ui.toast('Saved')
  await refreshFolderFiles()
  return true
}

/**
 * The file cannot be written back byte-for-byte because it holds bytes that are
 * not UTF-8. Offer the safe way out (a UTF-8 copy) instead of silently losing
 * the original bytes.
 */
function promptInvalidUtf8(): void {
  ui.showBanner(
    'This file contains bytes that are not valid UTF-8, so Typing cannot write it back unchanged. Save a UTF-8 copy instead.',
    [
      { label: 'Save As…', primary: true, onClick: () => void save(true) },
      {
        label: 'Overwrite as UTF-8',
        onClick: () => void save(false, { acceptInvalidUtf8: true })
      },
      { label: 'Dismiss', onClick: ui.hideBanner }
    ]
  )
}

/** Ask the user what to do about a file that changed under our feet. */
async function promptExternalChange(): Promise<void> {
  doc.externalChange = true
  updateTitle()
  updateSaveChip()
  ui.showBanner('This file changed on disk while you had unsaved edits.', [
    {
      label: 'Reload from disk',
      onClick: () => {
        if (doc.path) void openFile(doc.path, { alreadyGuarded: true })
      }
    },
    {
      label: 'Keep mine as a copy',
      primary: true,
      onClick: () => void save(false)
    },
    {
      label: 'Ignore',
      onClick: () => {
        doc.externalChange = false
        updateTitle()
        updateSaveChip()
        ui.hideBanner()
      }
    }
  ])
}

async function refreshFolderFiles(): Promise<void> {
  if (!folderRoot) return
  folderFiles = await api.call('dir.walk', folderRoot, 4000)
  await fileTree?.refresh()
  if (doc.path) fileTree?.select(doc.path)
}

async function revertToSaved(): Promise<void> {
  if (!doc.path) return
  const ok = await ui.confirmDialog('Revert to Saved', 'Discard your changes and reload the file from disk?', 'Revert')
  if (!ok) return
  await openFile(doc.path, { alreadyGuarded: true })
}

async function onExternalChange(path: string): Promise<void> {
  if (doc.path !== path) return
  const stat = await api.call('file.stat', path)
  if (!stat) {
    // Deleted while open: keep the text in the editor and say what a save does.
    ui.showBanner('This file was deleted outside Typing. Your text is still in the editor; saving will create the file again.', [
      { label: 'Dismiss', onClick: ui.hideBanner }
    ])
    return
  }
  if (!isDirty()) {
    const result = (await api.call('file.read', path)) as FileReadResult & { ok: boolean }
    if (result.ok) {
      const scrollTop = editor.view.scrollDOM.scrollTop
      setDocument(result.text, {
        path: result.path,
        baseMtimeMs: result.mtimeMs,
        baseHash: result.hash,
        eol: result.eol,
        lineEndings: result.lineEndings,
        bom: result.bom,
        validUtf8: result.validUtf8
      })
      editor.view.scrollDOM.scrollTop = scrollTop
      if (!result.validUtf8) promptInvalidUtf8()
      else ui.toast('Reloaded: the file changed on disk')
    }
    return
  }
  await promptExternalChange()
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

async function offerRecovery(): Promise<void> {
  type Draft = {
    key?: string
    path: string | null
    name: string
    text: string
    savedAt: number
  }
  const drafts = (await api.call('recovery.list')) as Draft[]
  if (!drafts.length) return
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  const candidates: Draft[] = []
  for (const draft of drafts) {
    const key = draft.key ?? draft.path ?? ''
    if (draft.savedAt < weekAgo || !draft.text.trim()) {
      if (key) await api.call('recovery.clear', key)
      continue
    }
    if (draft.path) {
      const disk = (await api.call('file.read', draft.path)) as FileReadResult & { ok: boolean }
      // Nothing to recover when the file already contains this text.
      if (disk.ok && disk.text === draft.text) {
        await api.call('recovery.clear', key)
        continue
      }
    }
    candidates.push(draft)
  }
  if (!candidates.length) return
  candidates.sort((a, b) => b.savedAt - a.savedAt)
  for (const draft of candidates.slice(0, 2)) {
    const when = new Date(draft.savedAt).toLocaleString()
    const ok = await ui.confirmDialog(
      'Recover unsaved work',
      `Typing found unsaved changes for “${draft.name}” from ${when}. Restore them?`,
      'Restore'
    )
    if (!ok) {
      await api.call('recovery.clear', draft.key ?? draft.path ?? '')
      continue
    }
    if (draft.path) {
      const result = (await api.call('file.read', draft.path)) as FileReadResult & { ok: boolean }
      if (result.ok) {
        setDocument(result.text, {
          path: result.path,
          baseMtimeMs: result.mtimeMs,
          baseHash: result.hash,
          eol: result.eol,
          lineEndings: result.lineEndings,
          bom: result.bom,
          validUtf8: result.validUtf8
        })
      }
    }
    const previous = editor.getText()
    editor.setText(draft.text)
    doc.savedText = draft.path ? previous : ''
    updateTitle()
    updateStatus()
    ui.toast('Recovered unsaved changes — save when ready')
    if (!draft.path) await api.call('recovery.clear', draft.key ?? '')
  }
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

function rebuildOutline(): void {
  if (!prefs.showOutline) return
  const text = editor.getText()
  if (text.length > 2_000_000) return
  const items = extractOutline(text)
  const cursorLine = editor.view.state.doc.lineAt(editor.view.state.selection.main.from).number
  ui.renderOutline(items, (item) => {
    editor.setSelection(item.from)
    const line = editor.view.state.doc.lineAt(item.from)
    editor.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 60 }) })
  }, cursorLine)
}

// ---------------------------------------------------------------------------
// Find and replace
// ---------------------------------------------------------------------------

function wireFindBar(): void {
  const input = $<HTMLInputElement>('find-input')
  const replaceInput = $<HTMLInputElement>('replace-input')
  input.addEventListener('input', () => {
    findState.index = -1
    computeMatches()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.shiftKey ? findPrev() : findNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    }
  })
  const opts = ['find-case', 'find-word', 'find-regex'] as const
  for (const id of opts) $(id).addEventListener('change', () => {
    findState.index = -1
    computeMatches()
  })
  $('find-next').addEventListener('click', findNext)
  $('find-prev').addEventListener('click', findPrev)
  $('find-close').addEventListener('click', closeFind)
  $('find-toggle-replace').addEventListener('click', () => {
    findState.replaceMode = !findState.replaceMode
    const show = findState.replaceMode
    replaceInput.classList.toggle('hidden', !show)
    $('replace-input').classList.toggle('hidden', !show)
    $('replace-one').classList.toggle('hidden', !show)
    $('replace-all').classList.toggle('hidden', !show)
    if (show) replaceInput.focus()
  })
  $('replace-one').addEventListener('click', () => replaceCurrent())
  $('replace-all').addEventListener('click', () => replaceAll())
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      replaceCurrent()
    } else if (e.key === 'Escape') {
      closeFind()
    }
  })
}

function findOptions(): { caseSensitive: boolean; regex: boolean; wholeWord: boolean } {
  return {
    caseSensitive: $<HTMLInputElement>('find-case').checked,
    regex: $<HTMLInputElement>('find-regex').checked,
    wholeWord: $<HTMLInputElement>('find-word').checked
  }
}

function computeMatches(): void {
  const query = $<HTMLInputElement>('find-input').value
  findState.matches = query ? findMatches(editor.getText(), query, findOptions()) : []
  editor.view.dispatch({ effects: setSearchHighlights.of(findState.matches) })
  if (findState.matches.length && findState.index === -1) {
    selectNearestMatch()
  } else if (!findState.matches.length) {
    editor.view.dispatch({ effects: setCurrentMatch.of(null) })
    $('find-count').textContent = query ? 'no results' : ''
  }
}

function selectNearestMatch(): void {
  const pos = editor.view.state.selection.main.from
  let nearest = 0
  for (let i = 0; i < findState.matches.length; i++) {
    if (findState.matches[i].to >= pos) {
      nearest = i
      break
    }
  }
  findState.index = nearest
  focusMatch(nearest, true)
}

function focusMatch(index: number, scroll = true): void {
  const match = findState.matches[index]
  if (!match) return
  editor.view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: scroll ? EditorView.scrollIntoView(match.from, { y: 'center' }) : []
  })
  editor.view.dispatch({ effects: setCurrentMatch.of(match) })
  $('find-count').textContent = `${index + 1} / ${findState.matches.length}`
}

function updateCurrentMatch(): void {
  if (!findState.matches.length) return
  const sel = editor.view.state.selection.main
  const idx = findState.matches.findIndex((m) => m.from === sel.from && m.to === sel.to)
  if (idx >= 0) findState.index = idx
}

function findNext(): void {
  if (!findState.matches.length) {
    computeMatches()
    if (!findState.matches.length) return
  }
  findState.index = (findState.index + 1) % findState.matches.length
  focusMatch(findState.index)
}

function findPrev(): void {
  if (!findState.matches.length) {
    computeMatches()
    if (!findState.matches.length) return
  }
  findState.index = (findState.index - 1 + findState.matches.length) % findState.matches.length
  focusMatch(findState.index)
}

function replaceCurrent(): void {
  const match = findState.matches[findState.index]
  if (!match) return
  const replacement = $<HTMLInputElement>('replace-input').value
  editor.view.dispatch({ changes: { from: match.from, to: match.to, insert: replacement } })
  computeMatches()
  findNext()
}

function replaceAll(): void {
  const replacement = $<HTMLInputElement>('replace-input').value
  const matches = findState.matches.slice().sort((a, b) => b.from - a.from)
  if (!matches.length) return
  editor.view.dispatch({ changes: matches.map((m) => ({ from: m.from, to: m.to, insert: replacement })) })
  ui.toast(`Replaced ${matches.length} occurrence${matches.length === 1 ? '' : 's'}`)
  computeMatches()
}

function openFind(replace = false, prefill?: string): void {
  $('findbar').classList.remove('hidden')
  const input = $<HTMLInputElement>('find-input')
  if (prefill) input.value = prefill
  if (replace && !findState.replaceMode) $('find-toggle-replace').click()
  input.focus()
  input.select()
  computeMatches()
}

function closeFind(): void {
  $('findbar').classList.add('hidden')
  editor.view.dispatch({ effects: [setSearchHighlights.of([]), setCurrentMatch.of(null)] })
  findState.matches = []
  editor.focus()
}

// ---------------------------------------------------------------------------
// Images: paste and drop
// ---------------------------------------------------------------------------

function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read error'))
    reader.readAsDataURL(file)
  })
}

async function insertImageData(dataUrl: string, suggestedName: string): Promise<void> {
  const result = await api.call('assets.saveImage', {
    docPath: doc.path,
    dataUrl,
    suggestedName
  })
  if (!result?.ok) {
    ui.showBanner(result?.error ?? 'Could not save the image next to your document.', [
      { label: 'Dismiss', onClick: ui.hideBanner }
    ])
    return
  }
  fmt.insertImage(editor.view, suggestedName.replace(/\.[a-z]+$/i, ''), result.relative)
  ui.toast('Image saved to assets/')
}

function wireDragAndDrop(): void {
  const host = $('editor-host')
  const clear = (): void => document.body.classList.remove('dragging')
  window.addEventListener('dragover', (e) => {
    e.preventDefault()
    document.body.classList.add('dragging')
  })
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) clear()
  })
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    clear()
    const dt = e.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files ?? [])
    if (!files.length) return
    const pos = editor.view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos !== null) editor.setSelection(pos)
    for (const file of files) {
      const path = api.pathForFile(file)
      if (!path) continue
      if (file.type.startsWith('image/')) {
        await insertImageData(await readFileAsDataUrl(file), file.name)
      } else if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(path)) {
        // Dropping a file into the window is another way of leaving the current
        // document, so it goes through the same guard.
        await openFile(path)
      }
    }
  })
  host.addEventListener('paste', (e) => void handlePaste(e))
  document.addEventListener('paste', (e) => void handlePaste(e))
}

let lastPasteHandled = 0

async function handlePaste(e: ClipboardEvent): Promise<void> {
  const now = Date.now()
  if (now - lastPasteHandled < 300) return
  const data = e.clipboardData
  if (!data) return
  const files = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (files.length) {
    e.preventDefault()
    lastPasteHandled = now
    for (const file of files) {
      await insertImageData(await readFileAsDataUrl(file), file.name || 'pasted-image')
    }
    return
  }
  if (Array.from(data.types ?? []).includes('image/png')) {
    const dataUrl = await api.call('clipboard.readImage')
    if (dataUrl) {
      e.preventDefault()
      lastPasteHandled = now
      await insertImageData(dataUrl, 'pasted-image')
    }
  }
}

function wireLinks(): void {
  editor.view.dom.addEventListener('mousedown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const pos = editor.view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos === null) return
    const line = editor.view.state.doc.lineAt(pos)
    const spans = scanInlineLine(line.text, line.from)
    const hit = spans.find((s) => s.kind === 'link' && pos >= s.from && pos <= s.to && s.url)
    if (hit?.url) {
      e.preventDefault()
      if (/#/.test(hit.url) && !/^https?:/i.test(hit.url)) {
        const anchor = hit.url.split('#')[1] ?? ''
        const items = extractOutline(editor.getText())
        const target = items.find((i) => i.text.toLowerCase().replace(/\s+/g, '-') === anchor.toLowerCase())
        if (target) editor.setSelection(target.from)
        return
      }
      if (/^https?:|^mailto:/i.test(hit.url)) void api.call('shell.openExternal', hit.url)
      else {
        const url = resolveAssetUrl(hit.url)
        if (url) ui.toast('Local link: ' + hit.url)
      }
    }
  })
}

function wireGlobalKeys(): void {
  // Capture phase so application shortcuts win over the editor keymap. Keys that
  // the editor needs are not in the command table.
  document.addEventListener(
    'keydown',
    (e) => {
      // An active IME owns every key: on Windows the composition candidate window
      // is driven with Enter, arrows and Escape, and stealing those breaks it.
      if (e.isComposing || e.keyCode === 229) return
      if (!$('overlay').classList.contains('hidden')) return
      const command = commandForEvent(e, isMac)
      if (!command) {
        if (e.key === 'Escape' && !$('findbar').classList.contains('hidden')) closeFind()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void runCommand(command)
    },
    true
  )
}

function wireButtons(): void {
  $('btn-source').addEventListener('click', () => void toggleSource())
  $('btn-outline').addEventListener('click', () => void setPrefs({ showOutline: !prefs.showOutline }))
  $('btn-sidebar').addEventListener('click', () => {
    const hidden = $('sidebar').classList.toggle('hidden')
    setToggleState('btn-sidebar', !hidden)
    if (!hidden && !folderRoot) void openFolder()
  })
  $('btn-open-folder').addEventListener('click', () => void openFolder())
}

async function openFolder(): Promise<void> {
  const dir = await api.call('dialog.openFolder')
  if (dir) await loadFolder(dir)
}

async function toggleSource(): Promise<void> {
  await setPrefs({ sourceMode: !prefs.sourceMode })
  const scrollTop = editor.view.scrollDOM.scrollTop
  editor.view.scrollDOM.scrollTop = scrollTop
  ui.toast(prefs.sourceMode ? 'Source mode' : 'Live preview')
}

// ---------------------------------------------------------------------------
// Command dispatch (menu bar + shortcuts)
// ---------------------------------------------------------------------------

async function runCommand(command: string): Promise<void> {
  const view = editor.view
  switch (command) {
    case 'doc.new':
      await newDocument()
      break
    case 'doc.open':
      await openFileDialog()
      break
    case 'doc.openFolder':
      await openFolder()
      break
    case 'doc.recent': {
      const items = await api.call('recents.list')
      ui.recentsDialog(items, (p) => void openFile(p), homeDir)
      break
    }
    case 'doc.save':
      await save(false)
      break
    case 'doc.saveAs':
      await save(true)
      break
    case 'doc.revert':
      await revertToSaved()
      break
    case 'app.close':
      await requestClose()
      break
    case 'nav.quickOpen':
      if (!folderRoot) {
        ui.toast('Open a folder first')
        break
      }
      ui.quickOpenDialog(folderFiles, (rel) => void openFile(joinPath(folderRoot!, rel)))
      break
    case 'edit.undo':
      editor.undo()
      break
    case 'edit.redo':
      editor.redo()
      break
    case 'edit.smartPaste':
      ui.toast('Paste rich content and it becomes Markdown automatically')
      break
    case 'find.open':
      openFind(false, view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      break
    case 'find.replace':
      openFind(true)
      break
    case 'find.next':
      findNext()
      break
    case 'find.prev':
      findPrev()
      break
    case 'format.bold':
      fmt.toggleInline(view, '**')
      break
    case 'format.italic':
      fmt.toggleInline(view, '*')
      break
    case 'format.strike':
      fmt.toggleInline(view, '~~')
      break
    case 'format.code':
      fmt.toggleInline(view, '`')
      break
    case 'format.link':
      fmt.insertLink(view)
      break
    case 'format.image':
      await pickImage()
      break
    case 'format.codeBlock':
      fmt.insertFencedBlock(view, '')
      break
    case 'format.quote':
      fmt.toggleLinePrefix(view, '> ')
      break
    case 'format.table':
      fmt.insertTable(view)
      break
    case 'format.math':
      fmt.insertMathBlock(view)
      break
    case 'format.hr':
      fmt.insertHr(view)
      break
    case 'format.footnote':
      fmt.insertFootnote(view)
      break
    case 'format.ul':
      fmt.toggleList(view, 'ul')
      break
    case 'format.ol':
      fmt.toggleList(view, 'ol')
      break
    case 'format.task':
      fmt.toggleTask(view)
      break
    case 'format.indent': {
      const sel = view.state.selection.main
      const text = view.state.doc.toString()
      const { from, to } = lineRangeAt(text, sel.from)
      view.dispatch({ changes: { from, to: from, insert: '  ' }, selection: { anchor: sel.from + 2 } })
      void to
      break
    }
    case 'format.outdent': {
      const sel = view.state.selection.main
      const text = view.state.doc.toString()
      const { from } = lineRangeAt(text, sel.from)
      if (text.slice(from, from + 2) === '  ') {
        view.dispatch({ changes: { from, to: from + 2, insert: '' }, selection: { anchor: Math.max(from, sel.from - 2) } })
      }
      break
    }
    case 'format.clear':
      fmt.clearFormatting(view)
      break
    case 'table.addRowBelow':
      fmt.tableOp(view, { kind: 'addRowBelow' })
      break
    case 'table.addRowAbove':
      fmt.tableOp(view, { kind: 'addRowAbove' })
      break
    case 'table.addColRight':
      fmt.tableOp(view, { kind: 'addColumnRight' })
      break
    case 'table.addColLeft':
      fmt.tableOp(view, { kind: 'addColumnLeft' })
      break
    case 'table.deleteRow':
      fmt.tableOp(view, { kind: 'deleteRow' })
      break
    case 'table.deleteCol':
      fmt.tableOp(view, { kind: 'deleteColumn' })
      break
    case 'table.align.left':
      fmt.tableOp(view, { kind: 'align', align: 'left' })
      break
    case 'table.align.center':
      fmt.tableOp(view, { kind: 'align', align: 'center' })
      break
    case 'table.align.right':
      fmt.tableOp(view, { kind: 'align', align: 'right' })
      break
    case 'view.source':
      await toggleSource()
      break
    case 'view.outline':
      await setPrefs({ showOutline: !prefs.showOutline })
      break
    case 'view.sidebar': {
      const hidden = $('sidebar').classList.toggle('hidden')
      setToggleState('btn-sidebar', !hidden)
      if (!hidden && !folderRoot) await openFolder()
      break
    }
    case 'view.focus':
      await setPrefs({ focusMode: !prefs.focusMode })
      ui.toast(prefs.focusMode ? 'Focus mode on' : 'Focus mode off')
      break
    case 'view.typewriter':
      await setPrefs({ typewriterMode: !prefs.typewriterMode })
      ui.toast(prefs.typewriterMode ? 'Typewriter mode on' : 'Typewriter mode off')
      break
    case 'export.html':
      await exportHtml()
      break
    case 'export.pdf':
      await exportPdf()
      break
    case 'app.prefs':
      ui.prefsDialog(prefs, (patch) => void setPrefs(patch))
      break
    case 'app.about': {
      const info = await api.call('appInfo')
      ui.aboutDialog(info)
      break
    }
    case 'app.shortcuts':
      ui.shortcutsDialog()
      break
    case 'app.usage':
      await showAppDoc('USAGE.md', 'Usage Guide')
      break
    case 'app.thirdparty':
      await showAppDoc('THIRD_PARTY.md', 'Third-Party Licenses')
      break
    default:
      if (command.startsWith('format.h') && command.length === 8) {
        const level = Number(command.slice(-1))
        fmt.setHeading(view, level)
      } else if (command === 'format.p') {
        fmt.setHeading(view, 0)
      }
      break
  }
}

/** ⌘W / ⌘Q: the same unsaved-work guard decides, then the window really closes. */
async function requestClose(): Promise<void> {
  if (!(await guardUnsavedWork())) return
  await api.call('window.close', true)
}

async function showAppDoc(file: string, title: string): Promise<void> {
  const text = await api.call('app.doc', file)
  ui.documentDialog(title, typeof text === 'string' ? text : 'The document is not available in this build.')
}

async function pickImage(): Promise<void> {
  const path = await api.call('dialog.pickImage')
  if (!path) return
  const name = baseName(String(path))
  const alt = name.replace(/\.[a-z0-9]+$/i, '')
  // Prefer a relative link when the image lives next to the document; a link
  // written into the document always uses forward slashes, on every platform.
  const dir = doc.path ? dirName(doc.path) : ''
  const relative = dir ? relativePath(dir, String(path)) : null
  const src = relative ?? toPosixPath(String(path))
  fmt.insertImage(editor.view, alt, src)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportBaseName(): string {
  const name = doc.path ? baseName(doc.path).replace(/\.md$/i, '') : 'Untitled'
  return name
}

async function exportHtml(): Promise<void> {
  const html = await buildExportHtml(editor.getText(), { title: exportBaseName(), docPath: doc.path })
  const suggested = doc.path ? doc.path.replace(/\.md$/i, '.html') : joinPath(folderRoot ?? '', 'Untitled.html')
  const result = await api.call('export.html', { html, suggestedPath: suggested })
  if (result?.ok) ui.toast('HTML exported')
  else if (result?.error && result.error !== 'canceled') ui.showBanner(`Export failed: ${result.error}`, [{ label: 'Dismiss', onClick: ui.hideBanner }])
}

async function exportPdf(): Promise<void> {
  const html = await buildExportHtml(editor.getText(), { title: exportBaseName(), docPath: doc.path })
  const suggested = doc.path ? doc.path.replace(/\.md$/i, '.pdf') : joinPath(folderRoot ?? '', 'Untitled.pdf')
  const result = await api.call('export.pdf', { html, suggestedPath: suggested, title: exportBaseName() })
  if (result?.ok) ui.toast('PDF exported')
  else if (result?.error && result.error !== 'canceled') ui.showBanner(`Export failed: ${result.error}`, [{ label: 'Dismiss', onClick: ui.hideBanner }])
}

// ---------------------------------------------------------------------------
// Misc helpers used by commands
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __typingTest?: {
      openFile: (path: string) => Promise<boolean>
      newDocument: () => Promise<boolean>
      command: (command: string) => Promise<void>
      getText: () => string
      save: () => Promise<boolean>
      insert: (text: string) => void
      isDirty: () => boolean
      path: () => string | null
      state: () => { path: string | null; baseHash: string; eol: Eol; lineEndings: string; validUtf8: boolean }
      focus: () => void
      tableContext: (pos: number) => unknown
      toggleTask: (pos: number) => void
      stats: () => ReturnType<typeof countStats>
    }
  }
}

if (api.testMode) {
  window.__typingTest = {
    openFile: (path: string) => openFile(path),
    newDocument: () => newDocument(),
    command: (command: string) => runCommand(command),
    getText: () => editor.getText(),
    save: () => save(false),
    insert: (text: string) => fmt.insertText(editor.view, text),
    isDirty: () => isDirty(),
    path: () => doc.path,
    state: () => ({
      path: doc.path,
      baseHash: doc.baseHash,
      eol: doc.eol,
      lineEndings: doc.lineEndings,
      validUtf8: doc.validUtf8
    }),
    focus: () => editor.focus(),
    tableContext: (pos: number) => tableContextAt(editor.getText(), pos),
    toggleTask: (pos: number) => {
      const edit = toggleTaskAt(editor.getText(), pos)
      if (edit) editor.apply(edit.changes[0], edit.selection)
    },
    stats: () => countStats(editor.getText())
  }
}

declare global {
  interface Window {
    /**
     * Renders the current document to a self-contained HTML string. Used by the
     * Export commands and by the automated export test; it is read-only.
     */
    typingExportHtml: () => Promise<string>
  }
}

boot()
  .then(() => {
    window.typingExportHtml = () =>
      buildExportHtml(editor.getText(), { title: exportBaseName(), docPath: doc.path })
  })
  .catch((err) => {
    console.error(err)
    const el = document.createElement('pre')
    el.textContent = `Typing failed to start: ${(err as Error).stack ?? err}`
    el.style.padding = '24px'
    document.body.appendChild(el)
  })