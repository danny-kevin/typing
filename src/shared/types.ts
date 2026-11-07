/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Kept dependency-free so it can be imported from unit tests running in Node.
 */

export type ThemeMode = 'system' | 'light' | 'dark'

import type { Eol } from './doc'

export type { Eol }

export interface Prefs {
  theme: ThemeMode
  fontFamily: string
  fontSize: number
  editorWidth: number
  lineHeight: number
  sourceMode: boolean
  focusMode: boolean
  typewriterMode: boolean
  autoSave: boolean
  autoSaveMs: number
  showOutline: boolean
  spellCheck: boolean
  smartPaste: boolean
  autoPair: boolean
  lastFolder: string | null
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  fontFamily: '',
  fontSize: 17,
  editorWidth: 720,
  lineHeight: 1.75,
  sourceMode: false,
  focusMode: false,
  typewriterMode: false,
  autoSave: true,
  autoSaveMs: 1200,
  showOutline: true,
  spellCheck: true,
  smartPaste: true,
  autoPair: true,
  lastFolder: null
}

export interface FileReadResult {
  ok: true
  path: string
  text: string
  /** Byte length on disk. */
  size: number
  /** Last modification time, ms since epoch. */
  mtimeMs: number
  /** sha256 of the bytes on disk; the identity a save has to match. */
  hash: string
  /** Byte order mark present in the file; re-added verbatim on save. */
  bom: boolean
  /** Newline convention of the file; used for lines the user adds. */
  eol: Eol
  /** Ending of every line on disk: 'c' CRLF, 'l' LF, 'r' lone CR. */
  lineEndings: string
  /** False when the bytes only decode with replacement characters. */
  validUtf8: boolean
}

export interface FileError {
  ok: false
  error: string
  code?: string
}

export type FileResult = FileReadResult | FileError

export interface SaveResult {
  ok: true
  path: string
  mtimeMs: number
  size: number
  /** sha256 of the bytes now on disk. */
  hash: string
  /** Ending of every line written: 'c' CRLF, 'l' LF, 'r' lone CR. */
  lineEndings: string
  /** True when the file already differed on disk and we wrote a conflict copy instead. */
  conflictCopy?: string
  /** True when the on-disk bytes already matched; nothing was written. */
  unchanged?: boolean
  /** True when the file had been deleted outside Typing and this save recreated it. */
  recreated?: boolean
}

export type SaveOutcome = SaveResult | FileError

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface RecentFile {
  path: string
  name: string
  openedAt: number
}

export interface RecoveryDraft {
  path: string | null
  name: string
  text: string
  savedAt: number
  baseMtimeMs: number
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

/** Methods reachable through `window.typing.call()`. */
export type ApiMethod =
  | 'appInfo'
  | 'prefs.get'
  | 'prefs.set'
  | 'dialog.openFile'
  | 'dialog.openFolder'
  | 'dialog.pickImage'
  | 'dialog.saveAs'
  | 'file.read'
  | 'file.peek'
  | 'file.resolve'
  | 'file.release'
  | 'file.save'
  | 'file.saveAs'
  | 'file.stat'
  | 'file.exists'
  | 'dir.list'
  | 'dir.walk'
  | 'recents.list'
  | 'recents.add'
  | 'recents.clear'
  | 'window.setTitle'
  | 'window.close'
  | 'window.cancelClose'
  | 'window.setRepresentedFile'
  | 'menu.sourceMode'
  | 'renderer.ready'
  | 'export.html'
  | 'export.pdf'
  | 'assets.saveImage'
  | 'recovery.save'
  | 'recovery.clear'
  | 'recovery.list'
  | 'recovery.read'
  | 'shell.openExternal'
  | 'shell.showItemInFolder'
  | 'clipboard.readImage'
  | 'app.doc'
  | 'notify'