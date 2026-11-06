import type { DirEntry, Prefs, RecentFile } from '../../shared/types'
import type { OutlineItem } from '../../shared/markdown'

const overlay = (): HTMLElement => document.getElementById('overlay') as HTMLElement

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastTimer: number | null = null

export function toast(message: string, ms = 2200): void {
  const el = document.getElementById('toast') as HTMLElement
  el.textContent = message
  el.classList.remove('hidden')
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), ms)
}

// ---------------------------------------------------------------------------
// Banner (external-change prompts etc.)
// ---------------------------------------------------------------------------

export function showBanner(
  message: string,
  actions: Array<{ label: string; primary?: boolean; onClick: () => void }>
): void {
  const el = document.getElementById('banner') as HTMLElement
  el.textContent = ''
  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  el.appendChild(spacer)
  for (const action of actions) {
    const btn = document.createElement('button')
    btn.className = action.primary ? 'text-btn primary' : 'text-btn'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      hideBanner()
      action.onClick()
    })
    el.appendChild(btn)
  }
  el.classList.remove('hidden')
}

export function hideBanner(): void {
  const el = document.getElementById('banner') as HTMLElement
  el.classList.add('hidden')
  el.textContent = ''
}

// ---------------------------------------------------------------------------
// Dialog plumbing
// ---------------------------------------------------------------------------

export interface DialogHandle {
  close: () => void
  root: HTMLElement
}

export function openDialog(title: string, build: (body: HTMLElement, close: () => void) => HTMLElement[] | void, actions: Array<{ label: string; primary?: boolean; onClick: (close: () => void) => void }> = []): DialogHandle {
  const host = overlay()
  host.textContent = ''
  const dialog = document.createElement('div')
  dialog.className = 'dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', title)
  const h = document.createElement('h2')
  h.textContent = title
  dialog.appendChild(h)
  const body = document.createElement('div')
  body.className = 'dialog-body'
  dialog.appendChild(body)
  const close = (): void => {
    host.classList.add('hidden')
    host.textContent = ''
    document.removeEventListener('keydown', onKey, true)
  }
  const extra = build(body, close)
  if (extra && extra.length) extra.forEach((n) => body.appendChild(n))
  if (actions.length) {
    const footer = document.createElement('div')
    footer.className = 'actions'
    for (const a of actions) {
      const btn = document.createElement('button')
      btn.className = a.primary ? 'btn primary' : 'btn'
      btn.textContent = a.label
      btn.addEventListener('click', () => a.onClick(close))
      footer.appendChild(btn)
    }
    dialog.appendChild(footer)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey, true)
  host.appendChild(dialog)
  host.classList.remove('hidden')
  host.onmousedown = (e) => {
    if (e.target === host) close()
  }
  return { close, root: dialog }
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'row'
  const l = document.createElement('label')
  l.textContent = label
  if (hint) l.title = hint
  div.appendChild(l)
  div.appendChild(control)
  return div
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export function renderOutline(items: OutlineItem[], onPick: (item: OutlineItem) => void, activeLine: number): void {
  const list = document.getElementById('outline-list') as HTMLElement
  list.textContent = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-item l3'
    empty.textContent = 'No headings'
    list.appendChild(empty)
    return
  }
  let activeEl: HTMLElement | null = null
  let bestLine = -1
  for (const item of items) {
    const el = document.createElement('div')
    el.className = `outline-item l${Math.min(6, item.level)}`
    el.textContent = item.text || '(empty heading)'
    el.title = item.text
    el.setAttribute('role', 'treeitem')
    el.addEventListener('click', () => onPick(item))
    list.appendChild(el)
    if (item.line <= activeLine && item.line > bestLine) {
      bestLine = item.line
      activeEl = el
    }
  }
  if (activeEl) {
    activeEl.classList.add('active')
    activeEl.scrollIntoView({ block: 'nearest' })
  }
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export interface FileTreeHooks {
  list: (dir: string) => Promise<DirEntry[]>
  onOpen: (path: string) => void
  isMarkdown: (name: string) => boolean
}

