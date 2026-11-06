import { describe, it, expect } from 'vitest'
import { scanBlocks, scanInlineLine } from '../../src/shared/inline'

const spansOf = (line: string, base = 0) => scanInlineLine(line, base)

describe('inline scanner', () => {
  it('finds strong, emphasis, code, strike and highlight', () => {
    const spans = spansOf('a **bold** b *it* c `code` d ~~gone~~ e ==mark==')
    expect(spans.map((s) => s.kind)).toEqual(['strong', 'em', 'code', 'strike', 'highlight'])
    const bold = spans[0]
    expect(bold.from).toBe(2)
    expect(bold.textFrom).toBe(4)
    expect(bold.markers).toHaveLength(2)
  })

  it('finds links and images with their targets', () => {
    const spans = spansOf('see [the docs](https://example.com/a_(b)) and ![alt](assets/x.png "t")')
    const link = spans.find((s) => s.kind === 'link')!
    expect(link.url).toBe('https://example.com/a_(b)')
    expect(link.textFrom).toBe(5)
    const image = spans.find((s) => s.kind === 'image')!
    expect(image.alt).toBe('alt')
    expect(image.url).toBe('assets/x.png')
    expect(image.title).toBe('t')
  })

  it('handles reference links', () => {
    const spans = spansOf('[label][ref]')
    expect(spans[0].kind).toBe('link')
    expect(spans[0].textFrom).toBe(1)
  })

  it('ignores intraword underscores used by snake_case names', () => {
    const spans = spansOf('call some_function_name(1) and other_thing')
    expect(spans).toHaveLength(0)
  })

  it('does not treat a lone asterisk as emphasis', () => {
    expect(spansOf('2 * 3 = 6')).toHaveLength(0)
    expect(spansOf('a * b * c')).toHaveLength(0)
  })

  it('leaves Chinese text with full-width punctuation alone', () => {
    const spans = spansOf('中文段落，包含（括号）与“引号”。')
    expect(spans).toHaveLength(0)
  })

  it('finds emphasis around Chinese text', () => {
    const spans = spansOf('这是**重点**内容')
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toBe('strong')
    expect(spans[0].textFrom).toBe(4)
  })

  it('does not interpret markup inside inline code', () => {
    const spans = spansOf('`**not bold**`')
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toBe('code')
  })

  it('respects excluded ranges', () => {
    const line = '**bold**'
    const spans = scanInlineLine(line, 100, [{ from: 100, to: 108 }])
    expect(spans).toHaveLength(0)
  })

  it('ignores escaped markers', () => {
    expect(spansOf('\\*not emphasis\\*')).toHaveLength(0)
  })
})

describe('block scanner', () => {
  const lines = (text: string) => {
    const out: Array<{ from: number; to: number; text: string }> = []
    let offset = 0
    for (const part of text.split('\n')) {
      out.push({ from: offset, to: offset + part.length, text: part })
      offset += part.length + 1
    }
    return out
  }

  it('classifies headings, quotes, lists and tasks', () => {
    const blocks = scanBlocks(
      lines(['# h1', '> quote', '- item', '- [ ] task', '1. ordered', '---', 'paragraph'].join('\n'))
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'quote', 'list', 'task', 'list', 'hr', 'paragraph'])
    expect(blocks[0].level).toBe(1)
    expect(blocks[3].checked).toBe(false)
  })

  it('groups fenced code and tables into single blocks', () => {
    const text = ['```js', 'code', '```', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'after'].join('\n')
    const blocks = scanBlocks(lines(text))
    const fence = blocks.find((b) => b.kind === 'fence')!
    expect([fence.startLine, fence.endLine]).toEqual([0, 2])
    expect(fence.info).toBe('js')
    const table = blocks.find((b) => b.kind === 'table')!
    expect([table.startLine, table.endLine]).toEqual([4, 6])
  })

  it('does not treat a delimiter row without a header as a table', () => {
    const blocks = scanBlocks(lines('| --- | --- |\ntext'))
    expect(blocks.some((b) => b.kind === 'table')).toBe(false)
  })

  it('keeps task markers pointing at the marker only', () => {
    const text = '- [x] done thing'
    const blocks = scanBlocks(lines(text))
    const task = blocks[0]
    expect(task.kind).toBe('task')
    expect(task.checked).toBe(true)
  })
})