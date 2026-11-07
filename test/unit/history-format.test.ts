import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { decodeDoc, encodeDoc } from '../../src/shared/doc'
import { historyFormat, historyFormatEffect, historyFormatExtension, effectiveFormat } from '../../src/renderer/src/history-format'

describe('restore provenance is an isolated undoable edit', () => {
  it('undo and redo carry exact BOM and mixed endings along with text', () => {
    const before = decodeDoc(Buffer.from('CURRENT\n'))
    const snapshot = decodeDoc(Buffer.from('\ufeffa\r\nb\nc\r'))
    let state = EditorState.create({ doc: before.text, extensions: [history(), historyFormatExtension] })
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: snapshot.text }, effects: historyFormatEffect.of(snapshot) }).state
    expect(Buffer.from(encodeDoc(effectiveFormat(state, before)))).toEqual(Buffer.from('\ufeffa\r\nb\nc\r'))
    const target = { get state() { return state }, dispatch: (tr: any) => { state = tr.state } }
    expect(undo(target)).toBe(true)
    expect(state.doc.toString()).toBe(before.text)
    expect(state.field(historyFormat)).toBeNull()
    expect(redo(target)).toBe(true)
    expect(Buffer.from(encodeDoc(effectiveFormat(state, before)))).toEqual(Buffer.from('\ufeffa\r\nb\nc\r'))
  })
  it('encoding-only restore is undoable even when text does not change', () => {
    const base = decodeDoc(Buffer.from('a\n'))
    const snapshot = decodeDoc(Buffer.from('\ufeffa\r\n'))
    let state = EditorState.create({ doc: base.text, extensions: [history(), historyFormatExtension] })
    state = state.update({ effects: historyFormatEffect.of(snapshot) }).state
    const target = { get state() { return state }, dispatch: (tr: any) => { state = tr.state } }
    expect(effectiveFormat(state, base).bom).toBe(true)
    expect(undo(target)).toBe(true)
    expect(effectiveFormat(state, base).bom).toBe(false)
  })
})