export class FileTree {
  private root: string | null = null
  private expanded = new Set<string>()
  private selected: string | null = null

  constructor(private el: HTMLElement, private hooks: FileTreeHooks) {}

  async setRoot(dir: string | null): Promise<void> {
    this.root = dir
    this.expanded = dir ? new Set([dir]) : new Set()
    const label = document.getElementById('sidebar-folder') as HTMLElement
    label.textContent = dir ? (dir.split('/').pop() || dir) : 'No folder'
    label.title = dir ?? ''
    await this.refresh()
  }

  select(path: string): void {
    this.selected = path
    this.el.querySelectorAll('.tree-row.selected').forEach((n) => n.classList.remove('selected'))
    const target = this.el.querySelector(`[data-path="${CSS.escape(path)}"]`)
    if (target) target.classList.add('selected')
  }

  async refresh(): Promise<void> {
    this.el.textContent = ''
    if (!this.root) return
    const container = document.createElement('div')
    this.el.appendChild(container)
    await this.renderDir(this.root, container, 0)
  }

  private async renderDir(dir: string, container: HTMLElement, depth: number): Promise<void> {
    let entries: DirEntry[]
    try {
      entries = await this.hooks.list(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'tree-row'
      row.dataset.path = entry.path
      row.setAttribute('role', 'treeitem')
      row.setAttribute('tabindex', '0')
      row.style.paddingLeft = `${6 + depth * 12}px`
      const caret = document.createElement('span')
      caret.className = 'tree-caret'
      caret.textContent = entry.isDir ? (this.expanded.has(entry.path) ? '▾' : '▸') : ''
      const name = document.createElement('span')
      name.className = 'tree-name'
      name.textContent = entry.isDir ? entry.name : entry.name
      row.append(caret, name)
      container.appendChild(row)

      if (entry.isDir) {
        const childBox = document.createElement('div')
        childBox.className = 'tree-children'
        container.appendChild(childBox)
        if (this.expanded.has(entry.path)) await this.renderDir(entry.path, childBox, depth + 1)
        row.addEventListener('click', () => {
          if (this.expanded.has(entry.path)) this.expanded.delete(entry.path)
          else this.expanded.add(entry.path)
          void this.refresh()
        })
      } else if (this.hooks.isMarkdown(entry.name)) {
        row.addEventListener('click', () => {
          this.select(entry.path)
          this.hooks.onOpen(entry.path)
        })
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.hooks.onOpen(entry.path)
        })
      } else {
        row.style.opacity = '0.5'
        row.title = 'Not a markdown file'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Quick open
// ---------------------------------------------------------------------------

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let streak = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++
      streak++
      score += 1 + streak * 2
      if (i === 0 || t[i - 1] === '/' || t[i - 1] === '-' || t[i - 1] === '_') score += 6
    } else {
      streak = 0
    }
  }
  if (qi < q.length) return -1
  return score - t.length * 0.05
}

