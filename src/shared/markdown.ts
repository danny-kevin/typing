/**
 * Pure markdown helpers used by the editor, the outline, the status bar and the
 * tests. Nothing in here ever rewrites a document on its own: every function is
 * a pure text transform that is only applied when the user asks for it, which is
 * what keeps Typing's source-fidelity promise (untouched files keep their exact
 * bytes).
 */

export interface LineInfo {
  /** Offset of the first character of the line. */
  from: number
  /** Offset just past the last character (exclusive, without the newline). */
  to: number
  /** The line text without its newline. */
  text: string
}

export function lineInfos(text: string): LineInfo[] {
  const out: LineInfo[] = []
  let from = 0
  while (from <= text.length) {
    const nl = text.indexOf('\n', from)
    const end = nl === -1 ? text.length : nl
    out.push({ from, to: end, text: text.slice(from, end) })
    if (nl === -1) break
    from = nl + 1
  }
  return out
}

export function lineCount(text: string): number {
  if (text.length === 0) return 1
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 1-based line/column for an offset, used by the status bar and the find bar. */
export function lineColAt(text: string, pos: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(pos, text.length))
  let line = 1
  let last = 0
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      last = i + 1
    }
  }
  return { line, col: clamped - last + 1 }
}

// ---------------------------------------------------------------------------
// Structural scanning
// ---------------------------------------------------------------------------

export interface FenceBlock {
  /** Offset of the opening fence line. */
  from: number
  /** Offset just past the closing fence line (or document end). */
  to: number
  /** Fence info string, e.g. "js" or "mermaid". */
  info: string
  /** Body text between the fences, trailing newline included. */
  body: string
  /** True when the closing fence was found. */
  closed: boolean
  /** Character used by the fence: ` or ~ */
  char: string
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function scanFences(text: string): FenceBlock[] {
  const lines = lineInfos(text)
  const out: FenceBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i].text)
    if (!m) continue
    const marker = m[1]
    const char = marker[0]
    const len = marker.length
    const info = m[2].trim()
    // A backtick fence's info string may not contain a backtick.
    if (char === '`' && info.includes('`')) continue
    let j = i + 1
    let closed = false
    let endOffset = text.length
    for (; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j].text)
      if (close && close[1][0] === char && close[1].length >= len) {
        closed = true
        endOffset = j + 1 < lines.length ? lines[j + 1].from : lines[j].to
        break
      }
    }
    const bodyStart = i + 1 < lines.length ? lines[i + 1].from : lines[i].to
    const bodyEnd = closed ? lines[j].from : text.length
    out.push({
      from: lines[i].from,
      to: closed ? endOffset : text.length,
      info,
      body: text.slice(bodyStart, bodyEnd),
      closed,
      char
    })
    if (closed) i = j
    else i = lines.length
  }
  return out
}

export interface FrontMatter {
  from: number
  to: number
  body: string
}

/** A YAML front matter block is only recognised at the very start of a file. */
export function scanFrontMatter(text: string): FrontMatter | null {
  if (!text.startsWith('---')) return null
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd === -1) return null
  const firstLine = text.slice(0, firstLineEnd).trimEnd()
  if (firstLine !== '---') return null
  const lines = lineInfos(text)
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].text.trimEnd()
    if (t === '---' || t === '...') {
      const to = i + 1 < lines.length ? lines[i + 1].from : lines[i].to
      return { from: 0, to, body: text.slice(firstLineEnd + 1, lines[i].from) }
    }
  }
  return null
}

export interface ExcludedRanges {
  /** Ranges whose contents must never be treated as inline markdown (code, html blocks). */
  ranges: Array<{ from: number; to: number; kind: 'code' | 'html' | 'frontmatter' }>
}

const HTML_LINE_RE = /^ {0,3}<(\/?[a-zA-Z][\w-]*|!--|!DOCTYPE|\?)/

