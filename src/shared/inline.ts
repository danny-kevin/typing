/**
 * Inline markdown scanner.
 *
 * The editor's live preview renders inline syntax from this scanner rather than
 * from a parser tree so that the visual layer is fully deterministic and never
 * touches the document. It only reports spans; nothing here rewrites text.
 */

export type InlineKind = 'code' | 'strong' | 'em' | 'strike' | 'highlight' | 'link' | 'image'

export interface InlineSpan {
  kind: InlineKind
  /** Absolute start of the whole construct (first marker char). */
  from: number
  /** Absolute end of the whole construct (exclusive). */
  to: number
  /** Absolute range of the visible content (link text, emphasis content, ...). */
  textFrom: number
  textTo: number
  /** Marker ranges that can be hidden when the cursor is elsewhere. */
  markers: Array<[number, number]>
  url?: string
  title?: string
  alt?: string
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

function findClosing(s: string, start: number, needle: string): number {
  let i = start
  while (i <= s.length - needle.length) {
    if (s.startsWith(needle, i) && s[i - 1] !== '\\') return i
    i++
  }
  return -1
}

/** Parse `(url "title")` starting at the `(` index. Returns null when malformed. */
export function parseLinkTarget(s: string, openParen: number): { url: string; title?: string; end: number } | null {
  if (s[openParen] !== '(') return null
  let i = openParen + 1
  let depth = 1
  let url = ''
  let inAngle = false
  if (s[i] === '<') {
    inAngle = true
    i++
  }
  for (; i < s.length; i++) {
    const c = s[i]
    if (inAngle) {
      if (c === '>') {
        inAngle = false
        i++
        break
      }
      if (c === '\n') return null
      url += c
      continue
    }
    if (c === '(') depth++
    if (c === ')') {
      depth--
      if (depth === 0) return { url: url.trim(), end: i + 1 }
    }
    if (c === '\\' && i + 1 < s.length) {
      url += s[i + 1]
      i++
      continue
    }
    if (c === undefined) break
    url += c
  }
  // Unterminated
  return null
}

function splitUrlTitle(raw: string): { url: string; title?: string } {
  const m = /^(\S*)\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/.exec(raw.trim())
  if (m) return { url: m[1], title: m[2] ?? m[3] ?? m[4] }
  return { url: raw.trim() }
}

/**
 * Scan one line. `base` is the absolute offset of `line[0]` in the document and
 * `excluded` holds absolute ranges that must not be interpreted (code spans,
 * html blocks, front matter).
 */
export function scanInlineLine(
  line: string,
  base: number,
  excluded: Array<{ from: number; to: number }> = []
): InlineSpan[] {
  const spans: InlineSpan[] = []
  const isSkipped = (abs: number): boolean => excluded.some((r) => abs >= r.from && abs < r.to)
  let i = 0
  while (i < line.length) {
    const abs = base + i
    if (isSkipped(abs)) {
      i++
      continue
    }
    const c = line[i]

    // Inline code
    if (c === '`') {
      let run = 0
      while (line[i + run] === '`') run++
      const closing = findClosing(line, i + run, '`'.repeat(run))
      if (closing !== -1) {
        spans.push({
          kind: 'code',
          from: abs,
          to: base + closing + run,
          textFrom: abs + run,
          textTo: base + closing,
          markers: [
            [abs, abs + run],
            [base + closing, base + closing + run]
          ]
        })
        i = closing + run
        continue
      }
      i += run
      continue
    }

    // Images and links
    if (c === '!' && line[i + 1] === '[') {
      const close = findClosing(line, i + 2, ']')
      if (close !== -1 && line[close + 1] === '(') {
        const target = parseLinkTarget(line, close + 1)
        if (target) {
          const { url, title } = splitUrlTitle(target.url)
          spans.push({
            kind: 'image',
            from: abs,
            to: base + target.end,
            textFrom: abs + 2,
            textTo: base + close,
            alt: line.slice(i + 2, close),
            url,
            title,
            markers: [
              [abs, abs + 2],
              [base + close, base + target.end]
            ]
          })
          i = target.end
          continue
        }
      }
      i += 2
      continue
    }
    if (c === '[') {
      const close = findClosing(line, i + 1, ']')
      if (close !== -1) {
        if (line[close + 1] === '(') {
          const target = parseLinkTarget(line, close + 1)
          if (target) {
            const { url, title } = splitUrlTitle(target.url)
            spans.push({
              kind: 'link',
              from: abs,
              to: base + target.end,
              textFrom: abs + 1,
              textTo: base + close,
              url,
              title,
              markers: [
                [abs, abs + 1],
                [base + close, base + target.end]
              ]
            })
            i = target.end
            continue
          }
        } else if (line[close + 1] === '[') {
          const refClose = findClosing(line, close + 2, ']')
          if (refClose !== -1) {
            spans.push({
              kind: 'link',
              from: abs,
              to: base + refClose + 1,
              textFrom: abs + 1,
              textTo: base + close,
              markers: [
                [abs, abs + 1],
                [base + close, base + refClose + 1]
              ]
            })
            i = refClose + 1
            continue
          }
        }
      }
      i++
      continue
    }

    // Strong / emphasis / strike / highlight
    const twoChar = line.slice(i, i + 2)
    if (twoChar === '**' || twoChar === '__' || twoChar === '~~' || twoChar === '==') {
      const closing = findClosing(line, i + 2, twoChar)
      if (closing !== -1 && closing > i + 2) {
        const kind: InlineKind = twoChar === '~~' ? 'strike' : twoChar === '==' ? 'highlight' : 'strong'
        spans.push({
          kind,
          from: abs,
          to: base + closing + 2,
          textFrom: abs + 2,
          textTo: base + closing,
          markers: [
            [abs, abs + 2],
            [base + closing, base + closing + 2]
          ]
        })
        i = closing + 2
        continue
      }
      i += 2
      continue
    }
    if (c === '*' || c === '_') {
      const prev = line[i - 1]
      const next = line[i + 1]
      const isWordy = (ch: string | undefined): boolean => !!ch && WORD_CHAR.test(ch)
      if (c === '_' && (isWordy(prev) || isWordy(next))) {
        i++
        continue
      }
      if (!next || /\s/.test(next)) {
        i++
        continue
      }
      const closing = findClosing(line, i + 1, c)
      if (closing !== -1 && closing > i + 1) {
        // A closing emphasis at end of line, or before punctuation/space.
        const after = line[closing + 1]
        if (after === undefined || /[\s.,!?;:)\]}'"]/.test(after)) {
          spans.push({
            kind: 'em',
            from: abs,
            to: base + closing + 1,
            textFrom: abs + 1,
            textTo: base + closing,
            markers: [
              [abs, abs + 1],
              [base + closing, base + closing + 1]
            ]
          })
          i = closing + 1
          continue
        }
      }
      i++
      continue
    }
    i++
  }
  return spans
}

