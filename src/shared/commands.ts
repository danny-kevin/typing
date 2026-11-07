/**
 * Single source of truth for application commands.
 *
 * The menu bar (main process) and the keyboard shortcut matcher (renderer) both
 * read this table, so a shortcut can never drift away from the menu that
 * documents it.
 *
 * Accelerators are written once, in Electron's macOS notation (`Cmd+…`), and
 * every platform derives its own form from that single string:
 *
 *  - the menu uses `acceleratorFor()`, which turns `Cmd` into `CmdOrCtrl` so
 *    Electron resolves it to ⌘ on macOS and Ctrl on Windows and Linux;
 *  - the renderer matches keyboard events with `commandForEvent()` and knows
 *    which modifier is the platform's primary one;
 *  - dialogs and tooltips print the human form with `displayAccelerator()`.
 */

export const ACCELERATORS: Record<string, string> = {
  'doc.new': 'Cmd+N',
  'tab.new': 'Cmd+T',
  'tab.close': 'Cmd+W',
  'tab.next': 'Ctrl+Tab',
  'tab.previous': 'Ctrl+Shift+Tab',
  'tab.nextAlt': 'Cmd+Shift+]',
  'tab.previousAlt': 'Cmd+Shift+[',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab.jump${i + 1}`, `Cmd+Alt+${i + 1}`])),
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
  'app.close': 'Cmd+Shift+W',
  'app.prefs': 'Cmd+,',
  'app.shortcuts': 'Cmd+Shift+/'
}

/** True when `platform` (a Node `process.platform` value) is macOS. */
export function isMacPlatform(platform: string): boolean {
  return platform === 'darwin'
}

/**
 * The accelerator string Electron's menu API should use on `platform`.
 * `Cmd` becomes `CmdOrCtrl`, which Electron resolves per platform.
 */
function platformAccelerator(id: string, platform: string): string | undefined {
  if (!isMacPlatform(platform)) {
    if (id === 'tab.nextAlt') return 'Ctrl+PageDown'
    if (id === 'tab.previousAlt') return 'Ctrl+PageUp'
  }
  return ACCELERATORS[id]
}

export function acceleratorFor(id: string, platform = 'darwin'): string | undefined {
  const accel = platformAccelerator(id, platform)
  if (!accel) return undefined
  return accel.replace(/(^|\+)Cmd(?=\+)/g, '$1CmdOrCtrl')
}

const MAC_GLYPHS: Record<string, string> = { Cmd: '⌘', Command: '⌘', Shift: '⇧', Alt: '⌥', Option: '⌥', Ctrl: '⌃' }
const WIN_MODIFIERS: Record<string, string> = {
  Cmd: 'Ctrl',
  Command: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Option: 'Alt'
}

/**
 * The human-readable form of a command's shortcut: `⇧⌘S` on macOS,
 * `Ctrl+Shift+S` on Windows and Linux.
 */
export function displayAccelerator(id: string, platform = 'darwin'): string {
  const accel = platformAccelerator(id, platform)
  if (!accel) return ''
  const parts = accel.split('+')
  const key = parts.pop() ?? ''
  const mods = parts
  const keyLabel = key === 'Return' ? (isMacPlatform(platform) ? '↩' : 'Enter') : key
  if (isMacPlatform(platform)) {
    // macOS renders modifiers in a canonical order: ⌃⌥⇧⌘.
    const rank = (m: string): number => (m === 'Ctrl' ? 0 : m === 'Alt' || m === 'Option' ? 1 : m === 'Shift' ? 2 : 3)
    const glyphs = mods
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .map((m) => MAC_GLYPHS[m] ?? MAC_GLYPHS[m[0].toUpperCase() + m.slice(1).toLowerCase()] ?? m)
      .join('')
    return `${glyphs}${keyLabel}`
  }
  const names = mods.map((m) => WIN_MODIFIERS[m] ?? m)
  // Windows convention: Ctrl, then Alt, then Shift.
  const rank = (m: string): number => (m === 'Ctrl' ? 0 : m === 'Alt' ? 1 : m === 'Shift' ? 2 : 3)
  names.sort((a, b) => rank(a) - rank(b))
  return [...names, keyLabel].join('+')
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
  Tab: 'Tab',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
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
  /** The platform's primary modifier: ⌘ on macOS, Ctrl on Windows and Linux. */
  primary: boolean
  /** An explicit Control modifier, which only exists as a separate key on macOS. */
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
  let primary = false
  let ctrl = false
  let shift = false
  let alt = false
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'cmd':
      case 'command':
      case 'cmdorctrl':
        primary = true
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
  return { id, code, primary, ctrl, shift, alt }
}

export const PARSED_ACCELERATORS: ParsedAccelerator[] = Object.entries(ACCELERATORS)
  .map(([id, accel]) => parseAccelerator(id, accel))
  .filter((a): a is ParsedAccelerator => a !== null)

/**
 * Match a keyboard event against the command table.
 * Command keys are exhaustive: Cmd+S must not fire for Cmd+Shift+S.
 */
export function commandForEvent(event: KeyboardEvent, isMac = true): string | null {
  // Never steal a key while an IME is composing: on Windows especially, the
  // keys that arrive during composition belong to the input method.
  const composing =
    (event as unknown as { isComposing?: boolean }).isComposing === true ||
    (event as unknown as { keyCode?: number }).keyCode === 229
  if (composing) return null
  const parsed = isMac ? PARSED_ACCELERATORS : Object.keys(ACCELERATORS)
    .map(id => parseAccelerator(id, platformAccelerator(id, 'win32')!))
    .filter((a): a is ParsedAccelerator => a !== null)
  for (const a of parsed) {
    if (a.code !== event.code) continue
    if (event.metaKey !== (isMac && a.primary)) continue
    if (event.ctrlKey !== (a.ctrl || (!isMac && a.primary))) continue
    if (a.shift !== event.shiftKey) continue
    if (a.alt !== event.altKey) continue
    return a.id
  }
  return null
}