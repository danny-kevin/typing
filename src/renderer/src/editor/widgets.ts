import { WidgetType, EditorView } from '@codemirror/view'
import katex from 'katex'
import mermaid from 'mermaid'
import type { TableModel } from '../../../shared/markdown'

/** The directory of the open document, used to resolve relative asset links. */
export const docContext = { dir: '' as string, path: '' as string }

export function setDocContext(path: string): void {
  docContext.path = path
  docContext.dir = path ? path.replace(/\/[^/]*$/, '') : ''
}

function normalizePath(p: string): string {
  const parts = p.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** Resolve a markdown image/link target to a URL the renderer may load. */
export function resolveAssetUrl(url: string): string | null {
  const u = url.trim()
  if (!u) return null
  if (/^data:image\//i.test(u)) return u
  if (/^https?:/i.test(u)) return null // no remote loading, by design
  if (/^[a-z]+:/i.test(u) && !u.startsWith('file:')) return null
  if (u.startsWith('#')) return null
  let abs: string
  if (u.startsWith('file://')) abs = decodeURI(u.slice('file://'.length))
  else if (u.startsWith('/')) abs = normalizePath(u)
  else if (docContext.dir) abs = normalizePath(docContext.dir + '/' + u)
  else return null
  return `typing-asset://asset/${encodeURIComponent(abs)}`
}

// ---------------------------------------------------------------------------
// KaTeX
// ---------------------------------------------------------------------------

let katexConfigured = false

export function renderMathHtml(content: string, display: boolean): string {
  if (!katexConfigured) {
    katexConfigured = true
  }
  try {
    return katex.renderToString(content, {
      displayMode: display,
      throwOnError: false,
      errorColor: '#cc5555',
      strict: 'ignore',
      trust: false,
      output: 'html'
    })
  } catch (err) {
    const span = document.createElement('span')
    span.className = 'math-error'
    span.textContent = `math error: ${(err as Error).message}`
    return span.outerHTML
  }
}

export class MathWidget extends WidgetType {
  constructor(readonly content: string, readonly display: boolean) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.content === this.content && other.display === this.display
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement(this.display ? 'div' : 'span')
    wrap.className = this.display ? 'cm-math-block' : 'cm-math-inline'
    // KaTeX output is generated locally from its own renderer and never contains
    // document-authored HTML; raw HTML in a document stays as text.
    wrap.innerHTML = renderMathHtml(this.content, this.display)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

let mermaidReady = false
let mermaidSeq = 0

function initMermaid(dark: boolean): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
    flowchart: { htmlLabels: false },
    themeVariables: dark ? { background: '#1e1e22' } : { background: '#ffffff' }
  })
  mermaidReady = true
}

export class MermaidWidget extends WidgetType {
  private container: HTMLElement | null = null
  private observer: MutationObserver | null = null

  constructor(readonly code: string) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-mermaid'
    const inner = document.createElement('div')
    inner.className = 'cm-mermaid-inner'
    inner.textContent = 'Rendering diagram…'
    wrap.appendChild(inner)
    this.container = inner
    const dark = document.documentElement.classList.contains('dark')
    if (!mermaidReady) initMermaid(dark)
    const id = `typing-mermaid-${++mermaidSeq}`
    void mermaid
      .render(id, this.code)
      .then(({ svg }) => {
        if (!this.container) return
        this.container.textContent = ''
        this.container.innerHTML = svg
        this.container.classList.add('done')
        // Allow clicking the diagram to edit its source.
        this.container.style.cursor = 'text'
      })
      .catch((err: Error) => {
        if (!this.container) return
        this.container.textContent = ''
        const pre = document.createElement('div')
        pre.className = 'cm-mermaid-error'
        pre.textContent = `Diagram error: ${err.message}`
        this.container.appendChild(pre)
        const src = document.createElement('pre')
        src.className = 'cm-mermaid-source'
        src.textContent = this.code
        this.container.appendChild(src)
      })
    void view
    return wrap
  }

  destroy(): void {
    this.observer?.disconnect()
    this.container = null
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly title?: string) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt && other.title === this.title
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const src = resolveAssetUrl(this.url)
    if (!src) {
      wrap.classList.add('cm-image-blocked')
      wrap.textContent = this.url ? `🖼 ${this.alt || this.url} (external image not loaded)` : '🖼 image'
      wrap.title = this.url
      return wrap
    }
    const img = document.createElement('img')
    img.src = src
    img.alt = this.alt
    if (this.title) img.title = this.title
    img.loading = 'eager'
    img.addEventListener('error', () => {
      wrap.textContent = `🖼 ${this.alt || this.url} (not found)`
      wrap.classList.add('cm-image-blocked')
    })
    wrap.appendChild(img)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Task checkbox
// ---------------------------------------------------------------------------

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super()
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-task'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.setAttribute('aria-label', this.checked ? 'Mark task as not done' : 'Mark task as done')
    input.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const task = view.state.doc.lineAt(this.pos)
      const text = task.text
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/.exec(text)
      if (!m) return
      const from = task.from + m[1].length
      view.dispatch({ changes: { from, to: from + 1, insert: m[2] === ' ' ? 'x' : ' ' } })
      view.focus()
    })
    wrap.appendChild(input)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Bullet
// ---------------------------------------------------------------------------

export class BulletWidget extends WidgetType {
  constructor(readonly ordered: string | null) {
    super()
  }

  eq(other: BulletWidget): boolean {
    return other.ordered === this.ordered
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-bullet'
    span.textContent = this.ordered ?? '•'
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel, readonly from: number) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.from === this.from && JSON.stringify(other.model) === JSON.stringify(this.model)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-table'
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.model.header.forEach((cell, i) => {
      const th = document.createElement('th')
      th.textContent = cell
      const align = this.model.aligns[i]
      if (align && align !== 'none') th.style.textAlign = align
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.model.rows) {
      const tr = document.createElement('tr')
      row.forEach((cell, i) => {
        const td = document.createElement('td')
        td.textContent = cell
        const align = this.model.aligns[i]
        if (align && align !== 'none') td.style.textAlign = align
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    wrap.title = 'Click to edit this table as Markdown'
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Horizontal rule and front matter
// ---------------------------------------------------------------------------

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-hr-wrap'
    wrap.appendChild(document.createElement('hr'))
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

export class FrontMatterWidget extends WidgetType {
  constructor(readonly body: string, readonly from: number) {
    super()
  }

  eq(other: FrontMatterWidget): boolean {
    return other.body === this.body
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-frontmatter'
    wrap.title = 'Click to edit front matter'
    const label = document.createElement('span')
    label.className = 'cm-frontmatter-label'
    label.textContent = 'Front matter'
    const summary = document.createElement('span')
    summary.className = 'cm-frontmatter-summary'
    const keys = this.body
      .split('\n')
      .map((l) => /^([\w.-]+)\s*:/.exec(l)?.[1])
      .filter(Boolean)
    summary.textContent = keys.length ? keys.join(' · ') : '(empty)'
    wrap.append(label, summary)
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}