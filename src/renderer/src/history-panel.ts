import type { EncodableDoc } from '../../shared/doc'
import type { HistoryListing, HistoryConfig } from '../../shared/history'
import { lineDiff } from './history-diff'
import { openDialog, confirmDialog, toast, type DialogHandle } from './ui'

type Preview = EncodableDoc & { validUtf8: boolean; size: number }
export interface HistoryContext { key: string; path: string | null; format: EncodableDoc; unsafe: boolean }
interface Hooks {
  call: (method: string, ...args: unknown[]) => Promise<any>
  context: () => HistoryContext
  restore: (id: string, key: string) => Promise<boolean>
  copy: (id: string, key: string) => Promise<boolean>
}
const size = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`
function relativeTime(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`
  return `${Math.floor(seconds / 86400)} days ago`
}

/** One modal sheet, always scoped to the active tab. Async reads carry a revision. */
export class HistoryPanel {
  private dialog?: DialogHandle
  private revision = 0
  private selected?: Preview
  private selectedId = ''
  private key = ''
  private diffTimer = 0
  constructor(private readonly hooks: Hooks) {}

  private element<T extends HTMLElement>(id: string): T { return this.dialog!.root.querySelector<T>(`#${id}`)! }

  close(): void {
    this.revision++
    window.clearTimeout(this.diffTimer)
    this.dialog?.close(); this.dialog = undefined; this.selected = undefined
  }

