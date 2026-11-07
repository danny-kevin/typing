import { describe, it, expect } from 'vitest'
import {
  applyChanges,
  applyTableOp,
  countStats,
  extractOutline,
  continueList,
  lineRangeAt,
  parseTable,
  scanFences,
  scanFrontMatter,
  scanMath,
  serializeTable,
  setHeadingLevel,
  splitRow,
  stripInline,
  tableContextAt,
  toggleInline,
  toggleLinePrefix,
  toggleTaskAt
} from '../../src/shared/markdown'

describe('outline', () => {
  it('collects ATX headings with levels and offsets', () => {
    const text = '# One\n\ntext\n\n## Two\n\n### Three and a half\n'
    const items = extractOutline(text)
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three and a half']
    ])
    expect(items[0].from).toBe(0)
    expect(text.slice(items[1].from, items[1].from + 2)).toBe('##')
  })

  it('ignores headings inside code fences and front matter', () => {
    const text = ['---', 'title: x', '---', '', '# Real', '', '```', '# not a heading', '```', ''].join('\n')
    const items = extractOutline(text)
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('Real')
  })

  it('handles setext headings', () => {
    const items = extractOutline('Title\n=====\n\nSubtitle\n---\n')
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, 'Title'],
      [2, 'Subtitle']
    ])
  })

  it('strips inline markup from heading text', () => {
    const items = extractOutline('## A **bold** and `code` heading\n')
    expect(items[0].text).toBe('A bold and code heading')
  })

  it('does not mutate the document', () => {
    const text = '# One\n\n## Two\n'
    extractOutline(text)
    expect(text).toBe('# One\n\n## Two\n')
  })
})

