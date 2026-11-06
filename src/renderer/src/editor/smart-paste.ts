import { EditorView } from '@codemirror/view'

/** Minimal, dependency-free HTML → Markdown conversion for smart paste. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (doc.body.querySelector('script, iframe, object, embed')) return ''
  return normalize(convertChildren(doc.body))
}

function normalize(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function inlineText(node: Node): string {
  return convertChildren(node).replace(/\n+/g, ' ').trim()
}

function convertChildren(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    out += convertNode(child)
  })
  return out
}

function convertNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/\s+/g, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'script':
    case 'style':
    case 'noscript':
    case 'svg':
      return ''
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${inlineText(el)}\n\n`
    case 'p':
      return `\n\n${inlineText(el)}\n\n`
    case 'br':
      return '  \n'
    case 'hr':
      return '\n\n---\n\n'
    case 'strong':
    case 'b': {
      const text = inlineText(el)
      return text ? `**${text}**` : ''
    }
    case 'em':
    case 'i': {
      const text = inlineText(el)
      return text ? `*${text}*` : ''
    }
    case 'del':
    case 's': {
      const text = inlineText(el)
      return text ? `~~${text}~~` : ''
    }
    case 'code': {
      const text = el.textContent || ''
      return text.includes('\n') ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : `\`${text}\``
    }
    case 'pre': {
      const code = el.querySelector('code')
      const text = (code ?? el).textContent || ''
      const langClass = code?.className.match(/language-([\w-]+)/)?.[1] ?? ''
      return `\n\n\`\`\`${langClass}\n${text.replace(/\n$/, '')}\n\`\`\`\n\n`
    }
    case 'blockquote': {
      const text = normalize(convertChildren(el))
      return `\n\n${text
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')}\n\n`
    }
    case 'ul':
    case 'ol': {
      const items: string[] = []
      let index = 1
      el.querySelectorAll(':scope > li').forEach((li) => {
        const prefix = tag === 'ol' ? `${index++}. ` : '- '
        const body = normalize(convertChildren(li)).replace(/\n/g, '\n  ')
        items.push(prefix + body)
      })
      return `\n\n${items.join('\n')}\n\n`
    }
    case 'a': {
      const text = inlineText(el) || el.getAttribute('href') || ''
      const href = el.getAttribute('href') || ''
      if (!href || href.startsWith('javascript:')) return text
      return `[${text}](${href})`
    }
    case 'img': {
      const src = el.getAttribute('src') || ''
      if (!src || src.startsWith('data:')) return ''
      const alt = el.getAttribute('alt') || ''
      return `![${alt}](${src})`
    }
    case 'table': {
      const rows: string[][] = []
      el.querySelectorAll('tr').forEach((tr) => {
        const cells: string[] = []
        tr.querySelectorAll('th,td').forEach((c) => cells.push(inlineText(c)))
        if (cells.length) rows.push(cells)
      })
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const pad = (r: string[]): string[] => [...r, ...Array(width - r.length).fill('')]
      const lines = [
        `| ${pad(rows[0]).join(' | ')} |`,
        `| ${Array(width).fill('---').join(' | ')} |`,
        ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)
      ]
      return `\n\n${lines.join('\n')}\n\n`
    }
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'figure':
    case 'figcaption':
      return `${convertChildren(el)}\n\n`
    default:
      return convertChildren(el)
  }
}

/** True when pasted HTML is actually richer than its plain-text counterpart. */
function isRichHtml(html: string): boolean {
  if (!html) return false
  const probe = html.toLowerCase()
  if (!/<(p|h[1-6]|ul|ol|li|blockquote|pre|table|strong|em|b|i|a|img|code)\b/.test(probe)) return false
  return true
}

function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim())
}

/**
 * Smart paste:
 *  - pasting a URL over a selection turns it into a Markdown link,
 *  - pasting rich HTML converts it to Markdown instead of dumping markup,
 *  - plain text paste is left completely alone.
 */
export const smartPasteExtension = EditorView.domEventHandlers({
  paste(event, view) {
    if (document.documentElement.classList.contains('no-smart-paste')) return false
    const data = event.clipboardData
    if (!data) return false
    if (data.files && data.files.length > 0) return false // image paste handled elsewhere
    const text = data.getData('text/plain')
    const html = data.getData('text/html')
    const sel = view.state.selection.main

    if (sel.from !== sel.to && looksLikeUrl(text)) {
      const selected = view.state.sliceDoc(sel.from, sel.to)
      const insert = `[${selected}](${text.trim()})`
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + insert.length },
        userEvent: 'input.paste',
        scrollIntoView: true
      })
      event.preventDefault()
      return true
    }

    if (isRichHtml(html)) {
      const md = htmlToMarkdown(html)
      if (md && md !== text.trim()) {
        // Single-line rich content collapses to inline markdown.
        const insert = md
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert },
          selection: { anchor: sel.from + insert.length },
          userEvent: 'input.paste',
          scrollIntoView: true
        })
        event.preventDefault()
        return true
      }
    }
    return false
  }
})