// ---------------------------------------------------------------------------
// Block scanning
// ---------------------------------------------------------------------------

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'list'
  | 'task'
  | 'fence'
  | 'table'
  | 'hr'
  | 'frontmatter'
  | 'html'

export interface BlockSpan {
  kind: BlockKind
  level?: number
  startLine: number
  endLine: number
  /** Absolute range of the block. */
  from: number
  to: number
  /** Marker characters that the live preview may hide when the block is inactive. */
  marker?: { from: number; to: number }
  /** For fences: language info string. */
  info?: string
  /** For task items: checked state. */
  checked?: boolean
}

export interface ScanLine {
  from: number
  to: number
  text: string
}

const ATX = /^( {0,3})(#{1,6})(\s+)(.*)$/
const QUOTE = /^( {0,3})(>+)( ?)(.*)$/
const UL = /^(\s*)([-*+])(\s+)(.*)$/
const OL = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/
const TASK = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)\[( |x|X)\]\s+/

function isTableLine(text: string): boolean {
  return text.includes('|') && text.trim() !== ''
}

/**
 * Classify lines into blocks. Blocks are only used for decoration and the
 * outline; the text is never modified.
 */
export function scanBlocks(lines: ScanLine[]): BlockSpan[] {
  const out: BlockSpan[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const text = line.text

    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (fence) {
      const char = fence[1][0]
      const len = fence[1].length
      const info = fence[2].trim()
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j].text)
        if (close && close[1][0] === char && close[1].length >= len) {
          closed = true
          break
        }
      }
      const endLine = closed ? j : lines.length - 1
      out.push({
        kind: 'fence',
        startLine: i,
        endLine,
        from: line.from,
        to: lines[endLine].to,
        info,
        marker: { from: line.from, to: line.from + fence[1].length }
      })
      i = endLine + 1
      continue
    }

    const heading = ATX.exec(text)
    if (heading) {
      out.push({
        kind: 'heading',
        level: heading[2].length,
        startLine: i,
        endLine: i,
        from: line.from,
        to: line.to,
        marker: { from: line.from + heading[1].length, to: line.from + heading[1].length + heading[2].length }
      })
      i++
      continue
    }

    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(text)) {
      out.push({ kind: 'hr', startLine: i, endLine: i, from: line.from, to: line.to })
      i++
      continue
    }

    // GFM table: header row followed by a delimiter row.
    if (isTableLine(text) && i + 1 < lines.length && /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1].text) && lines[i + 1].text.includes('-')) {
      let j = i + 1
      while (j + 1 < lines.length && isTableLine(lines[j + 1].text)) j++
      out.push({ kind: 'table', startLine: i, endLine: j, from: line.from, to: lines[j].to })
      i = j + 1
      continue
    }

    const quote = QUOTE.exec(text)
    if (quote) {
      let j = i
      while (j + 1 < lines.length && QUOTE.test(lines[j + 1].text)) j++
      out.push({
        kind: 'quote',
        startLine: i,
        endLine: j,
        from: line.from,
        to: lines[j].to,
        marker: { from: line.from, to: line.from + quote[1].length + quote[2].length + (quote[3] ? 1 : 0) }
      })
      i = j + 1
      continue
    }

    const task = TASK.exec(text)
    if (task) {
      out.push({
        kind: 'task',
        startLine: i,
        endLine: i,
        from: line.from,
        to: line.to,
        checked: task[4].toLowerCase() === 'x',
        marker: { from: line.from, to: line.from + text.length }
      })
      i++
      continue
    }

    const ul = UL.exec(text)
    const ol = OL.exec(text)
    if (ul || ol) {
      out.push({
        kind: 'list',
        startLine: i,
        endLine: i,
        from: line.from,
        to: line.to,
        marker: { from: line.from, to: line.from + (ul ? ul[1].length + 1 : ol ? ol[1].length + ol[2].length + 1 : 0) }
      })
      i++
      continue
    }

    if (/^ {0,3}</.test(text)) {
      let j = i
      while (j + 1 < lines.length && lines[j + 1].text.trim() !== '') j++
      out.push({ kind: 'html', startLine: i, endLine: j, from: line.from, to: lines[j].to })
      i = j + 1
      continue
    }

    out.push({ kind: 'paragraph', startLine: i, endLine: i, from: line.from, to: line.to })
    i++
  }
  return out
}