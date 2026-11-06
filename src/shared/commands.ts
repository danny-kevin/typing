/**
 * Single source of truth for application commands.
 *
 * The menu bar (main process) and the keyboard shortcut matcher (renderer) both
 * read this table, so a shortcut can never drift away from the menu that
 * documents it.
 */

export const ACCELERATORS: Record<string, string> = {
  'doc.new': 'Cmd+N',
  'doc.open': 'Cmd+O',
  'doc.openFolder': 'Cmd+Shift+Alt+O',
  'nav.quickOpen': 'Cmd+Shift+O',
  'doc.save': 'Cmd+S',
  'doc.saveAs': 'Cmd+Shift+S',
  'export.html': 'Cmd+Shift+E',
  'export.pdf': 'Cmd+Alt+P',
  'edit.undo': 'Cmd+Z',
  'edit.redo': 'Cmd+Shift+Z',
  'find.open': 'Cmd+F',
  'find.next': 'Cmd+G',
  'find.prev': 'Cmd+Shift+G',
  'find.replace': 'Cmd+Alt+F',
  'format.bold': 'Cmd+B',
  'format.italic': 'Cmd+I',
  'format.strike': 'Cmd+Shift+X',
  'format.code': 'Cmd+E',
  'format.link': 'Cmd+K',
  'format.image': 'Cmd+Shift+I',
  'format.codeBlock': 'Cmd+Alt+C',
  'format.quote': 'Cmd+Alt+Q',
  'format.table': 'Cmd+Alt+T',
  'format.math': 'Cmd+Alt+M',
  'format.h1': 'Cmd+1',
  'format.h2': 'Cmd+2',
  'format.h3': 'Cmd+3',
  'format.h4': 'Cmd+4',
  'format.h5': 'Cmd+5',
  'format.h6': 'Cmd+6',
  'format.p': 'Cmd+0',
  'format.ul': 'Cmd+Alt+U',
  'format.ol': 'Cmd+Alt+O',
  'format.task': 'Cmd+Alt+X',
  'format.indent': 'Cmd+]',
  'format.outdent': 'Cmd+[',
  'table.addRowBelow': 'Cmd+Return',
  'table.addColRight': 'Cmd+Shift+Return',
  'view.source': 'Cmd+/',
  'view.outline': 'Cmd+Shift+1',
  'view.sidebar': 'Cmd+Shift+2',
  'view.focus': 'F8',
  'view.typewriter': 'F9',
  'app.close': 'Cmd+W',
  'app.prefs': 'Cmd+,',
  'app.shortcuts': 'Cmd+Shift+/'
}

const CODE_FOR_KEY: Record<string, string> = {
  '/': 'Slash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '-': 'Minus',
  '=': 'Equal',
  Return: 'Enter',
  Enter: 'Enter',
  Escape: 'Escape',
  '\\': 'Backslash'
}

function codeForKey(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  return CODE_FOR_KEY[key] ?? null
}

export interface ParsedAccelerator {
  id: string
  code: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export function parseAccelerator(id: string, accel: string): ParsedAccelerator | null {
  const parts = accel.split('+')
  const key = parts.pop()
  if (!key) return null
  const code = codeForKey(key)
  if (!code) return null
  let meta = false
  let ctrl = false
  let shift = false
  let alt = false
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'cmd':
      case 'command':
      case 'cmdorctrl':
        meta = true
        break
      case 'ctrl':
      case 'control':
        ctrl = true
        break
      case 'shift':
        shift = true
        break
      case 'alt':
      case 'option':
        alt = true
        break
      default:
        break
    }
  }
  return { id, code, meta, ctrl, shift, alt }
}

export const PARSED_ACCELERATORS: ParsedAccelerator[] = Object.entries(ACCELERATORS)
  .map(([id, accel]) => parseAccelerator(id, accel))
  .filter((a): a is ParsedAccelerator => a !== null)

/**
 * Match a keyboard event against the command table.
 * Command keys are exhaustive: Cmd+S must not fire for Cmd+Shift+S.
 */
export function commandForEvent(event: KeyboardEvent, isMac = true): string | null {
  for (const a of PARSED_ACCELERATORS) {
    if (a.code !== event.code) continue
    const primary = isMac ? a.meta : a.ctrl
    if (primary !== (isMac ? event.metaKey : event.ctrlKey)) continue
    if (isMac && a.ctrl !== event.ctrlKey) continue
    if (a.shift !== event.shiftKey) continue
    if (a.alt !== event.altKey) continue
    return a.id
  }
  return null
}