export function scanExcluded(text: string, options: { inlineCode?: boolean } = {}): ExcludedRanges {
  const ranges: ExcludedRanges['ranges'] = []
  const fm = scanFrontMatter(text)
  if (fm) ranges.push({ from: fm.from, to: fm.to, kind: 'frontmatter' })
  for (const fence of scanFences(text)) ranges.push({ from: fence.from, to: fence.to, kind: 'code' })
  const lines = lineInfos(text)
  for (let i = 0; i < lines.length; i++) {
    if (!HTML_LINE_RE.test(lines[i].text)) continue
    // An HTML block runs until a blank line (CommonMark types 1-7 are close
    // enough for our purpose of not touching the text).
    let j = i
    while (j + 1 < lines.length && lines[j + 1].text.trim() !== '') j++
    ranges.push({ from: lines[i].from, to: lines[j].to, kind: 'html' })
    i = j
  }
  if (options.inlineCode === false) {
    ranges.sort((a, b) => a.from - b.from)
    return { ranges }
  }
  // Inline code spans: `...` on a single line.
  for (const line of lines) {
    if (ranges.some((r) => line.from >= r.from && line.to <= r.to)) continue
    const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      ranges.push({ from: line.from + m.index, to: line.from + m.index + m[0].length, kind: 'code' })
    }
  }
  ranges.sort((a, b) => a.from - b.from)
  return { ranges }
}

export function inRanges(ranges: Array<{ from: number; to: number }>, pos: number): boolean {
  return ranges.some((r) => pos >= r.from && pos < r.to)
}

export interface MathSpan {
  from: number
  to: number
  display: boolean
  content: string
}

/** Find `$...$` and `$$...$$` spans outside code/html/front matter. */
export function scanMath(text: string): MathSpan[] {
  const { ranges } = scanExcluded(text)
  const out: MathSpan[] = []
  const re = /\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > 0 && text[m.index - 1] === '\\') continue
    if (inRanges(ranges, m.index)) continue
    const display = m[1] !== undefined
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      display,
      content: display ? m[1] : (m[2] as string)
    })
  }
  return out
}

export interface OutlineItem {
  level: number
  text: string
  from: number
  line: number
}

const ATX_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/

/** Visible headings, ignoring anything inside code fences or front matter. */
export function extractOutline(text: string): OutlineItem[] {
  const excluded = scanExcluded(text, { inlineCode: false }).ranges
  const lines = lineInfos(text)
  // Front matter and fenced code never contribute headings (and a `---` closing
  // a front matter block must not be mistaken for a setext underline).
  const inCode = (pos: number): boolean =>
    excluded.some(
      (r) => (r.kind === 'code' || r.kind === 'frontmatter') && pos >= r.from && pos < r.to
    )
  const out: OutlineItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inCode(line.from)) continue
    const m = ATX_RE.exec(line.text)
    if (m) {
      out.push({ level: m[1].length, text: stripInline(m[2]), from: line.from, line: i + 1 })
      continue
    }
    if (i + 1 < lines.length && line.text.trim() !== '' && !inCode(lines[i + 1].from)) {
      const s = SETEXT_RE.exec(lines[i + 1].text)
      if (s && !ATX_RE.test(line.text)) {
        out.push({
          level: s[1][0] === '=' ? 1 : 2,
          text: stripInline(line.text.trim()),
          from: line.from,
          line: i + 1
        })
        i++
      }
    }
  }
  return out
}

/** Remove inline markdown noise so outline labels and word counts read naturally. */
export function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim()
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

export interface DocStats {
  words: number
  chars: number
  charsNoSpaces: number
  cjk: number
  lines: number
  /** Reading time in minutes, ~350 latin words or ~450 CJK characters per minute. */
  readMinutes: number
}