export function quickOpenDialog(files: string[], onPick: (path: string) => void): void {
  const host = overlay()
  host.textContent = ''
  const dialog = document.createElement('div')
  dialog.className = 'dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', 'Quick open')
  const input = document.createElement('input')
  input.className = 'quick-input'
  input.type = 'text'
  input.placeholder = 'Search files by name…'
  input.setAttribute('aria-label', 'Search files')
  const results = document.createElement('div')
  results.className = 'quick-results'
  results.setAttribute('role', 'listbox')
  dialog.append(input, results)
  host.appendChild(dialog)
  host.classList.remove('hidden')

  let filtered: string[] = files.slice(0, 200)
  let active = 0

  const close = (): void => {
    host.classList.add('hidden')
    host.textContent = ''
  }

  const render = (): void => {
    results.textContent = ''
    if (!filtered.length) {
      const empty = document.createElement('div')
      empty.className = 'quick-item'
      empty.textContent = files.length ? 'No match' : 'Open a folder first (⌘⇧⌥O)'
      results.appendChild(empty)
      return
    }
    filtered.slice(0, 60).forEach((file, i) => {
      const el = document.createElement('div')
      el.className = `quick-item${i === active ? ' active' : ''}`
      el.setAttribute('role', 'option')
      const name = document.createElement('span')
      name.textContent = file.split('/').pop() || file
      const path = document.createElement('span')
      path.className = 'path'
      path.textContent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
      el.append(name, path)
      el.addEventListener('mouseenter', () => {
        active = i
        render()
      })
      el.addEventListener('click', () => {
        close()
        onPick(file)
      })
      results.appendChild(el)
    })
  }

  const filter = (): void => {
    const q = input.value.trim()
    if (!q) {
      filtered = files.slice(0, 200)
    } else {
      filtered = files
        .map((f) => ({ f, s: fuzzyScore(q, f) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.f)
    }
    active = 0
    render()
  }

  input.addEventListener('input', filter)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = Math.min(active + 1, Math.min(filtered.length, 60) - 1)
      render()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(active - 1, 0)
      render()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = filtered[active]
      if (pick) {
        close()
        onPick(pick)
      }
    }
  })
  render()
  input.focus()
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

export function recentsDialog(items: RecentFile[], onPick: (path: string) => void): void {
  openDialog('Recent Files', (body) => {
    const list = document.createElement('div')
    list.className = 'dialog-list'
    if (!items.length) {
      const p = document.createElement('p')
      p.textContent = 'No recent files yet.'
      body.appendChild(p)
      return
    }
    for (const item of items) {
      const el = document.createElement('div')
      el.className = 'item'
      el.textContent = item.name
      const sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = item.path.replace(/^\/Users\/[^/]+/, '~')
      el.appendChild(sub)
      el.addEventListener('click', () => {
        overlay().classList.add('hidden')
        overlay().textContent = ''
        onPick(item.path)
      })
      list.appendChild(el)
    }
    body.appendChild(list)
  }, [{ label: 'Close', onClick: (close) => close() }])
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function prefsDialog(prefs: Prefs, onChange: (patch: Partial<Prefs>) => void): void {
  openDialog('Preferences', (body) => {
    const theme = document.createElement('select')
    for (const [value, label] of [
      ['system', 'Follow system'],
      ['light', 'Light'],
      ['dark', 'Dark']
    ] as const) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      if (prefs.theme === value) opt.selected = true
      theme.appendChild(opt)
    }
    theme.addEventListener('change', () => onChange({ theme: theme.value as Prefs['theme'] }))
    body.appendChild(row('Theme', theme))

    const font = document.createElement('input')
    font.type = 'text'
    font.value = prefs.fontFamily
    font.placeholder = 'System default'
    font.addEventListener('change', () => onChange({ fontFamily: font.value.trim() }))
    body.appendChild(row('Editor font', font, 'Any installed font family name'))

    const size = document.createElement('input')
    size.type = 'number'
    size.min = '12'
    size.max = '28'
    size.value = String(prefs.fontSize)
    size.addEventListener('change', () => onChange({ fontSize: Number(size.value) || 17 }))
    body.appendChild(row('Font size (px)', size))

    const width = document.createElement('input')
    width.type = 'number'
    width.min = '480'
    width.max = '1200'
    width.step = '20'
    width.value = String(prefs.editorWidth)
    width.addEventListener('change', () => onChange({ editorWidth: Number(width.value) || 720 }))
    body.appendChild(row('Editor width (px)', width))

    const lineHeight = document.createElement('input')
    lineHeight.type = 'range'
    lineHeight.min = '1.3'
    lineHeight.max = '2.2'
    lineHeight.step = '0.05'
    lineHeight.value = String(prefs.lineHeight)
    lineHeight.addEventListener('input', () => onChange({ lineHeight: Number(lineHeight.value) }))
    body.appendChild(row('Line height', lineHeight))

    const mkToggle = (label: string, key: keyof Prefs, hint?: string): void => {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = Boolean(prefs[key])
      input.addEventListener('change', () => onChange({ [key]: input.checked } as Partial<Prefs>))
      const wrap = document.createElement('input')
      wrap.type = 'checkbox'
      wrap.checked = Boolean(prefs[key])
      wrap.addEventListener('change', () => onChange({ [key]: wrap.checked } as Partial<Prefs>))
      body.appendChild(row(label, wrap, hint))
    }
    mkToggle('Autosave', 'autoSave', 'Write to disk shortly after you stop typing')
    mkToggle('Auto-pair brackets and markers', 'autoPair')
    mkToggle('Smart paste (HTML → Markdown)', 'smartPaste')
    mkToggle('Spell check', 'spellCheck')
  }, [{ label: 'Done', primary: true, onClick: (close) => close() }])
}