describe('tables', () => {
  const table = ['| Name | Value |', '| --- | ---: |', '| a | 1 |', '| b | 2 |'].join('\n')

  it('parses alignment and cells', () => {
    const model = parseTable(table.split('\n'))
    expect(model).not.toBeNull()
    expect(model!.header).toEqual(['Name', 'Value'])
    expect(model!.aligns).toEqual(['none', 'right'])
    expect(model!.rows).toEqual([
      ['a', '1'],
      ['b', '2']
    ])
  })

  it('serialises to a stable, aligned table', () => {
    const model = parseTable(table.split('\n'))!
    const first = serializeTable(model)
    const second = serializeTable(parseTable(first)!)
    expect(second).toEqual(first)
    expect(first[1]).toMatch(/\|\s*---+\s*\|\s*---+\s*:/)
  })

  it('splits on unescaped pipes only', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('rejects a header without a delimiter row', () => {
    expect(parseTable(['| a | b |', '| 1 | 2 |'])).toBeNull()
  })

  it('adds and removes rows and columns through edit ops', () => {
    const textWithBlanks = `Intro.\n\n${table}\n\nAfter.\n`
    const pos = textWithBlanks.indexOf('| a')
    const added = applyTableOp(textWithBlanks, pos, { kind: 'addRowBelow' })!
    const afterAdd = applyChanges(textWithBlanks, added.changes)
    expect(afterAdd.split('\n').filter((l) => l.startsWith('|')).length).toBe(5)
    expect(afterAdd.startsWith('Intro.\n\n')).toBe(true)
    expect(afterAdd.endsWith('\n\nAfter.\n')).toBe(true)

    const colPos = afterAdd.indexOf('| a')
    const colAdded = applyTableOp(afterAdd, colPos, { kind: 'addColumnRight' })!
    const afterCol = applyChanges(afterAdd, colAdded.changes)
    const model = parseTable(
      afterCol
        .split('\n')
        .filter((l) => l.startsWith('|'))
    )!
    expect(model.header).toHaveLength(3)

    const delPos = afterCol.indexOf('| a')
    const deleted = applyTableOp(afterCol, delPos, { kind: 'deleteRow' })!
    const afterDelete = applyChanges(afterCol, deleted.changes)
    expect(afterDelete.split('\n').filter((l) => l.startsWith('|')).length).toBe(4)
  })

  it('changes column alignment', () => {
    const centred = applyTableOp(table, table.indexOf('| a'), { kind: 'align', align: 'center' })!
    const result = applyChanges(table, centred.changes)
    expect(parseTable(result.split('\n'))!.aligns[0]).toBe('center')
  })

  it('keeps the caret inside the block it rewrote', () => {
    const doc = `${table}\n\n- [ ] task after the table\n`
    const edit = applyTableOp(doc, doc.indexOf('| a'), { kind: 'addRowBelow' })!
    const range = edit.changes[0]
    const newEnd = range.from + range.insert.length
    // Collapsed, and exactly at the end of the rewritten block: the old code
    // returned `ctx.end + insert.length`, which ran past the table and selected
    // the lines after it.
    expect(edit.selection.anchor).toBe(newEnd)
    expect(edit.selection.head).toBe(newEnd)
    const after = applyChanges(doc, edit.changes)
    expect(tableContextAt(after, edit.selection.head)).not.toBeNull()
    expect(after.slice(edit.selection.head)).toBe('\n\n- [ ] task after the table\n')
  })

  it('only replaces the table block, leaving neighbours untouched', () => {
    const doc = `before\n\n${table}\n\nafter\n`
    const edit = applyTableOp(doc, doc.indexOf('| a'), { kind: 'addRowBelow' })!
    const range = edit.changes[0]
    expect(doc.slice(0, range.from)).toBe('before\n\n')
    expect(doc.slice(range.to)).toBe('\n\nafter\n')
  })

  it('finds the table under the cursor', () => {
    const doc = `x\n\n${table}\n`
    const ctx = tableContextAt(doc, doc.indexOf('| b'))
    expect(ctx).not.toBeNull()
    expect(ctx!.row).toBe(1)
    expect(ctx!.col).toBe(0)
  })
})

describe('scanning', () => {
  it('finds fenced code blocks and their info strings', () => {
    const text = 'a\n```js\ncode\n```\nb\n~~~\ntilde\n~~~\n'
    const fences = scanFences(text)
    expect(fences.map((f) => f.info)).toEqual(['js', ''])
    expect(fences[0].body).toBe('code\n')
    expect(fences[0].closed).toBe(true)
  })

  it('treats an unterminated fence as code to the end', () => {
    const fences = scanFences('x\n```js\nstill code\n')
    expect(fences).toHaveLength(1)
    expect(fences[0].closed).toBe(false)
  })

  it('only recognises front matter at the very start', () => {
    expect(scanFrontMatter('---\na: 1\n---\nbody')).not.toBeNull()
    expect(scanFrontMatter('\n---\na: 1\n---\n')).toBeNull()
    expect(scanFrontMatter('text\n---\na: 1\n---\n')).toBeNull()
  })

  it('finds inline and display maths outside code', () => {
    const text = 'a $x+1$ and $$y=2$$ and `$code$`\n\n```\n$fenced$\n```\n'
    const spans = scanMath(text)
    const contents = spans.map((s) => s.content)
    expect(contents).toContain('x+1')
    expect(contents).toContain('y=2')
    expect(contents).not.toContain('code')
    expect(contents).not.toContain('fenced')
  })

  it('ignores escaped dollars', () => {
    const spans = scanMath('costs \\$5 and \\$10')
    expect(spans).toHaveLength(0)
  })
})

describe('statistics', () => {
  it('counts CJK characters and latin words', () => {
    const stats = countStats('Hello world\n中文四个字\n')
    expect(stats.words).toBe(2 + 5)
    expect(stats.lines).toBe(3)
    expect(stats.chars).toBe('Hello world\n中文四个字\n'.length)
  })

  it('is zero for an empty document', () => {
    const stats = countStats('')
    expect(stats.words).toBe(0)
    expect(stats.readMinutes).toBe(0)
  })
})

describe('inline editing transforms', () => {
  it('wraps and unwraps emphasis', () => {
    const edit = toggleInline('hello world', 6, 11, '**')
    expect(applyChanges('hello world', edit.changes)).toBe('hello **world**')
    const back = toggleInline('hello **world**', 8, 13, '**')
    expect(applyChanges('hello **world**', back.changes)).toBe('hello world')
  })

  it('inserts an empty pair with the caret inside', () => {
    const edit = toggleInline('ab', 1, 1, '*')
    expect(applyChanges('ab', edit.changes)).toBe('a**b')
    expect(edit.selection.anchor).toBe(2)
  })

  it('toggles a line prefix across a selection', () => {
    const doc = 'one\ntwo\nthree'
    const edit = toggleLinePrefix(doc, 0, doc.length, '> ')
    const quoted = applyChanges(doc, edit.changes)
    expect(quoted).toBe('> one\n> two\n> three')
    const undo = toggleLinePrefix(quoted, 0, quoted.length, '> ')
    expect(applyChanges(quoted, undo.changes)).toBe(doc)
  })

  it('sets and clears heading levels', () => {
    const doc = 'title\n### old heading\nbody'
    const set = setHeadingLevel(doc, 0, 0, 2)
    expect(applyChanges(doc, set.changes)).toBe('## title\n### old heading\nbody')
    const clear = setHeadingLevel('## title', 0, 0, 0)
    expect(applyChanges('## title', clear.changes)).toBe('title')
  })

  it('continues lists with the next number', () => {
    const doc = '3. third'
    const edit = continueList(doc, doc.length)!
    expect(applyChanges(doc, edit.changes)).toBe('3. third\n4. ')
  })

  it('ends a list on an empty item', () => {
    const doc = '- '
    const edit = continueList(doc, doc.length)!
    expect(applyChanges(doc, edit.changes)).toBe('')
  })

  it('does not continue a list inside plain text', () => {
    expect(continueList('plain text', 10)).toBeNull()
  })

  it('toggles a task marker', () => {
    const doc = '- [ ] do the thing'
    const edit = toggleTaskAt(doc, 5)!
    expect(applyChanges(doc, edit.changes)).toBe('- [x] do the thing')
    expect(applyChanges('- [x] done', toggleTaskAt('- [x] done', 3)!.changes)).toBe('- [ ] done')
    expect(toggleTaskAt('no task here', 2)).toBeNull()
  })

  it('computes line ranges', () => {
    const doc = 'a\nbb\nccc'
    expect(lineRangeAt(doc, 0)).toEqual({ from: 0, to: 1 })
    expect(lineRangeAt(doc, 3)).toEqual({ from: 2, to: 4 })
    expect(lineRangeAt(doc, doc.length)).toEqual({ from: 5, to: 8 })
  })

  it('strips inline markup for plain-text labels', () => {
    expect(stripInline('A **bold** and [link](x) and `code`')).toBe('A bold and link and code')
  })
})