  async open(): Promise<void> {
    if (this.dialog?.root.isConnected) { this.close(); return }
    this.dialog = openDialog('Local History', (body, close) => {
      body.innerHTML = `
        <p id="history-path" class="history-path"></p>
        <p id="history-notice" role="status">Loading local history…</p>
        <div class="history-controls">
          <label><input id="history-enabled" type="checkbox"> Enable local history</label>
          <label><input id="history-document-enabled" type="checkbox"> History for this document</label>
        </div>
        <div class="history-layout">
          <div class="history-versions"><label for="history-list">Snapshots (newest first)</label><select id="history-list" size="9" aria-label="Snapshots"></select></div>
          <div class="history-comparison">
            <label for="history-preview">Read-only snapshot preview</label>
            <textarea id="history-preview" readonly spellcheck="false" aria-label="Snapshot preview"></textarea>
            <p id="history-format" class="history-hint"></p>
            <label for="history-diff">Line diff · snapshot → current editor (− removed, + added)</label>
            <pre id="history-diff" tabindex="0" role="region" aria-label="Line diff"></pre>
            <p id="history-diff-note" class="history-hint"></p>
          </div>
        </div>
        <div class="actions history-snapshot-actions">
          <button id="history-copy" class="btn">Copy snapshot to a new tab</button>
          <button id="history-restore" class="btn primary">Restore</button>
        </div>
        <details class="history-settings"><summary>Storage, privacy and limits</summary>
          <p id="history-location" class="history-path"></p>
          <p>Entirely offline. History contains private copies of your writing; it is not encrypted. Nothing is saved next to your documents. Turning history off does not delete existing snapshots.</p>
          <p>Ordinary saves: at most one snapshot per document per minute; identical newest content is skipped. Reload, Revert and Restore also preserve the text they are about to replace, without the time throttle. Files over 5 MiB are excluded.</p>
          <div class="history-limits">
            <label>Snapshots per document <input id="history-count" type="number" min="1" max="10000"></label>
            <label>Age in days <input id="history-age" type="number" min="1" max="36500"></label>
            <label>Total disk cap (MiB) <input id="history-cap" type="number" min="1" max="10000"></label>
            <button id="history-apply" class="btn">Apply limits</button>
          </div>
          <p id="history-usage" class="history-hint"></p>
          <p>Oldest snapshots are removed first. The newest snapshot of every document is always kept, even when that exceeds the cap. Renamed or moved files start a separate history; symlink aliases share their canonical path's history.</p>
          <div class="actions"><button id="history-clear-document" class="btn">Clear history for this document</button><button id="history-clear-all" class="btn">Clear all history</button></div>
        </details>`
      // Escape and the standard Close button go through this wrapper, so stale
      // pending snapshot reads cannot fill a subsequently opened sheet.
      body.parentElement!.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return
        const controls = Array.from(body.parentElement!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, summary, [tabindex="0"]')).filter(el => el.getClientRects().length > 0)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      })
      void close
    }, [{ label: 'Close', onClick: () => this.close() }])
    this.dialog.root.classList.add('history-sheet')
    const on = (id: string, event: string, fn: () => void): void => { this.element(id).addEventListener(event, fn) }
    on('history-list', 'change', () => { void this.select(this.element<HTMLSelectElement>('history-list').value) })
    on('history-enabled', 'change', () => { void this.configure({ enabled: this.element<HTMLInputElement>('history-enabled').checked }) })
    on('history-document-enabled', 'change', () => {
      const path = this.hooks.context().path
      if (path) void this.hooks.call('history.disable', path, !this.element<HTMLInputElement>('history-document-enabled').checked).then(() => this.refresh())
    })
    on('history-apply', 'click', () => {
      const count = this.element<HTMLInputElement>('history-count'), age = this.element<HTMLInputElement>('history-age'), cap = this.element<HTMLInputElement>('history-cap')
      if (![count, age, cap].every(input => input.reportValidity())) return
      void this.configure({ maxCount: Number(count.value), maxAgeDays: Number(age.value), maxBytes: Number(cap.value) * 1024 * 1024 })
    })
    on('history-clear-document', 'click', () => { void this.clear(false) })
    on('history-clear-all', 'click', () => { void this.clear(true) })
    on('history-restore', 'click', () => {
      const id = this.selectedId, key = this.key
      this.close()
      void this.hooks.restore(id, key)
    })
    on('history-copy', 'click', () => {
      const id = this.selectedId, key = this.key
      this.close()
      void this.hooks.copy(id, key)
    })
    await this.refresh()
    if (this.dialog?.root.isConnected) this.element<HTMLSelectElement>('history-list')?.focus()
  }

  async refresh(): Promise<void> {
    if (!this.dialog?.root.isConnected) return
    const revision = ++this.revision
    const context = this.hooks.context()
    const previousId = this.key === context.key ? this.selectedId : ''
    this.key = context.key
    this.selected = undefined
    this.element('history-path').textContent = context.path ?? 'Untitled — save this document to start its history.'
    this.element<HTMLButtonElement>('history-restore').disabled = true
    this.element<HTMLButtonElement>('history-copy').disabled = true
    const listing = await this.hooks.call('history.list', context.path) as HistoryListing
    if (revision !== this.revision || !this.dialog?.root.isConnected) return
    const enabled = this.element<HTMLInputElement>('history-enabled')
    enabled.checked = listing.config.enabled
    const documentEnabled = this.element<HTMLInputElement>('history-document-enabled')
    documentEnabled.checked = !listing.disabled; documentEnabled.disabled = !context.path
    this.element<HTMLButtonElement>('history-clear-document').disabled = !context.path || !listing.snapshots.length
    this.element('history-notice').textContent = listing.error ?? (context.unsafe
      ? 'Restore is unavailable while this file has an external change, is deleted, or contains invalid UTF-8. Copy a snapshot to a new tab instead.'
      : !listing.config.enabled ? 'History is switched off globally. Existing snapshots remain available.'
      : listing.disabled ? 'History is switched off for this document. Existing snapshots remain available.'
      : new TextEncoder().encode(context.format.text).length > listing.maxFileBytes ? 'This document exceeds 5 MiB and is excluded from snapshots.'
      : listing.snapshots.length ? `${listing.snapshots.length} snapshots. Restore edits the current tab; normal save and undo still apply.`
      : 'No snapshots yet. Save this document to create one.')
    this.element('history-location').textContent = `History lives only in this app's local user-data directory: ${listing.directory}`
    this.element('history-usage').textContent = `${size(listing.usedBytes)} stored · ${listing.overBudget ? 'Cap exceeded: newest snapshots are protected.' : 'Compressed, shared content chunks.'}`
    this.element<HTMLInputElement>('history-count').value = String(listing.config.maxCount)
    this.element<HTMLInputElement>('history-age').value = String(listing.config.maxAgeDays)
    this.element<HTMLInputElement>('history-cap').value = String(listing.config.maxBytes / 1024 / 1024)
    const list = this.element<HTMLSelectElement>('history-list')
    list.replaceChildren(...listing.snapshots.map(snapshot => {
      const option = document.createElement('option')
      option.value = snapshot.id
      option.textContent = `${relativeTime(snapshot.time)} · ${new Date(snapshot.time).toLocaleString()} · ${size(snapshot.size)} · ${snapshot.reason}`
      option.title = `${new Date(snapshot.time).toISOString()} · ${snapshot.size} bytes`
      return option
    }))
    list.disabled = !listing.snapshots.length
    const picked = listing.snapshots.find(s => s.id === previousId) ?? listing.snapshots[0]
    this.selectedId = picked?.id ?? ''
    this.element<HTMLTextAreaElement>('history-preview').value = ''
    this.element('history-diff').textContent = ''
    this.element('history-format').textContent = ''
    this.element('history-diff-note').textContent = ''
    if (picked) { list.value = picked.id; await this.select(picked.id) }
  }

  currentChanged(): void {
    if (!this.dialog?.root.isConnected || !this.selected) return
    window.clearTimeout(this.diffTimer)
    this.diffTimer = window.setTimeout(() => this.renderDiff(), 120)
  }

  private async select(id: string): Promise<void> {
    const revision = ++this.revision
    this.selectedId = id
    this.selected = undefined
    this.element<HTMLButtonElement>('history-restore').disabled = true
    this.element<HTMLButtonElement>('history-copy').disabled = true
    const context = this.hooks.context()
    const snapshot = await this.hooks.call('history.read', context.path, id) as Preview | null
    if (revision !== this.revision || !this.dialog?.root.isConnected) return
    if (!snapshot) { this.element('history-notice').textContent = 'Snapshot is unavailable (it may have been pruned).'; return }
    this.selected = snapshot
    this.element<HTMLTextAreaElement>('history-preview').value = snapshot.text
    this.element('history-format').textContent = `${snapshot.size} bytes · ${snapshot.bom ? 'UTF-8 BOM' : 'no BOM'} · ${new Set(snapshot.lineEndings).size > 1 ? 'mixed line endings' : snapshot.eol === '\r\n' ? 'CRLF' : 'LF'}${snapshot.validUtf8 ? '' : ' · invalid UTF-8 (decoded preview only)'}`
    this.element<HTMLButtonElement>('history-restore').disabled = context.unsafe || !snapshot.validUtf8
    this.element<HTMLButtonElement>('history-copy').disabled = false
    this.renderDiff()
  }

  private renderDiff(): void {
    if (!this.selected || !this.dialog?.root.isConnected) return
    const current = this.hooks.context().format
    const result = lineDiff(this.selected.text, current.text)
    const diff = this.element('history-diff')
    diff.textContent = ''
    let budget = 1000, truncated = false
    for (const chunk of result.chunks) {
      const lines = chunk.text.split('\n')
      if (lines.at(-1) === '') lines.pop()
      const span = document.createElement('span')
      span.className = `history-diff-${chunk.type}`
      if (chunk.type === 'equal' && lines.length > 8) span.textContent = `  ${lines.slice(0, 3).join('\n  ')}\n  … ${lines.length - 6} unchanged lines …\n  ${lines.slice(-3).join('\n  ')}\n`
      else {
        const visible = lines.slice(0, Math.max(0, budget))
        const prefix = chunk.type === 'add' ? '+ ' : chunk.type === 'remove' ? '− ' : '  '
        const text = visible.map(line => prefix + line).join('\n')
        span.textContent = text.slice(0, 200_000) + (text ? '\n' : '')
        budget -= visible.length
        if (visible.length < lines.length || text.length > 200_000) truncated = true
      }
      diff.append(span)
    }
    const equal = this.selected.text === current.text
    this.element('history-diff-note').textContent = `${equal ? 'No text changes. ' : ''}${this.selected.bom !== current.bom || this.selected.lineEndings !== current.lineEndings ? 'BOM or line endings also differ; Restore preserves them exactly. ' : ''}${result.coarse ? 'Large changed block shown as a non-minimal line replacement. ' : ''}${truncated ? 'Diff display limited to 1,000 changed/context lines and 200,000 characters per block; the preview and restored snapshot are complete.' : ''}`
  }

  private async configure(patch: Partial<HistoryConfig>): Promise<void> {
    if (!(await this.hooks.call('history.configure', patch))) toast('Could not update history settings. Your document can still be saved.')
    await this.refresh()
  }

  private async clear(all: boolean): Promise<void> {
    const context = this.hooks.context()
    this.close()
    const accepted = await confirmDialog(all ? 'Clear all history' : 'Clear document history', all ? 'Permanently delete all local snapshots? Your document files and recovery drafts will not be changed.' : `Permanently delete local snapshots for “${context.path}”? The document file will not be changed.`, 'Clear history')
    if (accepted && !(await this.hooks.call('history.clear', all ? null : context.path))) toast('Could not clear local history.')
    await this.open()
  }
}
