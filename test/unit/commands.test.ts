import { describe, it, expect } from 'vitest'
import { ACCELERATORS, commandForEvent, parseAccelerator, PARSED_ACCELERATORS } from '../../src/shared/commands'

function key(init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent {
  return {
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false
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
      const id = `${a.code}|${a.meta}|${a.shift}|${a.alt}`
      expect(seen.get(id), `duplicate accelerator for ${a.id} and ${seen.get(id)}`).toBeUndefined()
      seen.set(id, a.id)
    }
  })
})