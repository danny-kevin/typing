import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { Range, StateEffect, StateField } from '@codemirror/state'
import { scanInlineLine, scanBlocks, type BlockSpan, type ScanLine } from '../../../shared/inline'
import { parseTable, scanFrontMatter, scanMath } from '../../../shared/markdown'
import {
  BulletWidget,
  CheckboxWidget,
  FrontMatterWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  resolveAssetUrl,
  renderMathHtml
} from './widgets'

interface Options {
  focusMode: boolean
  /** Highlight only the sentence/paragraph under the cursor and dim the rest. */
  dimInactive: boolean
}

export const livePreviewOptions = { focusMode: false, dimInactive: false }

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/

/**
 * Find a safe line to start scanning from: the visible window expanded to the
 * opening fence of a code block that began above the viewport (best effort,
 * bounded so typing stays fast on large documents).
 */
function windowStartLine(view: EditorView, firstVisible: number): number {
  const doc = view.state.doc
  const limit = Math.max(1, firstVisible - 300)
  let markers = 0
  let earliest = -1
  for (let n = firstVisible - 1; n >= limit; n--) {
    if (FENCE_LINE.test(doc.line(n).text)) {
      markers++
      earliest = n
    }
  }
  if (markers % 2 === 1 && earliest > 0) return earliest
  return Math.max(1, firstVisible - 1)
}

function selectionLines(view: EditorView): Set<number> {
  const out = new Set<number>()
  const doc = view.state.doc
  for (const r of view.state.selection.ranges) {
    const a = doc.lineAt(Math.min(r.from, doc.length)).number
    const b = doc.lineAt(Math.min(r.to, doc.length)).number
    for (let n = a; n <= b && n - a < 400; n++) out.add(n)
  }
  return out
}

function classMark(cls: string): Decoration {
  return Decoration.mark({ class: cls })
}

/** Push a mark decoration, skipping empty ranges (CodeMirror rejects them). */
function pushMark(ranges: Range<Decoration>[], cls: string, from: number, to: number): void {
  if (to > from) ranges.push(classMark(cls).range(from, to))
}

export interface PreviewBuild {
  set: DecorationSet
  startLine: number
  endLine: number
}

/** Lines decorated above/below the viewport, so small scrolls need no rebuild. */
const BACK_MARGIN = 120
const FORWARD_MARGIN = 220

