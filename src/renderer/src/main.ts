import './style.css'
import 'katex/dist/katex.min.css'
import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { encodeDoc, type EncodableDoc } from '../../shared/doc'
import type { HistoryReason } from '../../shared/history'
import { effectiveFormat, historyFormat, historyFormatEffect } from './history-format'
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
import { Tabs } from './tabs'

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
  deleted: boolean
  id: string
  editor: EditorController
  panel: HTMLElement
  sourceMode: boolean
  touched: boolean
  generation: number
  loading: boolean
  closing: boolean
  autosaveTimer: number
  draftTimer: number
  saveTask?: Promise<boolean>
  historyTask?: Promise<boolean>
  scrollSnapshot?: ReturnType<EditorView['scrollSnapshot']>
  scrollDoc?: EditorView['state']['doc']
}

const tabs = new Tabs<DocState>(api.platform)
let doc: DocState
let closingWindow = false
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

  createDocument('', { path: null })
  wireButtons()
  wireFindBar()
  wireDragAndDrop()
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
        applyThemeClass(payload?.dark)
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
  await api.call('renderer.ready')
  editor.focus()
}

function applyThemeClass(darkOverride?: boolean): void {
  const dark = typeof darkOverride === 'boolean' ? darkOverride : window.matchMedia('(prefers-color-scheme: dark)').matches
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
  set('btn-new-tab', 'New tab', 'tab.new')
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => applyThemeClass(event.matches))

