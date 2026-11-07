import { describe, expect, it } from 'vitest'
import { lineDiff } from '../../src/renderer/src/history-diff'

describe('bounded line diff (snapshot → current)', () => {
  it.each([
    ['', ''], ['', 'first\n'], ['last', ''], ['a\nb\n', 'a\nc\n'],
    ['a\na\nb\n', 'a\nb\na\n'], ['中文\n🙂\n', '中文\n写作\n🙂'], ['a\n', 'a']
  ])('reconstructs both inputs %j → %j', (before, after) => {
    const result = lineDiff(before, after)
    expect(result.chunks.filter(c => c.type !== 'add').map(c => c.text).join('')).toBe(before)
    expect(result.chunks.filter(c => c.type !== 'remove').map(c => c.text).join('')).toBe(after)
  })
  it('identifies insertions and removals without losing unchanged lines', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\n').chunks).toEqual([
      { type: 'equal', text: 'a\n' }, { type: 'remove', text: 'b\n' },
      { type: 'add', text: 'x\n' }, { type: 'equal', text: 'c\n' }
    ])
  })
  it('bounds work on adversarial unrelated documents with an exact coarse line replacement', () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `old ${i}\n`).join('')
    const after = Array.from({ length: 10_000 }, (_, i) => `new ${i}\n`).join('')
    const result = lineDiff(before, after)
    expect(result.coarse).toBe(true)
    expect(result.chunks).toEqual([{ type: 'remove', text: before }, { type: 'add', text: after }])
  })
})