// ---------------------------------------------------------------------------
// About / shortcuts
// ---------------------------------------------------------------------------

export function aboutDialog(info: { version: string; electron: string; chrome: string; node: string }): void {
  openDialog('About Typing', (body) => {
    const p = document.createElement('p')
    p.textContent = `Typing ${info.version} — a local-first markdown editor.`
    const p2 = document.createElement('p')
    p2.textContent = 'Written from scratch. No accounts, no telemetry, no network access.'
    const p3 = document.createElement('p')
    p3.textContent = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`
    body.append(p, p2, p3)
  }, [{ label: 'Close', primary: true, onClick: (close) => close() }])
}

export function shortcutsDialog(): void {
  const rows: Array<[string, string]> = [
    ['New / Open / Save', '⌘N · ⌘O · ⌘S'],
    ['Save As', '⇧⌘S'],
    ['Source code mode', '⌘/'],
    ['Quick open', '⇧⌘O'],
    ['Open folder', '⇧⌥⌘O'],
    ['Find / Replace', '⌘F · ⌥⌘F'],
    ['Bold / Italic / Code', '⌘B · ⌘I · ⌘E'],
    ['Link / Image', '⌘K · ⇧⌘I'],
    ['Headings 1–6 / paragraph', '⌘1…⌘6 · ⌘0'],
    ['Quote / Code block', '⌥⌘Q · ⌥⌘C'],
    ['Table / Math block', '⌥⌘T · ⌥⌘M'],
    ['Lists: bullet / ordered / task', '⌥⌘U · ⌥⌘O · ⌥⌘X'],
    ['Outline / Sidebar', '⇧⌘1 · ⇧⌘2'],
    ['Focus / Typewriter mode', 'F8 · F9'],
    ['Export HTML / PDF', '⇧⌘E · ⌥⌘P'],
    ['Preferences', '⌘,']
  ]
  openDialog('Keyboard Shortcuts', (body) => {
    const table = document.createElement('table')
    table.className = 'shortcut-table'
    for (const [label, keys] of rows) {
      const tr = document.createElement('tr')
      const td1 = document.createElement('td')
      td1.textContent = label
      const td2 = document.createElement('td')
      td2.textContent = keys
      tr.append(td1, td2)
      table.appendChild(tr)
    }
    body.appendChild(table)
  }, [{ label: 'Close', primary: true, onClick: (close) => close() }])
}

export function confirmDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const handle = openDialog(title, (body) => {
      const p = document.createElement('p')
      p.textContent = message
      body.appendChild(p)
    }, [
      {
        label: 'Cancel',
        onClick: (close) => {
          settled = true
          close()
          resolve(false)
        }
      },
      {
        label: confirmLabel,
        primary: true,
        onClick: (close) => {
          settled = true
          close()
          resolve(true)
        }
      }
    ])
    const observer = new MutationObserver(() => {
      if (!document.body.contains(handle.root) && !settled) resolve(false)
    })
    observer.observe(overlay(), { childList: true })
  })
}