export function countStats(text: string): DocStats {
  const cjk = (text.match(CJK_RE) || []).length
  const latin = text
    .replace(CJK_RE, ' ')
    .replace(/[`*_#>~\[\]()|]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  const words = latin + cjk
  return {
    words,
    chars: text.length,
    charsNoSpaces: text.replace(/\s/g, '').length,
    cjk,
    lines: lineCount(text),
    readMinutes: Math.max(text.trim() ? 1 : 0, Math.round((latin / 350 + cjk / 450) * 10) / 10)
  }
}

// ---------------------------------------------------------------------------
// GFM tables
// ---------------------------------------------------------------------------

export type TableAlign = 'left' | 'center' | 'right' | 'none'

export interface TableModel {
  aligns: TableAlign[]
  header: string[]
  rows: string[][]
  /** True when the source had a leading/trailing pipe style we can preserve. */
  leadingPipe: boolean
  trailingPipe: boolean
}

/** Split a table row on unescaped pipes. */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

export function parseDelimiterRow(line: string): TableAlign[] | null {
  const cells = splitRow(line)
  if (!cells.length) return null
  const out: TableAlign[] = []
  for (const c of cells) {
    if (!/^:?-{1,}:?$/.test(c.trim())) return null
    const left = c.trim().startsWith(':')
    const right = c.trim().endsWith(':')
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : 'none')
  }
  return out
}

/** Parse a GFM table block; returns null when the lines are not a table. */
export function parseTable(lines: string[]): TableModel | null {
  if (lines.length < 2) return null
  const aligns = parseDelimiterRow(lines[1])
  if (!aligns) return null
  const header = splitRow(lines[0])
  const rows = lines.slice(2).map(splitRow)
  if (header.length !== aligns.length) return null
  const leadingPipe = lines[0].trim().startsWith('|')
  const trailingPipe = lines[0].trim().endsWith('|') && !lines[0].trim().endsWith('\\|')
  const width = aligns.length
  const fit = (r: string[]): string[] => {
    const copy = r.slice(0, width)
    while (copy.length < width) copy.push('')
    return copy
  }
  return {
    aligns,
    header: fit(header),
    rows: rows.map(fit),
    leadingPipe,
    trailingPipe
  }
}

function cellWidth(col: number, model: TableModel): number {
  let w = model.header[col]?.length ?? 0
  for (const row of model.rows) w = Math.max(w, (row[col] ?? '').length)
  return Math.max(3, w)
}

export function serializeTable(model: TableModel): string[] {
  const cols = model.aligns.length
  const widths = Array.from({ length: cols }, (_, i) => cellWidth(i, model))
  const pad = (s: string, i: number): string => {
    const w = widths[i]
    const a = model.aligns[i]
    if (a === 'right') return s.padStart(w)
    if (a === 'center') {
      const total = w - s.length
      const left = Math.floor(total / 2)
      return ' '.repeat(left) + s + ' '.repeat(total - left)
    }
    return s.padEnd(w)
  }
  const render = (cells: string[]): string =>
    (model.leadingPipe ? '| ' : '') +
    cells.map((c, i) => pad(c, i)).join(' | ') +
    (model.trailingPipe ? ' |' : '')
  const delim = model.aligns.map((a, i) => {
    const w = widths[i]
    const left = a === 'left' || a === 'center' ? ':' : ''
    const right = a === 'right' || a === 'center' ? ':' : ''
    return left + '-'.repeat(Math.max(1, w - left.length - right.length)) + right
  })
  return [render(model.header), render(delim), ...model.rows.map(render)]
}

// ---------------------------------------------------------------------------
// Pure edit transforms (used by commands; unit tested)
// ---------------------------------------------------------------------------

export interface TextChange {
  from: number
  to: number
  insert: string
}

export interface Edit {
  changes: TextChange[]
  selection: { anchor: number; head: number }
}

export function applyChanges(text: string, changes: TextChange[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from)
  let out = text
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  return out
}

export function lineRangeAt(text: string, pos: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1
  const nl = text.indexOf('\n', pos)
  return { from, to: nl === -1 ? text.length : nl }
}

/** Wrap or unwrap the selection with an inline marker such as `**`. */
export function toggleInline(text: string, from: number, to: number, marker: string): Edit {
  const selected = text.slice(from, to)
  const before = text.slice(Math.max(0, from - marker.length), from)
  const after = text.slice(to, to + marker.length)
  if (before === marker && after === marker) {
    return {
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' }
      ],
      selection: { anchor: from - marker.length, head: to - marker.length }
    }
  }
  const inner = selected
  if (inner.length >= marker.length * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    return {
      changes: [{ from, to, insert: inner.slice(marker.length, inner.length - marker.length) }],
      selection: { anchor: from, head: to - marker.length * 2 }
    }
  }
  if (from === to) {
    const pos = from + marker.length
    return {
      changes: [{ from, to, insert: marker + marker }],
      selection: { anchor: pos, head: pos }
    }
  }
  return {
    changes: [{ from, to, insert: marker + inner + marker }],
    selection: { anchor: from + marker.length, head: to + marker.length }
  }
}

/** Prefix every line touched by the selection, or remove the prefix when present. */
export function toggleLinePrefix(text: string, from: number, to: number, prefix: string): Edit {
  const start = lineRangeAt(text, from).from
  const endLine = lineRangeAt(text, Math.min(text.length, to)).to
  const block = text.slice(start, endLine)
  const lines = block.split('\n')
  const allHave = lines.every((l) => l.trim() === '' || l.startsWith(prefix))
  const next = lines.map((l) => {
    if (l.trim() === '') return l
    return allHave ? l.slice(prefix.length) : prefix + l
  })
  const insert = next.join('\n')
  const delta = insert.length - block.length
  return {
    changes: [{ from: start, to: endLine, insert }],
    selection: { anchor: from + (allHave ? -prefix.length : prefix.length), head: to + delta }
  }
}

/** Set (or clear with level 0) the ATX heading level of every selected line. */
export function setHeadingLevel(text: string, from: number, to: number, level: number): Edit {
  const start = lineRangeAt(text, from).from
  const endLine = lineRangeAt(text, Math.min(text.length, to)).to
  const block = text.slice(start, endLine)
  const lines = block.split('\n')
  const next = lines.map((l) => {
    const stripped = l.replace(/^ {0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')
    if (level === 0) return stripped
    return '#'.repeat(level) + ' ' + stripped
  })
  const insert = next.join('\n')
  return {
    changes: [{ from: start, to: endLine, insert }],
    selection: { anchor: from + Math.max(0, insert.length - block.length), head: to + (insert.length - block.length) }
  }
}

export interface TableEditContext {
  start: number
  end: number
  lines: string[]
  row: number
  col: number
}

/** Locate the table block around `pos` (returns null when the cursor is not in a table). */
export function tableContextAt(text: string, pos: number): TableEditContext | null {
  const lines = lineInfos(text)
  let idx = lines.findIndex((l) => pos >= l.from && pos <= l.to)
  if (idx < 0) return null
  const isRow = (s: string): boolean => s.includes('|')
  if (!isRow(lines[idx].text)) return null
  let start = idx
  while (start > 0 && isRow(lines[start - 1].text) && lines[start - 1].text.trim() !== '') start--
  let end = idx
  while (end + 1 < lines.length && isRow(lines[end + 1].text) && lines[end + 1].text.trim() !== '') end++
  if (end - start < 1) return null
  const model = parseTable(lines.slice(start, end + 1).map((l) => l.text))
  if (!model) return null
  const colIndex = (line: string, p: number): number => {
    const before = text.slice(lines[idx].from, p)
    const cells = before.split(/(?<!\\)\|/)
    return Math.max(0, Math.min(model.aligns.length - 1, cells.length - 1))
  }
  // Row 0 is the first body row; the delimiter row is not a row.
  const rowIndex = idx <= start + 1 ? -1 : idx - start - 2
  return {
    start: lines[start].from,
    end: lines[end].to,
    lines: lines.slice(start, end + 1).map((l) => l.text),
    row: rowIndex,
    col: colIndex(lines[idx].text, pos)
  }
}

export type TableOp =
  | { kind: 'addRowBelow' }
  | { kind: 'addRowAbove' }
  | { kind: 'addColumnRight' }
  | { kind: 'addColumnLeft' }
  | { kind: 'deleteRow' }
  | { kind: 'deleteColumn' }
  | { kind: 'moveRowUp' }
  | { kind: 'moveRowDown' }
  | { kind: 'align'; align: TableAlign }

export function applyTableOp(text: string, pos: number, op: TableOp): Edit | null {
  const ctx = tableContextAt(text, pos)
  if (!ctx) return null
  const model = parseTable(ctx.lines)
  if (!model) return null
  const cols = model.aligns.length
  let replaceLines: string[] | null = null

  switch (op.kind) {
    case 'addRowBelow':
    case 'addRowAbove': {
      const at = op.kind === 'addRowBelow' ? Math.max(0, ctx.row + 1) : Math.max(0, ctx.row)
      model.rows.splice(at, 0, Array.from({ length: cols }, () => ''))
      replaceLines = serializeTable(model)
      break
    }
    case 'deleteRow': {
      if (ctx.row < 0) return null
      model.rows.splice(ctx.row, 1)
      replaceLines = serializeTable(model)
      break
    }
    case 'addColumnRight':
    case 'addColumnLeft': {
      const at = op.kind === 'addColumnRight' ? ctx.col + 1 : ctx.col
      model.aligns.splice(at, 0, 'none')
      model.header.splice(at, 0, '')
      for (const r of model.rows) r.splice(at, 0, '')
      replaceLines = serializeTable(model)
      break
    }
    case 'deleteColumn': {
      if (cols <= 1) return null
      model.aligns.splice(ctx.col, 1)
      model.header.splice(ctx.col, 1)
      for (const r of model.rows) r.splice(ctx.col, 1)
      replaceLines = serializeTable(model)
      break
    }
    case 'moveRowUp':
    case 'moveRowDown': {
      if (ctx.row < 0) return null
      const target = op.kind === 'moveRowUp' ? ctx.row - 1 : ctx.row + 1
      if (target < 0 || target >= model.rows.length) return null
      const [row] = model.rows.splice(ctx.row, 1)
      model.rows.splice(target, 0, row)
      replaceLines = serializeTable(model)
      break
    }
    case 'align': {
      model.aligns[ctx.col] = op.align
      replaceLines = serializeTable(model)
      break
    }
  }
  if (!replaceLines) return null
  const insert = replaceLines.join('\n')
  const end = ctx.start + insert.length
  return {
    changes: [{ from: ctx.start, to: ctx.end, insert }],
    // Collapse the caret at the end of the block that was rewritten. A selection
    // that runs past it would mark the lines after the table as "active", which
    // renders their live preview as raw source.
    selection: { anchor: end, head: end }
  }
}

/** Insert a fresh 3x3 table at the cursor's line. */
export function insertTable(text: string, pos: number): Edit {
  const { from } = lineRangeAt(text, pos)
  const block = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'
  const needsNewline = from > 0 && text[from - 1] !== '\n'
  const insert = (needsNewline ? '\n' : '') + block + '\n'
  const anchor = from + insert.length - 2 + 2
  return {
    changes: [{ from, to: from, insert }],
    selection: { anchor: Math.min(anchor, from + insert.length), head: Math.min(anchor, from + insert.length) }
  }
}

/** Toggle a task checkbox on the given line. */
export function toggleTaskAt(text: string, pos: number): Edit | null {
  const { from, to } = lineRangeAt(text, pos)
  const line = text.slice(from, to)
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/.exec(line)
  if (!m) return null
  const next = m[2] === ' ' ? 'x' : ' '
  return {
    changes: [
      {
        from: from + m[1].length,
        to: from + m[1].length + 1,
        insert: next
      }
    ],
    selection: { anchor: pos, head: pos }
  }
}

/** List continuation on Enter, so writing lists feels like a word processor. */
export function continueList(text: string, pos: number): Edit | null {
  const { from } = lineRangeAt(text, pos)
  const line = text.slice(from, pos)
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/.exec(line)
  if (!m) return null
  const rest = line.slice(m[0].length)
  if (rest.trim() === '') {
    // Empty item: end the list by removing the marker.
    return {
      changes: [{ from, to: pos, insert: '' }],
      selection: { anchor: from, head: from }
    }
  }
  const indent = m[1]
  const marker = m[2]
  const bullet = /^\d/.test(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(marker.length - 1)}` : marker
  const task = m[4] ? '[ ] ' : ''
  return {
    changes: [{ from: pos, to: pos, insert: '\n' + indent + bullet + m[3] + task }],
    selection: { anchor: pos + 1 + indent.length + bullet.length + m[3].length + task.length, head: pos + 1 + indent.length + bullet.length + m[3].length + task.length }
  }
}