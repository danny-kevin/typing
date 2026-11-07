import { describe, it, expect } from 'vitest'
import {
  ACCELERATORS,
  acceleratorFor,
  commandForEvent,
  displayAccelerator,
  parseAccelerator,
  PARSED_ACCELERATORS
} from '../../src/shared/commands'

function key(init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent {
  return {
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    isComposing: (init as { isComposing?: boolean }).isComposing ?? false
  } as KeyboardEvent
}

describe('command table', () => {
  it('parses every accelerator', () => {
    for (const [id, accel] of Object.entries(ACCELERATORS)) {
      expect(parseAccelerator(id, accel), `${id} (${accel})`).not.toBeNull()
    }
    expect(PARSED_ACCELERATORS.length).toBe(Object.keys(ACCELERATORS).length)
  })

  it('maps Cmd+S to save and Cmd+Shift+S to save as', () => {
    expect(commandForEvent(key({ code: 'KeyS', metaKey: true }))).toBe('doc.save')
    expect(commandForEvent(key({ code: 'KeyS', metaKey: true, shiftKey: true }))).toBe('doc.saveAs')
  })

  it('does not report a command for plain typing', () => {
    expect(commandForEvent(key({ code: 'KeyS' }))).toBeNull()
    expect(commandForEvent(key({ code: 'Digit1' }))).toBeNull()
  })

  it('distinguishes Option-modified shortcuts', () => {
    expect(commandForEvent(key({ code: 'KeyF', metaKey: true, altKey: true }))).toBe('find.replace')
    expect(commandForEvent(key({ code: 'KeyF', metaKey: true }))).toBe('find.open')
  })

  it('maps digit shortcuts to heading levels', () => {
    expect(commandForEvent(key({ code: 'Digit1', metaKey: true }))).toBe('format.h1')
    expect(commandForEvent(key({ code: 'Digit6', metaKey: true }))).toBe('format.h6')
    expect(commandForEvent(key({ code: 'Digit0', metaKey: true }))).toBe('format.p')
  })

  it('matches punctuation shortcuts', () => {
    expect(commandForEvent(key({ code: 'Slash', metaKey: true }))).toBe('view.source')
    expect(commandForEvent(key({ code: 'BracketLeft', metaKey: true }))).toBe('format.outdent')
    expect(commandForEvent(key({ code: 'Enter', metaKey: true }))).toBe('table.addRowBelow')
  })

  it('never maps a key twice with the same modifiers', () => {
    const seen = new Map<string, string>()
    for (const a of PARSED_ACCELERATORS) {
      const id = `${a.code}|${a.primary}|${a.ctrl}|${a.shift}|${a.alt}`
      expect(seen.get(id), `duplicate accelerator for ${a.id} and ${seen.get(id)}`).toBeUndefined()
      seen.set(id, a.id)
    }
  })
})

describe('Windows and Linux use Ctrl where macOS uses Cmd', () => {
  const win = false // commandForEvent(event, isMac)

  it('maps Ctrl+S to save and Ctrl+Shift+S to save as', () => {
    expect(commandForEvent(key({ code: 'KeyS', ctrlKey: true }), win)).toBe('doc.save')
    expect(commandForEvent(key({ code: 'KeyS', ctrlKey: true, shiftKey: true }), win)).toBe('doc.saveAs')
  })

  it('maps Ctrl+Alt modified commands', () => {
    expect(commandForEvent(key({ code: 'KeyF', ctrlKey: true, altKey: true }), win)).toBe('find.replace')
    expect(commandForEvent(key({ code: 'KeyT', ctrlKey: true, altKey: true }), win)).toBe('format.table')
    expect(commandForEvent(key({ code: 'KeyP', ctrlKey: true, altKey: true }), win)).toBe('export.pdf')
  })

  it('maps Ctrl+Shift and punctuation commands', () => {
    expect(commandForEvent(key({ code: 'KeyO', ctrlKey: true, shiftKey: true, altKey: true }), win)).toBe('doc.openFolder')
    expect(commandForEvent(key({ code: 'Slash', ctrlKey: true }), win)).toBe('view.source')
    expect(commandForEvent(key({ code: 'BracketRight', ctrlKey: true }), win)).toBe('format.indent')
    expect(commandForEvent(key({ code: 'Digit3', ctrlKey: true }), win)).toBe('format.h3')
    expect(commandForEvent(key({ code: 'Enter', ctrlKey: true, shiftKey: true }), win)).toBe('table.addColRight')
  })

  it('ignores the macOS Command key on Windows', () => {
    expect(commandForEvent(key({ code: 'KeyS', metaKey: true }), win)).toBeNull()
    // …and Ctrl is not the primary modifier on macOS.
    expect(commandForEvent(key({ code: 'KeyS', ctrlKey: true }), true)).toBeNull()
  })

  it('does not fire a command while an IME is composing', () => {
    const composing = { code: 'KeyS', ctrlKey: true, isComposing: true } as Partial<KeyboardEvent> & { code: string }
    expect(commandForEvent(key(composing), win)).toBeNull()
    expect(commandForEvent(key({ code: 'KeyS', metaKey: true, isComposing: true }), true)).toBeNull()
  })
})

describe('accelerator rendering', () => {
  it('hands Electron CmdOrCtrl so the menu works on every platform', () => {
    expect(acceleratorFor('doc.save')).toBe('CmdOrCtrl+S')
    expect(acceleratorFor('doc.openFolder')).toBe('CmdOrCtrl+Shift+Alt+O')
    expect(acceleratorFor('view.focus')).toBe('F8')
    expect(acceleratorFor('does.not.exist')).toBeUndefined()
    // Nothing is left for Electron to misinterpret as a macOS-only key.
    for (const id of Object.keys(ACCELERATORS)) expect(acceleratorFor(id, 'win32')).not.toContain('Cmd+')
  })

  it('prints macOS glyphs on macOS', () => {
    expect(displayAccelerator('doc.save', 'darwin')).toBe('⌘S')
    expect(displayAccelerator('doc.saveAs', 'darwin')).toBe('⇧⌘S')
    expect(displayAccelerator('format.table', 'darwin')).toBe('⌥⌘T')
    expect(displayAccelerator('table.addRowBelow', 'darwin')).toBe('⌘↩')
    expect(displayAccelerator('view.focus', 'darwin')).toBe('F8')
  })

  it('prints Ctrl combinations on Windows', () => {
    expect(displayAccelerator('doc.save', 'win32')).toBe('Ctrl+S')
    expect(displayAccelerator('doc.saveAs', 'win32')).toBe('Ctrl+Shift+S')
    expect(displayAccelerator('format.table', 'win32')).toBe('Ctrl+Alt+T')
    expect(displayAccelerator('table.addRowBelow', 'win32')).toBe('Ctrl+Enter')
    expect(displayAccelerator('doc.openFolder', 'win32')).toBe('Ctrl+Alt+Shift+O')
    expect(displayAccelerator('view.focus', 'win32')).toBe('F8')
  })

  it('has no macOS-only glyph left in the Windows rendering', () => {
    for (const id of Object.keys(ACCELERATORS)) {
      expect(displayAccelerator(id, 'win32')).not.toMatch(/[⌘⇧⌥⌃↩]/)
    }
  })
})