export function buildLivePreview(view: EditorView): PreviewBuild {
  const state = view.state
  const doc = state.doc
  const ranges: Range<Decoration>[] = []
  const visible = view.visibleRanges
  if (!visible.length) return { set: Decoration.none, startLine: 1, endLine: 1 }

  const firstVisible = doc.lineAt(visible[0].from).number
  const lastVisible = doc.lineAt(visible[visible.length - 1].to).number
  const startLine = windowStartLine(view, Math.max(1, firstVisible - BACK_MARGIN))
  const endLine = Math.min(doc.lines, lastVisible + FORWARD_MARGIN)

  const lines: ScanLine[] = []
  for (let n = startLine; n <= endLine; n++) {
    const l = doc.line(n)
    lines.push({ from: l.from, to: l.to, text: l.text })
  }

  const active = selectionLines(view)
  const isLineActive = (n: number): boolean => active.has(n)

  const blocks = scanBlocks(lines)
  const startOffset = lines[0]?.from ?? 0
  const endOffset = lines[lines.length - 1]?.to ?? doc.length

  // Front matter is only recognised at the beginning of the document.
  let frontMatter: { from: number; to: number; body: string; startLine: number; endLine: number } | null = null
  if (startLine === 1 && doc.lines > 0 && doc.line(1).text.trimEnd() === '---') {
    for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
      const t = doc.line(n).text.trimEnd()
      if (t === '---' || t === '...') {
        const end = doc.line(n)
        const next = n < doc.lines ? doc.line(n + 1).from : end.to
        frontMatter = { from: 0, to: next, body: doc.sliceString(doc.line(1).to + 1, end.from), startLine: 1, endLine: n }
        break
      }
    }
  }

  /** Ranges already replaced by a block widget; nothing else may be drawn there. */
  const replaced: Array<{ from: number; to: number }> = []
  const isReplaced = (from: number, to: number): boolean => replaced.some((r) => from >= r.from && to <= r.to)

  const lineBlockFrom = (n: number): number => doc.line(n).from
  const lineBlockTo = (n: number): number => (n < doc.lines ? doc.line(n + 1).from : doc.line(n).to)

  // --- Front matter -------------------------------------------------------
  if (frontMatter) {
    const fm = frontMatter
    const activeFm = isLineActive(fm.startLine)
    if (!activeFm) {
      ranges.push(
        Decoration.replace({
          widget: new FrontMatterWidget(fm.body, fm.from),
          block: false
        }).range(fm.from, Math.min(fm.to, fm.to))
      )
      replaced.push({ from: fm.from, to: fm.to })
    } else {
      for (let n = fm.startLine; n <= fm.endLine; n++) {
        ranges.push(Decoration.line({ class: 'cm-frontmatter-line' }).range(doc.line(n).from))
      }
    }
  }

  const excluded: Array<{ from: number; to: number }> = []
  if (frontMatter) excluded.push({ from: frontMatter.from, to: frontMatter.to })

  // --- Block level --------------------------------------------------------
  for (const block of blocks) {
    // Block line numbers are indices into the scanned window; convert to
    // absolute document line numbers (1-based).
    const a = startLine + block.startLine
    const b = startLine + block.endLine
    const blockActive = (() => {
      for (let n = a; n <= b; n++) if (isLineActive(n)) return true
      return false
    })()
    const lineFrom = lineBlockFrom(a)
    const lineTo = lineBlockTo(b)

    switch (block.kind) {
      case 'fence': {
        const info = (block.info || '').split(/\s+/)[0].toLowerCase()
        const bodyFrom = a < b ? doc.line(a + 1).from : block.to
        const bodyTo = b > a ? doc.line(b).from : block.to
        excluded.push({ from: lineFrom, to: lineTo })

        if (info === 'mermaid' && !blockActive) {
          const code = doc.sliceString(bodyFrom, Math.max(bodyFrom, bodyTo))
          ranges.push(Decoration.replace({ widget: new MermaidWidget(code), block: true }).range(lineFrom, lineTo))
          replaced.push({ from: lineFrom, to: lineTo })
          break
        }

        for (let n = a; n <= b; n++) {
          const line = doc.line(n)
          const isFenceLine = n === a || n === b
          ranges.push(
            Decoration.line({
              class: isFenceLine ? 'cm-fence-line' : n === a + 1 ? 'cm-codeblock cm-codeblock-first' : 'cm-codeblock'
            }).range(line.from)
          )
          if (isFenceLine && !blockActive && !isReplaced(line.from, line.to)) {
            // Hide the ``` markers but keep the line so the caret can still sit
            // there when the block becomes active.
            const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line.text)
            if (m) {
              ranges.push(Decoration.replace({}).range(line.from, line.to))
            }
          }
        }
        if (info && !blockActive && a < b) {
          const badge = new LanguageBadge(info)
          ranges.push(Decoration.widget({ widget: badge, side: -1 }).range(doc.line(a + 1).from))
        }
        if (info === 'mermaid' && blockActive) {
          // Show a hint while editing a diagram.
          ranges.push(Decoration.widget({ widget: new HintBadge('mermaid — click outside to render'), side: 1 }).range(doc.line(a).to))
        }
        break
      }
      case 'table': {
        if (blockActive) {
          for (let n = a; n <= b; n++) ranges.push(Decoration.line({ class: 'cm-table-raw' }).range(doc.line(n).from))
          break
        }
        const model = parseTable(lines.slice(block.startLine, block.endLine + 1).map((l) => l.text))
        if (!model) break
        ranges.push(
          Decoration.replace({ widget: new TableWidget(model, lineFrom), block: true }).range(lineFrom, lineTo)
        )
        replaced.push({ from: lineFrom, to: lineTo })
        break
      }
      case 'hr': {
        if (blockActive) break
        ranges.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(lineFrom, lineTo))
        replaced.push({ from: lineFrom, to: lineTo })
        break
      }
      case 'heading': {
        const line = doc.line(a)
        ranges.push(Decoration.line({ class: `cm-heading cm-h${block.level ?? 1}` }).range(line.from))
        if (block.marker && !blockActive) {
          ranges.push(Decoration.replace({}).range(block.marker.from, block.marker.to))
        } else if (block.marker) {
          pushMark(ranges, 'cm-marker', block.marker.from, block.marker.to)
        }
        break
      }
      case 'quote': {
        for (let n = a; n <= b; n++) {
          const line = doc.line(n)
          ranges.push(Decoration.line({ class: 'cm-quote' }).range(line.from))
          if (!blockActive) {
            const m = /^( {0,3}>+\s?)/.exec(line.text)
            if (m) ranges.push(Decoration.replace({}).range(line.from, line.from + m[0].length))
          } else {
            const m = /^( {0,3}>+\s?)/.exec(line.text)
            if (m) pushMark(ranges, 'cm-marker', line.from, line.from + m[0].length)
          }
        }
        break
      }
      case 'task': {
        const line = doc.line(a)
        ranges.push(Decoration.line({ class: 'cm-list cm-task-line' }).range(line.from))
        const m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)\[( |x|X)\]\s+/.exec(line.text)
        if (!m) break
        const markerEnd = line.from + m[0].length
        if (blockActive) {
          pushMark(ranges, 'cm-marker', line.from, markerEnd)
        } else {
          const checkbox = new CheckboxWidget(m[4].toLowerCase() === 'x', line.from)
          ranges.push(
            Decoration.replace({ widget: checkbox }).range(line.from + m[1].length, line.from + m[1].length + 5)
          )
          ranges.push(Decoration.replace({}).range(line.from + m[1].length + 5, markerEnd))
        }
        break
      }
      case 'list': {
        const line = doc.line(a)
        ranges.push(Decoration.line({ class: 'cm-list' }).range(line.from))
        const m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(line.text)
        if (!m) break
        const markerFrom = line.from + m[1].length
        const markerTo = line.from + m[0].length
        if (blockActive) {
          pushMark(ranges, 'cm-marker', markerFrom, markerTo)
        } else if (/^[-*+]$/.test(m[2])) {
          ranges.push(
            Decoration.replace({ widget: new BulletWidget(null) }).range(markerFrom, markerFrom + 1)
          )
        } else {
          pushMark(ranges, 'cm-ordered-marker', markerFrom, markerFrom + m[2].length)
        }
        break
      }
      case 'html': {
        for (let n = a; n <= b; n++) ranges.push(Decoration.line({ class: 'cm-html' }).range(doc.line(n).from))
        if (blockActive) pushMark(ranges, 'cm-html-active', block.from, block.to)
        excluded.push({ from: block.from, to: block.to })
        break
      }
      default:
        break
    }
  }

  // --- Math ---------------------------------------------------------------
  const windowText = doc.sliceString(startOffset, endOffset)
  const mathSpans = scanMath(windowText)
  for (const span of mathSpans) {
    const from = startOffset + span.from
    const to = startOffset + span.to
    if (isReplaced(from, to) || isReplaced(to, to)) continue
    if (excluded.some((r) => from >= r.from && to <= r.to)) continue
    const lineFrom = doc.lineAt(from)
    const lineTo = doc.lineAt(to)
    const soloOnLine = lineFrom.from === from || doc.sliceString(lineFrom.from, from).trim() === ''
    const endsLine = doc.sliceString(to, lineTo.to).trim() === ''
    const activeMath = isLineActive(lineFrom.number) || isLineActive(lineTo.number)
    if (activeMath) {
      pushMark(ranges, 'cm-math-source', from, to)
      continue
    }
    if (span.display && soloOnLine && endsLine) {
      const blockFrom = lineFrom.from
      const blockTo = lineTo.number < doc.lines ? doc.line(lineTo.number + 1).from : lineTo.to
      ranges.push(
        Decoration.replace({ widget: new MathWidget(span.content, true), block: true }).range(blockFrom, blockTo)
      )
      replaced.push({ from: blockFrom, to: blockTo })
    } else {
      ranges.push(Decoration.replace({ widget: new MathWidget(span.content, span.display) }).range(from, to))
    }
  }

  // --- Inline formatting --------------------------------------------------
  for (const line of lines) {
    if (isReplaced(line.from, line.to)) continue
    const lineNumber = doc.lineAt(line.from).number
    if (excluded.some((r) => line.from >= r.from && line.to <= r.to)) continue
    if (active.has(lineNumber)) continue
    const spans = scanInlineLine(line.text, line.from, excluded)
    for (const span of spans) {
      if (isReplaced(span.from, span.to)) continue
      switch (span.kind) {
        case 'image': {
          ranges.push(
            Decoration.replace({
              widget: new ImageWidget(span.url ?? '', span.alt ?? '', span.title)
            }).range(span.from, span.to)
          )
          break
        }
        case 'code':
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          pushMark(ranges, 'cm-inline-code', span.textFrom, span.textTo)
          break
        case 'strong':
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          pushMark(ranges, 'cm-strong', span.textFrom, span.textTo)
          break
        case 'em':
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          pushMark(ranges, 'cm-em', span.textFrom, span.textTo)
          break
        case 'strike':
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          pushMark(ranges, 'cm-strike', span.textFrom, span.textTo)
          break
        case 'highlight':
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          pushMark(ranges, 'cm-highlight', span.textFrom, span.textTo)
          break
        case 'link': {
          pushMark(ranges, 'cm-link', span.textFrom, span.textTo)
          for (const [mf, mt] of span.markers) ranges.push(Decoration.replace({}).range(mf, mt))
          break
        }
      }
    }
  }

  // --- Focus mode ---------------------------------------------------------
  if (livePreviewOptions.focusMode) {
    const current = selectionLines(view)
    const currentBlocks = blocks.filter((b) => {
      for (let n = b.startLine; n <= b.endLine; n++) if (current.has(n)) return true
      return false
    })
    const focusRanges = currentBlocks.length
      ? currentBlocks.map((b) => ({ from: b.startLine, to: b.endLine }))
      : [{ from: firstVisible, to: firstVisible }]
    for (const line of lines) {
      const n = doc.lineAt(line.from).number
      if (isReplaced(line.from, line.to)) continue
      const inFocus = focusRanges.some((r) => n >= r.from && n <= r.to)
      if (!inFocus) ranges.push(Decoration.line({ class: 'cm-dim' }).range(line.from))
    }
  }

  return { set: Decoration.set(ranges, true), startLine, endLine }
}

