import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { scanFences, scanFrontMatter, scanMath } from '../../shared/markdown'
import { renderMathHtml, resolveAssetUrl } from './editor/widgets'

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
  typographer: false
})

const EXPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 56px 48px 96px;
  max-width: 46rem;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  font-size: 16px;
  line-height: 1.72;
  color: #24211d;
  background: #ffffff;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}
h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.6em 0 0.55em; font-weight: 650; letter-spacing: -0.011em; }
h1 { font-size: 1.9em; margin-top: 0.6em; }
h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.1em; }
h5 { font-size: 1em; } h6 { font-size: 0.94em; color: #6b655d; }
p { margin: 0.75em 0; }
a { color: #2f6f6b; text-decoration: underline; text-underline-offset: 2px; }
blockquote { margin: 1em 0; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #d5cec3; color: #57524b; font-style: italic; }
ul, ol { padding-left: 1.45em; margin: 0.7em 0; }
li { margin: 0.25em 0; }
li > input[type=checkbox] { margin-right: 0.35em; accent-color: #2f6f6b; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.89em; background: #f1eee8; padding: 0.12em 0.32em; border-radius: 4px; }
pre { background: #f4f1eb; border-radius: 8px; padding: 14px 16px; overflow-x: auto; line-height: 1.55; }
pre code { background: none; padding: 0; font-size: 0.86em; }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr { border: none; height: 1px; background: #ddd6cb; margin: 2em 0; }
table { border-collapse: collapse; margin: 1.1em 0; font-size: 0.94em; width: 100%; }
th, td { border: 1px solid #ddd6cb; padding: 6px 10px; text-align: left; }
th { background: #f6f3ee; font-weight: 600; }
.katex-display, .math-block { margin: 1.1em 0; text-align: center; overflow-x: auto; }
.mermaid-figure { margin: 1.2em 0; text-align: center; }
.mermaid-figure svg { max-width: 100%; height: auto; }
.math-error, .mermaid-error { color: #b23c3c; font-size: 0.9em; }
.mermaid-error pre { text-align: left; }
sup, sub { line-height: 0; }
@page { size: A4; margin: 18mm 16mm; }
@media print { body { padding: 0; max-width: none; font-size: 11.5pt; } h1,h2,h3 { break-after: avoid; } pre, table, figure { break-inside: avoid; } }
`

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

async function fileToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** Replace task list markers with disabled checkboxes before rendering. */
function convertTasks(source: string): string {
  return source.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/gm, (_m, prefix: string, mark: string) => {
    const checked = mark.toLowerCase() === 'x' ? ' checked' : ''
    return `${prefix}<input type="checkbox" disabled${checked}> `
  })
}

export interface ExportOptions {
  title: string
  /** Base directory used to resolve relative image paths in the exported file. */
  docPath: string | null
}

/**
 * Produce a single self-contained HTML document: maths rendered by KaTeX,
 * diagrams inlined as SVG, images embedded as data URLs. Nothing is fetched from
 * the network.
 */
export async function buildExportHtml(source: string, opts: ExportOptions): Promise<string> {
  const fm = scanFrontMatter(source)
  let body = fm ? source.slice(fm.to) : source

  // 1. Protect maths and mermaid diagrams behind placeholders.
  const maths: Array<{ html: string; display: boolean }> = []
  const spans = scanMath(body)
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]
    const token = `%%TYPMATH${maths.length}%%`
    maths.push({ html: renderMathHtml(span.content, span.display), display: span.display })
    body = body.slice(0, span.from) + token + body.slice(span.to)
  }

  const diagrams: string[] = []
  const fences = scanFences(body)
  for (let i = fences.length - 1; i >= 0; i--) {
    const fence = fences[i]
    if (!/^mermaid\b/i.test(fence.info.trim())) continue
    const token = `%%TYPMERMAID${diagrams.length}%%`
    diagrams.push(fence.body)
    body = body.slice(0, fence.from) + token + body.slice(fence.to)
  }

  body = convertTasks(body)
  let html = md.render(body)

  // 2. Inject maths.
  maths.forEach((m, i) => {
    const token = `%%TYPMATH${i}%%`
    if (m.display) {
      const block = `<div class="math-block">${m.html}</div>`
      html = html.split(`<p>${token}</p>`).join(block)
      html = html.split(token).join(block)
    } else {
      html = html.split(token).join(`<span class="math-inline">${m.html}</span>`)
    }
  })

  // 3. Render diagrams locally.
  for (let i = 0; i < diagrams.length; i++) {
    const token = `%%TYPMERMAID${i}%%`
    let svg = ''
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { htmlLabels: false } })
      const rendered = await mermaid.render(`typing-export-${Date.now()}-${i}`, diagrams[i])
      svg = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    } catch (err) {
      svg = `<div class="mermaid-error"><p>Diagram could not be rendered: ${escapeHtml((err as Error).message)}</p><pre>${escapeHtml(diagrams[i])}</pre></div>`
    }
    const figure = `<figure class="mermaid-figure">${svg}</figure>`
    html = html.split(`<p>${token}</p>`).join(figure)
    html = html.split(token).join(figure)
  }

  // 4. Sanitize, then embed local images as data URLs.
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'align', 'checked', 'disabled'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick']
  })
  const doc = new DOMParser().parseFromString(`<div id="root">${clean}</div>`, 'text/html')
  const root = doc.getElementById('root') as HTMLElement
  const images = Array.from(root.querySelectorAll('img'))
  for (const img of images) {
    const src = img.getAttribute('src') || ''
    if (!src) continue
    if (/^data:/i.test(src)) continue
    const resolved = resolveAssetUrl(src)
    if (!resolved) {
      img.replaceWith(Object.assign(doc.createElement('span'), { className: 'math-error', textContent: `[image not loaded: ${src}]` }))
      continue
    }
    const dataUrl = await fileToDataUrl(resolved)
    if (dataUrl) img.setAttribute('src', dataUrl)
    else img.replaceWith(Object.assign(doc.createElement('span'), { className: 'math-error', textContent: `[missing image: ${src}]` }))
  }
  // Links to local files become plain text in the export.
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (/^(https?:|mailto:|#)/i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer noopener')
    }
  })

  const date = new Date().toLocaleString()
  void opts.docPath
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
${root.innerHTML}
<footer hidden>Exported by Typing on ${escapeHtml(date)}</footer>
</body>
</html>`
}