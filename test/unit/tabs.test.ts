import { describe, expect, it } from 'vitest'
import { Tabs } from '../../src/renderer/src/tabs'
import { EditorState } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'

describe('tab collection', () => {
  it('retains actual CodeMirror buffers, histories, selection and document metadata by identity', () => {
    const a = { path: '/a', buffer: EditorState.create({ doc: 'first', extensions: history() }), savedText: 'first', eol: '\r\n', lineEndings: 'cl', bom: true, validUtf8: false, baseHash: 'a-hash', externalChange: true, recoveryKey: 'a', sourceMode: true }
    const b = { ...a, path: '/b', buffer: EditorState.create({ doc: 'second', extensions: history() }), eol: '\n', bom: false, validUtf8: true, baseHash: 'b-hash', externalChange: false, recoveryKey: 'b', sourceMode: false }
    const tabs = new Tabs<typeof a>()
    tabs.add(a); tabs.add(b)
    a.buffer = a.buffer.update({ changes: { from: 5, insert: ' edit' }, selection: { anchor: 1, head: 4 } }).state
    tabs.active = a
    expect(tabs.active.buffer.doc.toString()).toBe('first edit')
    expect(tabs.active.buffer.selection.main.toJSON()).toEqual({ anchor: 1, head: 4 })
    expect(undoDepth(a.buffer)).toBe(1)
    expect(undoDepth(b.buffer)).toBe(0)
    tabs.move(a, 1)
    tabs.close(b)
    expect(tabs.active).toBe(a)
    expect(a).toMatchObject({ eol: '\r\n', lineEndings: 'cl', bom: true, validUtf8: false, baseHash: 'a-hash', externalChange: true, recoveryKey: 'a', sourceMode: true, savedText: 'first' })
  })

  it('normalizes Windows paths without conflating case-sensitive POSIX files', () => {
    const win = new Tabs('win32')
    const a = { path: 'C:\\Notes\\a.md' }
    win.add(a)
    expect(win.find('c:/notes/a.md')).toBe(a)
    const posix = new Tabs('linux')
    posix.add({ path: '/Notes/a.md' })
    expect(posix.find('/notes/a.md')).toBeUndefined()
  })

  it('cycles and jumps without copying or losing owned state', () => {
    const tabs = new Tabs<{ path: string | null; state: { undo: string[]; scroll: number } }>()
    const a = { path: '/a', state: { undo: ['a'], scroll: 123 } }
    const b = { path: '/b', state: { undo: ['b'], scroll: 456 } }
    tabs.add(a); tabs.add(b)
    expect(tabs.relative(1)).toBe(a)
    expect(tabs.relative(-1)).toBe(a)
    expect(tabs.at(8)).toBe(b)
    expect(tabs.at(2)).toBeUndefined()
    tabs.active = a
    tabs.move(a, 1)
    expect(tabs.active.state).toBe(a.state)
    expect(a.state).toEqual({ undo: ['a'], scroll: 123 })
    tabs.close(b)
    expect(tabs.active).toBe(a)
  })

  it('focuses existing paths and replaces only a pristine untitled tab', () => {
    const tabs = new Tabs<{ path: string | null; pristine: boolean }>()
    const untitled = { path: null, pristine: true }
    tabs.add(untitled)
    const first = { path: '/first.md', pristine: false }
    expect(tabs.open(first, t => t.path === null && t.pristine)).toBe(first)
    expect(tabs.items).toEqual([first])
    const second = { path: '/second.md', pristine: false }
    tabs.open(second, t => t.path === null && t.pristine)
    expect(tabs.open({ ...first }, t => t.path === null && t.pristine)).toBe(first)
    expect(tabs.active).toBe(first)
    expect(tabs.items).toEqual([first, second])
  })

  it('reorders by identity and selects a neighbour when closing the active tab', () => {
    const tabs = new Tabs<{ path: string | null }>()
    const a = { path: '/a' }, b = { path: '/b' }, c = { path: '/c' }
    tabs.add(a); tabs.add(b); tabs.add(c)
    tabs.move(c, 0)
    expect(tabs.items).toEqual([c, a, b])
    tabs.close(c)
    expect(tabs.active).toBe(a)
    tabs.close(b)
    expect(tabs.active).toBe(a)
    tabs.close(a)
    expect(tabs.active).toBeNull()
  })
})