class LanguageBadge extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(other: LanguageBadge): boolean {
    return other.label === this.label
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lang-badge'
    span.textContent = this.label
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

class HintBadge extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(other: HintBadge): boolean {
    return other.label === this.label
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-hint-badge'
    span.textContent = this.label
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

// Block widgets (tables, diagrams, display maths) may only be produced by a
// state field, not by a view plugin, so the decorations live in a field and a
// small driver plugin recomputes them when the document, selection or viewport
// changes.
const setLiveDecorations = StateEffect.define<DecorationSet>()

export const livePreviewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setLiveDecorations)) next = effect.value
    }
    if (tr.docChanged && next === value) next = value.map(tr.changes)
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

const driver = ViewPlugin.fromClass(
  class {
    private docVersion = 0
    private lastSignature = ''
    private dispatchedSignature = ''
    private scheduled = false
    private disposed = false
    private readonly onScroll = (): void => this.schedule()

    constructor(private view: EditorView) {
      this.lastSignature = this.signature(view)
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.docVersion++
      if (update.docChanged || update.selectionSet) {
        const signature = this.signature(update.view)
        if (signature !== this.lastSignature) {
          this.lastSignature = signature
          this.schedule()
        }
      }
    }

    destroy(): void {
      this.disposed = true
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    }

    private coveredStart = 0
    private coveredEnd = 0

    private signature(view: EditorView): string {
      return [
        this.docVersion,
        view.state.doc.length,
        selectionKey(view),
        viewportKey(view),
        livePreviewOptions.focusMode ? 'f' : '-'
      ].join('|')
    }

    /** True when the visible range is comfortably inside the decorated window. */
    private covered(view: EditorView): boolean {
      const ranges = view.visibleRanges
      if (!ranges.length || !this.coveredEnd) return false
      const doc = view.state.doc
      const first = doc.lineAt(ranges[0].from).number
      const last = doc.lineAt(ranges[ranges.length - 1].to).number
      return first > this.coveredStart + 20 && last < this.coveredEnd - 40
    }

    private schedule(): void {
      if (this.scheduled) return
      this.scheduled = true
      // One refresh per animation frame keeps scrolling smooth and prevents any
      // feedback loop between decorations and layout.
      requestAnimationFrame(() => {
        this.scheduled = false
        if (this.disposed || !this.view.dom.isConnected) return
        const view = this.view
        const signature = this.signature(view)
        if (signature === this.dispatchedSignature) return
        // A scroll that stays inside the already-decorated window needs no work.
        if (this.covered(view) && signature.split('|')[0] === this.dispatchedSignature.split('|')[0]) {
          this.dispatchedSignature = signature
          this.lastSignature = signature
          return
        }
        this.dispatchedSignature = signature
        this.lastSignature = signature
        const started = performance.now()
        try {
          const build = buildLivePreview(view)
          this.coveredStart = build.startLine
          this.coveredEnd = build.endLine
          const built = performance.now()
          view.dispatch({ effects: setLiveDecorations.of(build.set) })
          if ((window as unknown as { __typingPerf?: boolean }).__typingPerf) {
            const now = performance.now()
            console.log(
              `preview:build build=${(built - started).toFixed(1)}ms dispatch=${(now - built).toFixed(1)}ms lines=${build.endLine - build.startLine}`
            )
          }
        } catch (err) {
          console.error('Typing live preview failed:', err)
        }
      })
    }
  }
)

function selectionKey(view: EditorView): string {
  return view.state.selection.ranges.map((r) => `${r.from}:${r.to}`).join(',')
}

function viewportKey(view: EditorView): string {
  return view.visibleRanges.map((r) => `${r.from}-${r.to}`).join(',')
}

export const livePreview = [livePreviewField, driver]