function applyPrefs(): void {
  const root = document.documentElement
  root.style.setProperty('--editor-font-size', `${prefs.fontSize}px`)
  root.style.setProperty('--editor-width', `${prefs.editorWidth}px`)
  root.style.setProperty('--editor-line-height', String(prefs.lineHeight))
  if (prefs.fontFamily) root.style.setProperty('--editor-font-family', prefs.fontFamily)
  else root.style.removeProperty('--editor-font-family')
  root.classList.toggle('source-mode', doc.sourceMode)
  for (const tab of tabs.items) {
    tab.editor.setSourceMode(tab.sourceMode)
    tab.editor.setSpellCheck(prefs.spellCheck)
    tab.editor.setFocusMode(prefs.focusMode)
    scheduleAutosave(tab)
  }
  root.classList.toggle('source-mode', doc.sourceMode)
  editor.setAutoPair(prefs.autoPair)
  editor.setSmartPaste(prefs.smartPaste)
  livePreviewOptions.focusMode = prefs.focusMode
  $('outline').classList.toggle('hidden', !prefs.showOutline)
  setToggleState('btn-outline', prefs.showOutline)
  setToggleState('btn-source', doc.sourceMode)
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
  if (patch.sourceMode !== undefined) doc.sourceMode = patch.sourceMode
  prefs = { ...prefs, ...patch }
  await api.call('prefs.set', patch)
  prefs.sourceMode = doc.sourceMode
  applyPrefs()
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

function documentFormat(target = doc): EncodableDoc {
  return effectiveFormat(target.editor.view.state, { text: target.savedText, eol: target.eol, bom: target.bom, lineEndings: target.lineEndings })
}

function isDirty(target = doc): boolean {
  if (target.editor.getText() !== target.savedText) return true
  const format = documentFormat(target)
  return format.bom !== target.bom || format.eol !== target.eol || format.lineEndings !== target.lineEndings
}

/** Snapshot only at the destructive overwrite boundary; edits during I/O abort it. */
async function beforeOverwrite(target: DocState, reason: HistoryReason): Promise<boolean> {
  const state = target.editor.view.state
  const generation = target.generation
  const path = target.path
  if (!path) return false
  cancelPendingWrites(target)
  await api.call('history.capture', path, documentFormat(target), reason).catch(error => console.warn('History unavailable', error))
  return tabs.items.includes(target) && target.path === path && target.generation === generation && target.editor.view.state.doc === state.doc && target.editor.view.state.field(historyFormat) === state.field(historyFormat)
}

function onDocChange(target = doc): void {
  if (target.loading) return
  target.touched = true
  scheduleAutosave(target)
  scheduleDraft(target)
  renderTabs()
  if (target !== doc) return
  updateTitle()
  document.documentElement.classList.toggle('dirty', isDirty())
  scheduleStatus()
  scheduleOutline()
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

function scheduleAutosave(target = doc): void {
  if (target.autosaveTimer) window.clearTimeout(target.autosaveTimer)
  if (target.closing || closingWindow || !prefs.autoSave || !target.path || !target.validUtf8 || target.externalChange || target.historyTask) return
  target.autosaveTimer = window.setTimeout(() => {
    target.autosaveTimer = 0
    if (isDirty(target)) void save(false, { autosave: true }, target)
  }, prefs.autoSaveMs)
}

function persistDraft(target: DocState): void {
  if (!isDirty(target)) {
    void api.call('recovery.clear', target.id)
    return
  }
  void api.call('recovery.save', {
    key: target.id, path: target.path, text: target.editor.getText(), savedAt: Date.now(),
    baseMtimeMs: target.baseMtimeMs, baseHash: target.baseHash, savedText: target.savedText,
    eol: target.eol, lineEndings: target.lineEndings, bom: target.bom,
    validUtf8: target.validUtf8, sourceMode: target.sourceMode
  })
}

function scheduleDraft(target = doc): void {
  if (target.draftTimer) window.clearTimeout(target.draftTimer)
  if (target.closing) return
  target.draftTimer = window.setTimeout(() => {
    target.draftTimer = 0
    persistDraft(target)
  }, 300)
}

/** Cancel only this document's scheduled writes, never another tab's. */
function cancelPendingWrites(target = doc): void {
  window.clearTimeout(target.autosaveTimer)
  window.clearTimeout(target.draftTimer)
  target.autosaveTimer = target.draftTimer = 0
}

function updateTitle(): void {
  const name = doc.path ? baseName(doc.path) : 'Untitled'
  const dirty = isDirty()
  const title = `${dirty ? '• ' : ''}${name} — Typing`
  document.title = title
  $('doc-title').textContent = `${dirty ? '• ' : ''}${name}${doc.externalChange ? ' (changed on disk)' : ''}`
  void api.call('window.setTitle', title, doc.path ?? '')
  void api.call('window.setDocumentEdited', tabs.items.some(tab => isDirty(tab)))
  document.documentElement.classList.toggle('dirty', dirty)
  renderTabs()
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
  if (doc.sourceMode) bits.push('source')
  else bits.push('live')
  if (prefs.focusMode) bits.push('focus')
  if (prefs.typewriterMode) bits.push('typewriter')
  chip.textContent = bits.join(' · ')
}

function setDocument(text: string, meta: Partial<DocState> & { path: string | null }, target = doc): void {
  target.generation++
  target.scrollSnapshot = undefined
  target.scrollDoc = undefined
  cancelPendingWrites(target)
  Object.assign(target, {
    path: meta.path, baseMtimeMs: meta.baseMtimeMs ?? 0, baseHash: meta.baseHash ?? '',
    eol: meta.eol ?? '\n', lineEndings: meta.lineEndings ?? '', bom: meta.bom ?? false,
    validUtf8: meta.validUtf8 ?? true, externalChange: false, deleted: false, savedText: text
  })
  target.loading = true
  target.editor.setPath(meta.path ?? '')
  target.editor.setText(text)
  target.editor.view.dispatch({ effects: historyFormatEffect.of({ text, eol: target.eol, bom: target.bom, lineEndings: target.lineEndings }), annotations: Transaction.addToHistory.of(false) })
  target.loading = false
  target.savedText = target.editor.getText()
  void api.call('recovery.clear', target.id)
  if (target === doc) refreshActiveDocument()
}

function createDocument(text: string, meta: Partial<DocState> & { path: string | null }): DocState {
  const panel = document.createElement('div')
  panel.className = 'document-panel'
  panel.setAttribute('role', 'tabpanel')
  const target = {
    ...meta, id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), panel,
    sourceMode: prefs.sourceMode, touched: false, generation: 0, loading: true,
    closing: false, autosaveTimer: 0, draftTimer: 0
  } as DocState
  panel.id = `panel-${target.id}`
  panel.setAttribute('aria-labelledby', `tab-${target.id}`)
  target.editor = createEditor(panel, {
    onChange: () => onDocChange(target),
    onSelection: () => { if (!target.loading && target === doc) onSelectionChange() },
    onScroll: () => {}, onFocus: () => {}, onBlur: () => {}
  })
  tabs.add(target)
  setDocument(text, meta, target)
  target.editor.setSourceMode(target.sourceMode)
  wireEditorLinks(target.editor)
  activateTab(target)
  return target
}

function activateTab(target: DocState, focus = true): void {
  if (!tabs.items.includes(target)) return
  if (doc && doc !== target && tabs.items.includes(doc)) {
    doc.scrollSnapshot = doc.editor.view.scrollSnapshot()
    doc.scrollDoc = doc.editor.view.state.doc
    doc.panel.remove()
  }
  tabs.active = doc = target
  editor = target.editor
  prefs.sourceMode = target.sourceMode
  if (target.panel.parentElement !== $('editor-host')) $('editor-host').replaceChildren(target.panel)
  document.documentElement.classList.toggle('source-mode', target.sourceMode)
  editor.setSpellCheck(prefs.spellCheck)
  if (target.scrollSnapshot && target.scrollDoc === editor.view.state.doc) {
    editor.view.dispatch({ effects: target.scrollSnapshot })
  }
  target.scrollSnapshot = undefined
  target.scrollDoc = undefined
  editor.view.requestMeasure()
  refreshActiveDocument()
  if (focus) editor.focus()
  document.getElementById(`tab-${target.id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function refreshActiveDocument(): void {
  setDocContext(doc.path ?? '')
  resetFindState()
  updateTitle()
  updateStatus()
  rebuildOutline()
  setToggleState('btn-source', doc.sourceMode)
  void api.call('window.setRepresentedFile', doc.path ?? '')
  void api.call('menu.sourceMode', doc.sourceMode)
  if (doc.path) fileTree?.select(doc.path)
  ui.hideBanner()
  if (doc.deleted) showDeletedBanner()
  else if (doc.externalChange) void promptExternalChange(doc)
  else if (!doc.validUtf8) promptInvalidUtf8()
  if (!$('findbar').classList.contains('hidden')) computeMatches()
}

function renderTabs(): void {
  const strip = $('tab-list')
  if (!strip) return
  // Retain nodes while typing/focusing: keyboard focus and an ongoing drag must
  // not disappear merely because a dirty marker changed.
  for (const child of Array.from(strip.children)) {
    if (!tabs.items.some(tab => child.id === `item-${tab.id}`)) child.remove()
  }
  tabs.items.forEach((tab, index) => {
    let item = document.getElementById(`item-${tab.id}`)
    const name = tab.path ? baseName(tab.path) : 'Untitled'
    if (!item) {
      item = document.createElement('div')
      item.id = `item-${tab.id}`
      item.className = 'document-tab'
      item.draggable = true
      const button = document.createElement('button')
      button.id = `tab-${tab.id}`
      button.className = 'tab-label'
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', tab.panel.id)
      button.addEventListener('click', () => activateTab(tab))
      button.addEventListener('keydown', e => {
        let next: DocState | undefined
        if (e.altKey && e.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault()
          tabs.move(tab, tabs.items.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1))
          renderTabs()
          $(`tab-${tab.id}`).focus()
          return
        }
        if (e.key === 'ArrowRight') next = tabs.relative(1)
        else if (e.key === 'ArrowLeft') next = tabs.relative(-1)
        else if (e.key === 'Home') next = tabs.items[0]
        else if (e.key === 'End') next = tabs.items.at(-1)
        else if (e.key === 'Delete') { e.preventDefault(); void closeTab(tab); return }
        if (next) { e.preventDefault(); activateTab(next, false); $(`tab-${next.id}`).focus() }
      })
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.textContent = '×'
      close.addEventListener('click', () => void closeTab(tab))
      item.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); void closeTab(tab) } })
      item.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault() })
      item.addEventListener('dragstart', e => {
        e.dataTransfer?.setData('application/x-typing-tab', tab.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      item.addEventListener('dragover', e => {
        if (e.dataTransfer?.types.includes('application/x-typing-tab')) e.preventDefault()
      })
      item.addEventListener('drop', e => {
        const id = e.dataTransfer?.getData('application/x-typing-tab')
        const moved = tabs.items.find(t => t.id === id)
        if (moved) { e.preventDefault(); e.stopPropagation(); tabs.move(moved, tabs.items.indexOf(tab)); renderTabs() }
      })
      item.append(button, close)
    }
    const button = item.querySelector('.tab-label')!
    button.textContent = `${isDirty(tab) ? '• ' : ''}${name}${tab.externalChange || tab.deleted ? ' !' : ''}`
    button.setAttribute('aria-label', `${name}${isDirty(tab) ? ', unsaved changes' : ''}${tab.externalChange || tab.deleted ? ', changed on disk' : ''}`)
    button.setAttribute('aria-selected', String(tab === doc))
    button.setAttribute('tabindex', tab === doc ? '0' : '-1')
    item.querySelector('.tab-close')!.setAttribute('aria-label', `Close ${name}`)
    item.classList.toggle('active', tab === doc)
    item.title = tab.path ?? 'Untitled'
    if (strip.children[index] !== item) strip.insertBefore(item, strip.children[index] ?? null)
  })
}

/** Search results belong to one document; a switch must not keep them. */
function resetFindState(): void {
  findState = { matches: [], index: -1, replaceMode: findState.replaceMode }
  editor.view.dispatch({ effects: [setSearchHighlights.of([]), setCurrentMatch.of(null)] })
  const count = $('find-count')
  if (count) count.textContent = ''
}

/**
 * The per-document gate for closing a tab, a window, or quitting. Opening and
 * switching tabs never discard a document and therefore do not need this gate.
 *
 * Returns true only when it is safe to close this tab: the save
 * the user asked for finished, or the user explicitly chose to discard. A failed
 * save, a cancelled Save As, or an unresolved conflict with another writer all
 * return false so the close is abandoned and the text stays put.
 */
let guardInFlight = false

async function guardUnsavedWork(target = doc): Promise<boolean> {
  if (!isDirty(target)) return true
  if (guardInFlight) return false
  activateTab(target)
  const name = target.path ? baseName(target.path) : 'Untitled'
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
    if (choice === 'save') return await save(false, {}, target) && !isDirty(target)
    return choice === 'discard'
  } finally {
    guardInFlight = false
  }
}

async function newDocument(): Promise<boolean> {
  if (closingWindow || guardInFlight) return false
  createDocument('', { path: null })
  return true
}

async function disposeTab(target: DocState): Promise<void> {
  cancelPendingWrites(target)
  tabs.close(target)
  target.panel.remove()
  target.editor.view.destroy()
  await api.call('recovery.clear', target.id)
  if (target.path && !tabs.find(target.path)) await api.call('file.release', target.path)
}

async function closeTab(target = doc): Promise<void> {
  if (closingWindow || guardInFlight || target.closing) return
  target.closing = true
  cancelPendingWrites(target)
  try {
    if (target.historyTask) await target.historyTask
    if (target.saveTask) await target.saveTask
    if (!(await guardUnsavedWork(target))) return
    await disposeTab(target)
    if (tabs.active) activateTab(tabs.active)
    else await api.call('window.close', true)
  } finally {
    target.closing = false
    if (tabs.items.includes(target)) { scheduleAutosave(target); scheduleDraft(target) }
  }
}

type OpenOptions = { alreadyGuarded?: boolean; target?: DocState; historyReason?: HistoryReason }
let opening = Promise.resolve(true)
function openFile(path: string, options: OpenOptions = {}): Promise<boolean> {
  const task = opening.catch(() => false).then(() => openFileInTab(path, options))
  opening = task
  return task
}

async function openFileInTab(path: string, options: OpenOptions): Promise<boolean> {
  if (closingWindow || guardInFlight) return false
  path = await api.call('file.resolve', path)
  const saving = savingPaths.get(pathKey(path))
  if (saving?.saveTask) await saving.saveTask
  const existing = tabs.find(path)
  if (existing && !options.alreadyGuarded) { activateTab(existing); return true }
  const result = (await api.call('file.read', path)) as FileReadResult & { ok: boolean; error?: string }
  if (!result.ok) {
    ui.showBanner(`Could not open ${path}: ${result.error}`, [{ label: 'Dismiss', onClick: ui.hideBanner }])
    return false
  }
  if (closingWindow) return false
  const duplicate = tabs.find(result.path)
  if (duplicate && !options.alreadyGuarded) { activateTab(duplicate); return true }
  const meta = { ...result, baseMtimeMs: result.mtimeMs, baseHash: result.hash }
  if (options.alreadyGuarded) {
    const target = options.target ?? doc
    if (!tabs.items.includes(target)) return false
    if (target.saveTask) await target.saveTask
    if (!(await beforeOverwrite(target, options.historyReason ?? 'before-reload'))) {
      ui.toast('Reload cancelled because the document changed while history was being saved.')
      return false
    }
    setDocument(result.text, meta, target)
  } else {
    const empty = doc.path === null && !doc.touched && !isDirty() && !editor.getText()
    const replaced = empty ? doc : null
    createDocument(result.text, meta)
    if (replaced) await disposeTab(replaced)
    renderTabs()
  }
  if (!result.validUtf8) promptInvalidUtf8()
  return true
}

async function openFileDialog(): Promise<void> {
  const paths = await api.call('dialog.openFile')
  for (const path of Array.isArray(paths) ? paths : paths ? [paths] : []) await openFile(path)
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

const savingPaths = new Map<string, DocState>()
const pathKey = (path: string): string => api.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path

interface SaveOptions {
  /** The user explicitly agreed to replace bytes that are not valid UTF-8. */
  acceptInvalidUtf8?: boolean
  /**
   * A background write. It never renames the document into a conflict copy:
   * if someone else has the file, it asks the user instead.
   */
  autosave?: boolean
}

function save(saveAs = false, options: SaveOptions = {}, target = doc): Promise<boolean> {
  if (target.historyTask) return Promise.resolve(false)
  if (target.saveTask) return target.saveTask.then(ok => ok && !isDirty(target))
  const task = saveSnapshot(saveAs, options, target)
  target.saveTask = task
  void task.finally(() => {
    if (target.saveTask === task) target.saveTask = undefined
    for (const [path, owner] of savingPaths) if (owner === target) savingPaths.delete(path)
  }).catch(() => {})
  return task
}

async function saveSnapshot(saveAs: boolean, options: SaveOptions, target: DocState): Promise<boolean> {
  const doc = target
  const editor = target.editor
  // Snapshot the document *before* the first await: whatever happens while a
  // dialog or an IPC call is outstanding, this save writes this text to this
  // path and never the text of a document that replaced it.
  const generation = target.generation
  const text = editor.getText()
  const baseMtimeMs = doc.baseMtimeMs
  const baseHash = doc.baseHash
  const { eol, bom, lineEndings } = documentFormat(target)

  let path = doc.path
  if (!path || saveAs) {
    const suggested = path ?? (folderRoot ? joinPath(folderRoot, 'Untitled.md') : 'Untitled.md')
    const picked = await api.call('dialog.saveAs', suggested)
    if (!picked) return false
    path = await api.call('file.resolve', String(picked)) as string
    saveAs = true
  }
  if (generation !== target.generation || !tabs.items.includes(target)) return false
  const pathOwner = tabs.find(path)
  const pendingOwner = savingPaths.get(pathKey(path))
  if ((pathOwner && pathOwner !== target) || (pendingOwner && pendingOwner !== target)) {
    ui.toast('That file is already open in another tab. Choose another name.')
    return false
  }

  // A file that is not valid UTF-8 holds bytes decoding had to replace; never
  // rewrite it in place without an explicit choice.
  if (!saveAs && !options.acceptInvalidUtf8 && !doc.validUtf8 && text !== doc.savedText) {
    promptInvalidUtf8(target)
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
    lineEndings,
    force: saveAs,
    acceptInvalidUtf8: options.acceptInvalidUtf8 === true,
    onConflict: options.autosave ? 'report' : 'copy'
  }
  savingPaths.set(pathKey(path), target)
  const oldPath = target.path
  const result = (saveAs ? await api.call('file.saveAs', payload) : await api.call('file.save', payload)) as SaveOutcome
  if (generation !== target.generation || !tabs.items.includes(target)) return false
  if (!result || !('ok' in result) || !result.ok) {
    const failure = result as { error?: string; code?: string } | null
    if (failure?.code === 'invalid-utf8') {
      promptInvalidUtf8(target)
      return false
    }
    if (failure?.code === 'conflict') {
      // An autosave found someone else's version: stop writing and ask.
      await promptExternalChange(target)
      return false
    }
    const error = failure?.error ?? 'unknown error'
    ui.showBanner(`Could not save: ${error}`, [
      { label: 'Try again', primary: true, onClick: () => void save(saveAs, options, target) },
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
    doc.eol = result.eol
    doc.bom = result.bom
    target.editor.view.dispatch({ effects: historyFormatEffect.of({ text, eol: result.eol, bom: result.bom, lineEndings: result.lineEndings }), annotations: Transaction.addToHistory.of(false) })
    doc.savedText = text
    doc.externalChange = false
    doc.deleted = false
    editor.setPath(doc.path)
    if (oldPath) await api.call('file.release', oldPath)
    persistDraft(target)
    if (target === tabs.active) { setDocContext(doc.path); updateTitle(); updateStatus() }
    renderTabs()
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
  doc.eol = result.eol
  doc.bom = result.bom
  target.editor.view.dispatch({ effects: historyFormatEffect.of({ text, eol: result.eol, bom: result.bom, lineEndings: result.lineEndings }), annotations: Transaction.addToHistory.of(false) })
  doc.savedText = text
  doc.externalChange = false
  doc.deleted = false
  editor.setPath(path)
  if (oldPath && oldPath !== path) await api.call('file.release', oldPath)
  persistDraft(target)
  if (target === tabs.active) { setDocContext(path); ui.hideBanner(); updateTitle(); updateStatus() }
  renderTabs()
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
function promptInvalidUtf8(target = doc): void {
  if (target !== tabs.active) return
  ui.showBanner(
    'This file contains bytes that are not valid UTF-8, so Typing cannot write it back unchanged. Save a UTF-8 copy instead.',
    [
      { label: 'Save As…', primary: true, onClick: () => void save(true, {}, target) },
      {
        label: 'Overwrite as UTF-8',
        onClick: () => void save(false, { acceptInvalidUtf8: true }, target)
      },
      { label: 'Dismiss', onClick: ui.hideBanner }
    ]
  )
}

/** Ask the user what to do about a file that changed under our feet. */
async function promptExternalChange(target = doc): Promise<void> {
  target.externalChange = true
  cancelPendingWrites(target)
  persistDraft(target)
  renderTabs()
  if (target !== doc) return
  updateTitle()
  updateSaveChip()
  ui.showBanner('This file changed on disk while you had unsaved edits.', [
    {
      label: 'Reload from disk',
      onClick: () => {
        if (target.path) void openFile(target.path, { alreadyGuarded: true, target })
      }
    },
    {
      label: 'Keep mine as a copy',
      primary: true,
      onClick: () => void save(false, {}, target)
    },
    {
      label: 'Ignore',
      onClick: () => {
        target.externalChange = false
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
  const target = doc
  if (!target.path) return
  const ok = await ui.confirmDialog('Revert to Saved', 'Discard your changes and reload the file from disk?', 'Revert')
  if (!ok) return
  await openFile(target.path, { alreadyGuarded: true, target, historyReason: 'before-revert' })
  persistDraft(target)
}

/** Restore never writes the file directly or opts out of any save protection. */
function restoreHistory(id: string, target = doc): Promise<boolean> {
  if (target.historyTask || target.closing || closingWindow) return Promise.resolve(false)
  const task = restoreHistorySnapshot(id, target)
  target.historyTask = task
  cancelPendingWrites(target)
  void task.finally(() => {
    if (target.historyTask === task) target.historyTask = undefined
    if (tabs.items.includes(target)) { scheduleAutosave(target); scheduleDraft(target) }
  }).catch(() => {})
  return task
}

async function restoreHistorySnapshot(id: string, target: DocState): Promise<boolean> {
  if (target.saveTask) await target.saveTask
  const path = target.path
  const generation = target.generation
  if (!path || !tabs.items.includes(target)) return false
  const safe = (): boolean => tabs.items.includes(target) && target.path === path && target.generation === generation && !target.externalChange && !target.deleted && target.validUtf8
  const blocked = (): false => {
    ui.toast('Restore is unavailable: the file changed, was deleted, or is not valid UTF-8. Reload safely or copy the snapshot to a new tab.', 6500)
    return false
  }
  if (!safe()) return blocked()
  const snapshot = await api.call('history.read', path, id) as (EncodableDoc & { validUtf8: boolean }) | null
  if (!snapshot) { ui.toast('That snapshot is no longer available.'); return false }
  if (!snapshot.validUtf8) { ui.toast('This snapshot contains invalid UTF-8. Copy it to a new tab instead; the original will not be overwritten.', 6500); return false }
  const disk = await api.call('file.peek', path) as FileReadResult
  if (!safe() || !disk.ok || !disk.validUtf8 || disk.hash !== target.baseHash) {
    if (tabs.items.includes(target)) await promptExternalChange(target)
    return blocked()
  }
  const state = target.editor.view.state
  if (!(await beforeOverwrite(target, 'before-restore'))) return false
  const verified = await api.call('file.peek', path) as FileReadResult
  if (!safe() || !verified.ok || !verified.validUtf8 || verified.hash !== target.baseHash) {
    if (tabs.items.includes(target)) await promptExternalChange(target)
    return blocked()
  }
  if (target.editor.view.state.doc !== state.doc || target.editor.view.state.field(historyFormat) !== state.field(historyFormat)) {
    ui.toast('Restore cancelled because you edited the document while history was being saved.'); return false
  }
  target.generation++
  target.editor.view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: snapshot.text },
    effects: historyFormatEffect.of(snapshot),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.historyRestore')],
    selection: { anchor: 0 }, scrollIntoView: true
  })
  persistDraft(target)
  ui.toast('Snapshot restored in the editor. Undo is available; save when ready.')
  return true
}

async function copyHistory(id: string, target = doc): Promise<boolean> {
  const path = target.path
  if (!path || closingWindow || guardInFlight) return false
  const snapshot = await api.call('history.read', path, id) as (EncodableDoc & { validUtf8: boolean }) | null
  if (!snapshot || closingWindow) return false
  const copy = createDocument('', { path: null, eol: snapshot.eol, bom: snapshot.bom })
  copy.editor.view.dispatch({ changes: { from: 0, insert: snapshot.text }, effects: historyFormatEffect.of(snapshot), annotations: isolateHistory.of('full') })
  copy.touched = true
  persistDraft(copy)
  updateTitle(); updateStatus()
  if (!snapshot.validUtf8) ui.toast('Copied decoded text only; invalid UTF-8 bytes cannot be copied into an editor.', 5000)
  return true
}

function showDeletedBanner(): void {
  ui.showBanner('This file was deleted outside Typing. Your text is still in the editor; saving will create the file again.', [
    { label: 'Dismiss', onClick: ui.hideBanner }
  ])
}

async function onExternalChange(path: string): Promise<void> {
  const target = tabs.find(path)
  if (!target || target.closing) return
  // Let our own in-flight write publish its new base before comparing hashes.
  if (target.saveTask) await target.saveTask
  if (!tabs.items.includes(target) || target.path !== path) return
  const generation = target.generation
  const result = (await api.call('file.peek', path)) as FileReadResult & { ok: boolean }
  if (!tabs.items.includes(target) || generation !== target.generation || target.path !== path) return
  if (!result.ok) {
    target.deleted = true
    cancelPendingWrites(target)
    renderTabs()
    if (target === doc) showDeletedBanner()
    return
  }
  if (result.hash === target.baseHash) return
  if (!isDirty(target) && !closingWindow && !target.historyTask) {
    const view = target.editor.view
    const scrollTop = view.scrollDOM.scrollTop
    const selection = view.state.selection.main
    if (!(await beforeOverwrite(target, 'before-reload'))) { await promptExternalChange(target); return }
    setDocument(result.text, { ...result, baseMtimeMs: result.mtimeMs, baseHash: result.hash }, target)
    const length = view.state.doc.length
    view.dispatch({ selection: { anchor: Math.min(selection.anchor, length), head: Math.min(selection.head, length) } })
    view.scrollDOM.scrollTop = scrollTop
    renderTabs()
    if (target === doc) {
      if (!result.validUtf8) promptInvalidUtf8(target)
      else ui.toast('Reloaded: the file changed on disk')
    }
    return
  }
  await promptExternalChange(target)
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
    baseHash?: string
    baseMtimeMs?: number
    savedText?: string
    eol?: Eol
    lineEndings?: string
    bom?: boolean
    validUtf8?: boolean
    sourceMode?: boolean
  }
  const drafts = (await api.call('recovery.list')) as Draft[]
  if (!drafts.length) return
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  const candidates: Draft[] = []
  for (const draft of drafts) {
    const key = draft.key ?? draft.path ?? ''
    if (draft.savedAt < weekAgo) {
      if (key) await api.call('recovery.clear', key)
      continue
    }
    if (draft.path) {
      const disk = (await api.call('file.peek', draft.path)) as FileReadResult & { ok: boolean }
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
  for (const draft of candidates) {
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
    const empty = doc.path === null && !doc.touched && !editor.getText() ? doc : null
    const disk = draft.path ? await api.call('file.read', draft.path) as FileReadResult : null
    const target = createDocument(disk?.ok ? disk.text : '', {
      path: draft.path,
      baseMtimeMs: draft.baseMtimeMs ?? disk?.mtimeMs ?? 0,
      baseHash: draft.baseHash ?? disk?.hash ?? '',
      eol: draft.eol ?? disk?.eol ?? '\n', lineEndings: draft.lineEndings ?? disk?.lineEndings ?? '',
      bom: draft.bom ?? disk?.bom ?? false, validUtf8: draft.validUtf8 ?? disk?.validUtf8 ?? true
    })
    if (draft.key && /^[0-9a-f]{16}$/.test(draft.key)) {
      // Keep the same durable recovery key through another crash.
      target.id = draft.key
      target.panel.id = `panel-${target.id}`
      target.panel.setAttribute('aria-labelledby', `tab-${target.id}`)
    }
    target.savedText = draft.savedText ?? (disk?.ok ? disk.text : '')
    target.editor.setText(draft.text)
    target.sourceMode = draft.sourceMode ?? target.sourceMode
    target.editor.setSourceMode(target.sourceMode)
    target.externalChange = Boolean(disk?.ok && target.baseHash && disk.hash !== target.baseHash)
    if (empty) await disposeTab(empty)
    activateTab(target)
    persistDraft(target)
    ui.toast('Recovered unsaved changes — save when ready')
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

async function insertImageData(dataUrl: string, suggestedName: string, target = doc): Promise<void> {
  const generation = target.generation
  const result = await api.call('assets.saveImage', {
    docPath: target.path,
    dataUrl,
    suggestedName
  })
  if (!result?.ok) {
    ui.showBanner(result?.error ?? 'Could not save the image next to your document.', [
      { label: 'Dismiss', onClick: ui.hideBanner }
    ])
    return
  }
  if (!tabs.items.includes(target) || target.generation !== generation) return
  fmt.insertImage(target.editor.view, suggestedName.replace(/\.[a-z]+$/i, ''), result.relative)
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
    const target = doc
    const pos = editor.view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos !== null) editor.setSelection(pos)
    for (const file of files) {
      const path = api.pathForFile(file)
      if (!path) continue
      if (file.type.startsWith('image/')) {
        await insertImageData(await readFileAsDataUrl(file), file.name, target)
      } else if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(path)) {
        // File drops share the same deduplicating, non-destructive tab opener.
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
  const target = doc
  const files = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (files.length) {
    e.preventDefault()
    lastPasteHandled = now
    for (const file of files) {
      await insertImageData(await readFileAsDataUrl(file), file.name || 'pasted-image', target)
    }
    return
  }
  if (Array.from(data.types ?? []).includes('image/png')) {
    const dataUrl = await api.call('clipboard.readImage')
    if (dataUrl) {
      e.preventDefault()
      lastPasteHandled = now
      await insertImageData(dataUrl, 'pasted-image', target)
    }
  }
}

function wireEditorLinks(controller: EditorController): void {
  const editor = controller
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
  $('btn-new-tab').addEventListener('click', () => void newDocument())
  $('tab-list').addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); $('tab-list').scrollLeft += e.deltaY }
  }, { passive: false })
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
  await setPrefs({ sourceMode: !doc.sourceMode })
  const scrollTop = editor.view.scrollDOM.scrollTop
  editor.view.scrollDOM.scrollTop = scrollTop
  ui.toast(prefs.sourceMode ? 'Source mode' : 'Live preview')
}

// ---------------------------------------------------------------------------
// Command dispatch (menu bar + shortcuts)
// ---------------------------------------------------------------------------

async function runCommand(command: string): Promise<void> {
  if (closingWindow && command !== 'app.close') return
  const view = editor.view
  switch (command) {
    case 'doc.new':
    case 'tab.new':
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
    case 'tab.close':
      await closeTab()
      break
    case 'tab.next':
    case 'tab.nextAlt': {
      const next = tabs.relative(1)
      if (next) activateTab(next)
      break
    }
    case 'tab.previous':
    case 'tab.previousAlt': {
      const previous = tabs.relative(-1)
      if (previous) activateTab(previous)
      break
    }
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
      if (command.startsWith('tab.jump')) {
        const target = tabs.at(Number(command.slice(-1)) - 1)
        if (target) activateTab(target)
      } else if (command.startsWith('format.h') && command.length === 8) {
        const level = Number(command.slice(-1))
        fmt.setHeading(view, level)
      } else if (command === 'format.p') {
        fmt.setHeading(view, 0)
      }
      break
  }
}

/** Native window close / quit walks all tabs; cancellation never discards any. */
async function requestClose(): Promise<void> {
  if (closingWindow || guardInFlight) return
  closingWindow = true
  let approved = false
  const checked = new Map<DocState, string>()
  try {
    for (const target of tabs.items) cancelPendingWrites(target)
    for (const target of tabs.items) {
      if (target.historyTask) await target.historyTask
      if (target.saveTask) await target.saveTask
      if (!(await guardUnsavedWork(target))) return
      checked.set(target, target.editor.getText())
    }
    // A background change or a test/API edit while a later dialog was open may
    // not inherit an earlier discard decision.
    if (tabs.items.some(target => checked.get(target) !== target.editor.getText())) return
    for (const target of tabs.items) await api.call('recovery.clear', target.id)
    approved = true
    await api.call('window.close', true)
  } finally {
    closingWindow = false
    if (!approved) {
      await api.call('window.cancelClose')
      for (const target of tabs.items) { scheduleAutosave(target); scheduleDraft(target) }
    }
  }
}

async function showAppDoc(file: string, title: string): Promise<void> {
  const text = await api.call('app.doc', file)
  ui.documentDialog(title, typeof text === 'string' ? text : 'The document is not available in this build.')
}

async function pickImage(): Promise<void> {
  const target = doc
  const generation = target.generation
  const path = await api.call('dialog.pickImage')
  if (!path) return
  const name = baseName(String(path))
  const alt = name.replace(/\.[a-z0-9]+$/i, '')
  // Prefer a relative link when the image lives next to the document; a link
  // written into the document always uses forward slashes, on every platform.
  const dir = target.path ? dirName(target.path) : ''
  const relative = dir ? relativePath(dir, String(path)) : null
  const src = relative ?? toPosixPath(String(path))
  if (tabs.items.includes(target) && target.generation === generation) fmt.insertImage(target.editor.view, alt, src)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportBaseName(): string {
  const name = doc.path ? baseName(doc.path).replace(/\.md$/i, '') : 'Untitled'
  return name
}

async function exportHtml(): Promise<void> {
  const path = doc.path
  const html = await buildExportHtml(editor.getText(), { title: exportBaseName(), docPath: path })
  const suggested = path ? path.replace(/\.md$/i, '.html') : joinPath(folderRoot ?? '', 'Untitled.html')
  const result = await api.call('export.html', { html, suggestedPath: suggested })
  if (result?.ok) ui.toast('HTML exported')
  else if (result?.error && result.error !== 'canceled') ui.showBanner(`Export failed: ${result.error}`, [{ label: 'Dismiss', onClick: ui.hideBanner }])
}

async function exportPdf(): Promise<void> {
  const path = doc.path
  const title = exportBaseName()
  const html = await buildExportHtml(editor.getText(), { title, docPath: path })
  const suggested = path ? path.replace(/\.md$/i, '.pdf') : joinPath(folderRoot ?? '', 'Untitled.pdf')
  const result = await api.call('export.pdf', { html, suggestedPath: suggested, title })
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
      tabs: () => Array<{ id: string; path: string | null; dirty: boolean; active: boolean; sourceMode: boolean; externalChange: boolean; deleted: boolean }>
      activate: (index: number) => void
      closeTab: () => Promise<void>
      selection: (anchor?: number, head?: number) => { anchor: number; head: number; scroll: number }
      flushDrafts: () => void
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
    stats: () => countStats(editor.getText()),
    tabs: () => tabs.items.map(tab => ({ id: tab.id, path: tab.path, dirty: isDirty(tab), active: tab === doc, sourceMode: tab.sourceMode, externalChange: tab.externalChange, deleted: tab.deleted })),
    activate: index => { const tab = tabs.items[index]; if (tab) activateTab(tab) },
    closeTab: () => closeTab(),
    selection: (anchor, head) => {
      if (anchor !== undefined) editor.setSelection(anchor, head, false)
      const sel = editor.view.state.selection.main
      return { anchor: sel.anchor, head: sel.head, scroll: editor.view.scrollDOM.scrollTop }
    },
    flushDrafts: () => tabs.items.forEach(persistDraft)
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