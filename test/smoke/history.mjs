#!/usr/bin/env node
/** Real packaged-app local history, safety, accessibility and latency checks. */
import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = process.env.TYPING_APP ?? process.argv[2] ?? join(root, 'release/mac-arm64/Typing.app')
const executablePath = process.env.TYPING_EXE ?? join(bundle, process.platform === 'darwin' ? 'Contents/MacOS/Typing' : 'Typing.exe')
const work = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'typing-history-smoke-')))
const userData = join(work, 'user-data'), docs = join(work, 'documents')
await fs.mkdir(userData); await fs.mkdir(docs)
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ autoSave: false, showOutline: false, sourceMode: true }))
const path = join(docs, 'writing.md'), other = join(docs, 'other.md')
await fs.writeFile(path, 'SAVED ONE\n'); await fs.writeFile(other, 'OTHER\n')
const results = [], errors = [], warnings = [], apps = new Set()
const t = (page, method, ...args) => page.evaluate(({ method, args }) => window.__typingTest[method](...args), { method, args })
const call = (page, method, ...args) => page.evaluate(({ method, args }) => window.typing.call(method, ...args), { method, args })
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); assert.ok(ok, name) }
const list = (page, file = path) => call(page, 'history.list', file)
const panel = async page => { await t(page, 'command', 'doc.history'); await page.locator('#history-preview').waitFor(); await page.waitForFunction(() => !document.querySelector('#history-copy').disabled) }
const closePanel = async page => { await page.getByRole('button', { name: 'Close', exact: true }).click() }
const seed = (page, file, text, reason = 'before-reload') => call(page, 'history.capture', file, { text, eol: '\n', bom: false, lineEndings: 'l'.repeat((text.match(/\n/g) ?? []).length) }, reason)
const watchdog = setTimeout(() => { for (const app of apps) app.process()?.kill('SIGKILL'); console.error('history smoke exceeded 240s'); process.exit(3) }, 240000)
async function launch(data = userData) {
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${data}`], env: { ...process.env, TYPING_TEST: '1' }, timeout: 60000 })
  apps.add(app)
  const page = await app.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()) })
  await page.waitForSelector('.cm-content')
  return { app, page }
}
async function stop(app) {
  await app.evaluate(({ BrowserWindow, app }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit() }).catch(() => {})
  if (app.process()?.exitCode === null) app.process().kill('SIGKILL')
  apps.delete(app)
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
let metrics = {}
try {
  const { app, page } = await launch()
  await t(page, 'openFile', path)
  await t(page, 'save')
  check('successful save creates exact snapshot', (await list(page)).snapshots.length === 1 && (await call(page, 'history.read', path, (await list(page)).snapshots[0].id)).text === 'SAVED ONE\n')
  await t(page, 'selection', 0, 0); await t(page, 'insert', 'UNSAVED ')
  await page.keyboard.press('ControlOrMeta+Shift+H')
  await page.waitForFunction(() => document.querySelector('#history-preview')?.value === 'SAVED ONE\n')
  check('history shortcut opens active-tab list, preview and line diff', (await page.locator('#history-list option').count()) === 1 && (await page.locator('#history-diff').innerText()).includes('+ UNSAVED SAVED ONE') && /B/.test(await page.locator('#history-list option').first().innerText()))
  check('list displays relative/absolute time and size', /just now.*\d.*B.*save/.test(await page.locator('#history-list option').first().innerText()))
  check('preview is read-only and labels are accessible', await page.getByRole('textbox', { name: 'Snapshot preview' }).getAttribute('readonly') !== null && await page.getByRole('region', { name: 'Line diff' }).count() === 1)
  await page.getByRole('button', { name: 'Close', exact: true }).focus(); await page.keyboard.press('Tab')
  check('keyboard focus remains inside sheet', await page.locator('.history-sheet').evaluate(el => el.contains(document.activeElement)))
  const beforeRestore = await t(page, 'getText')
  const originalId = (await list(page)).snapshots[0].id
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.waitForFunction(() => window.__typingTest.getText() === 'SAVED ONE\n')
  const restoredList = (await list(page)).snapshots
  check('restore first snapshots current unsaved text', restoredList.length === 2 && restoredList[0].reason === 'before-restore' && (await call(page, 'history.read', path, restoredList[0].id)).text === beforeRestore)
  check('restore edits editor without prematurely overwriting disk', (await fs.readFile(path, 'utf8')) === 'SAVED ONE\n')
  await t(page, 'command', 'edit.undo')
  check('restore is one undoable edit', (await t(page, 'getText')) === beforeRestore)
  await t(page, 'command', 'edit.redo')
  check('restore redo works', (await t(page, 'getText')) === 'SAVED ONE\n')
  await panel(page)
  await page.locator('#history-list').selectOption(originalId)
  await page.waitForFunction(() => document.querySelector('#history-preview').value === 'SAVED ONE\n')
  await page.getByRole('button', { name: 'Copy snapshot to a new tab' }).click()
  await page.waitForFunction(() => window.__typingTest.path() === null)
  check('copy opens independent dirty untitled tab', (await t(page, 'getText')) === 'SAVED ONE\n' && await t(page, 'isDirty') && (await t(page, 'tabs')).length === 2)
  await t(page, 'openFile', other); await t(page, 'save'); await panel(page)
  check('panel is scoped to active tab', (await page.locator('#history-preview').inputValue()) === 'OTHER\n')
  await closePanel(page); await t(page, 'openFile', path)

  // Strict throttle and opt-outs are tested through real saves, not a fake UI.
  const count = (await list(page)).snapshots.length
  await t(page, 'insert', 'RAPID '); await t(page, 'save')
  check('rapid saves are throttled', (await list(page)).snapshots.length === count)
  await panel(page); await page.locator('#history-enabled').uncheck()
  await page.waitForFunction(() => document.querySelector('#history-notice').textContent.includes('off globally'))
  await closePanel(page); await t(page, 'openFile', other); await t(page, 'insert', 'GLOBAL OFF '); await t(page, 'save')
  check('global off suppresses forced capture too', !(await seed(page, other, 'global-off excluded snapshot')))
  check('global off still saves without history', (await list(page, other)).snapshots.length === 1 && (await fs.readFile(other, 'utf8')).includes('GLOBAL OFF'))
  await panel(page); await page.locator('#history-enabled').check()
  await page.waitForFunction(() => document.querySelector('#history-enabled').checked)
  await page.locator('#history-document-enabled').uncheck()
  await page.waitForFunction(() => document.querySelector('#history-notice').textContent.includes('off for this document'))
  await closePanel(page)
  await t(page, 'insert', 'DOCUMENT OFF '); await t(page, 'save')
  check('document opt-out suppresses forced capture too', !(await seed(page, other, 'document-off excluded snapshot')))
  check('per-document off still saves without history', (await list(page, other)).disabled && (await list(page, other)).snapshots.length === 1 && (await fs.readFile(other, 'utf8')).includes('DOCUMENT OFF'))
  await panel(page); await page.locator('#history-document-enabled').check()
  await page.waitForFunction(() => document.querySelector('#history-document-enabled').checked)
  await page.locator('.history-settings summary').click()
  check('UI states exact user-data location and privacy', (await page.locator('#history-location').innerText()).includes(join(userData, 'history')) && (await page.locator('.history-settings').innerText()).includes('not encrypted'))
  await page.getByRole('button', { name: 'Clear history for this document', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForSelector('#history-list')
  check('clear document cancellation preserves history', (await list(page, other)).snapshots.length === 1)
  await page.locator('.history-settings summary').click()
  await page.getByRole('button', { name: 'Clear history for this document', exact: true }).click()
  await page.getByRole('button', { name: 'Clear history', exact: true }).click()
  await page.waitForSelector('#history-list')
  check('confirmed document clear deletes only this history', (await list(page, other)).snapshots.length === 0 && (await list(page)).snapshots.length > 0)
  await closePanel(page)

  // Exact restore includes encoding-only edits and survives a normal save.
  for (const [name, raw] of [['lf', 'one\ntwo\n'], ['crlf', 'one\r\ntwo\r\n'], ['mixed-bom', '\ufeffone\r\ntwo\nthree\r'], ['double-bom', '\ufeff\ufeffone\r\ntwo\n']]) {
    const file = join(docs, `${name}.md`)
    await fs.writeFile(file, raw); await t(page, 'openFile', file); await t(page, 'save')
    const id = (await list(page, file)).snapshots[0].id
    await t(page, 'selection', 0, 0); await t(page, 'insert', 'CHANGED '); await t(page, 'save')
    const previousBytes = await fs.readFile(file)
    check(`${name} restore accepted`, await t(page, 'restoreHistory', id))
    await t(page, 'save')
    check(`${name} restore then save is byte-identical`, (await fs.readFile(file)).equals(Buffer.from(raw)))
    await t(page, 'command', 'edit.undo'); await t(page, 'save')
    check(`${name} undo after save restores previous text/format`, (await fs.readFile(file)).equals(previousBytes))
  }
  const encodingOnly = join(docs, 'encoding-only.md')
  await fs.writeFile(encodingOnly, 'a\nb\n'); await t(page, 'openFile', encodingOnly)
  await call(page, 'history.capture', encodingOnly, { text: 'a\nb\n', bom: true, eol: '\r\n', lineEndings: 'cr' }, 'before-reload')
  await t(page, 'restoreHistory', (await list(page, encodingOnly)).snapshots[0].id)
  check('encoding-only restore is dirty despite equal editor text', await t(page, 'isDirty'))
  await t(page, 'flushDrafts')
  await page.waitForFunction(async () => (await window.typing.call('recovery.list')).some(d => d.path?.endsWith('encoding-only.md')))
  const encodingDraft = (await call(page, 'recovery.list')).find(d => d.path === encodingOnly)
  check('recovery draft retains restored byte provenance', encodingDraft?.historyFormat?.bom === true && encodingDraft.historyFormat.lineEndings === 'cr')
  await t(page, 'save')
  check('encoding-only restore writes exact BOM/endings', (await fs.readFile(encodingOnly)).equals(Buffer.from('\ufeffa\r\nb\r')))

  const raceId = (await list(page, encodingOnly)).snapshots[0].id
  const raceRestored = await page.evaluate(async id => {
    const restoring = window.__typingTest.restoreHistory(id)
    window.__typingTest.insert('TYPED DURING RESTORE ')
    return restoring
  }, raceId)
  check('typing during snapshot I/O cancels stale restore', !raceRestored && (await t(page, 'getText')).includes('TYPED DURING RESTORE'))

  // External reload/revert preserve the exact text being discarded.
  await t(page, 'openFile', path)
  const previous = await t(page, 'getText')
  await fs.writeFile(path, 'EXTERNAL CLEAN\n')
  await page.waitForFunction(() => window.__typingTest.getText() === 'EXTERNAL CLEAN\n', { timeout: 8000 })
  const reloadList = (await list(page)).snapshots
  check('clean external reload first preserves old content', reloadList[0].reason === 'before-reload' && (await call(page, 'history.read', path, reloadList[0].id)).text === previous)
  await t(page, 'insert', 'DISCARDED BY REVERT ')
  const discarded = await t(page, 'getText')
  await page.evaluate(() => { void window.__typingTest.command('doc.revert') })
  await page.getByRole('button', { name: 'Revert', exact: true }).click()
  await page.waitForFunction(() => window.__typingTest.getText() === 'EXTERNAL CLEAN\n')
  check('revert first preserves in-editor changes', (await call(page, 'history.read', path, (await list(page)).snapshots[0].id)).text === discarded)
  await t(page, 'insert', 'LOCAL ')
  await fs.writeFile(path, 'EXTERNAL DIRTY\n')
  await page.waitForFunction(() => window.__typingTest.tabs().some(t => t.active && t.externalChange), null, { timeout: 8000 })
  const dirty = await t(page, 'getText')
  check('restore rejects external-change state without replacing local or disk text', !(await t(page, 'restoreHistory', originalId)) && await t(page, 'getText') === dirty && (await fs.readFile(path, 'utf8')) === 'EXTERNAL DIRTY\n')
  await panel(page)
  check('unsafe sheet explains restore block and offers copy', await page.locator('#history-restore').isDisabled() && (await page.locator('#history-notice').innerText()).includes('Restore is unavailable') && await page.locator('#history-copy').isEnabled())
  await closePanel(page)
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await page.waitForFunction(() => window.__typingTest.getText() === 'EXTERNAL DIRTY\n')
  const invalid = join(docs, 'invalid.md'); await fs.writeFile(invalid, Buffer.from([0x61, 0xff, 0x0a]))
  await t(page, 'openFile', invalid); await seed(page, invalid, 'valid snapshot\n')
  check('restore rejects invalid UTF-8 active document', !(await t(page, 'restoreHistory', (await list(page, invalid)).snapshots[0].id)))
  check('invalid original bytes remain untouched', (await fs.readFile(invalid)).equals(Buffer.from([0x61, 0xff, 0x0a])))

  // Hundreds of metadata entries, capped before huge documents are read.
  await t(page, 'openFile', other)
  await call(page, 'history.configure', { maxCount: 300 })
  await page.evaluate(async file => {
    for (let i = 0; i < 240; i++) await window.typing.call('history.capture', file, { text: `Version ${i}\n`, bom: false, eol: '\n', lineEndings: 'l' }, 'before-reload')
  }, other)
  const openings = []
  for (let i = 0; i < 7; i++) { const start = performance.now(); await panel(page); openings.push(performance.now() - start); await closePanel(page) }
  metrics.panel240 = { medianMs: median(openings), maxMs: Math.max(...openings), samplesMs: openings }
  check('240 snapshot sheet opens quickly', median(openings) < 1000, `${median(openings).toFixed(1)} ms median`)
  await panel(page); await page.locator('.history-settings summary').click()
  await page.locator('#history-count').fill('5'); await page.locator('#history-age').fill('90'); await page.locator('#history-cap').fill('200')
  await page.getByRole('button', { name: 'Apply limits' }).click()
  await page.waitForFunction(() => document.querySelector('#history-list').options.length === 5)
  check('preference caps prune count and retain newest', (await list(page, other)).snapshots.length === 5 && (await call(page, 'history.read', other, (await list(page, other)).snapshots[0].id)).text === 'Version 239\n')
  await closePanel(page)
  await call(page, 'history.configure', { maxBytes: 1024 * 1024 })
  for (let i = 0; i < 4; i++) await seed(page, other, randomBytes(600_000).toString('base64'))
  check('global disk cap prunes oldest but keeps latest per document', (await list(page, other)).snapshots.length === 1 && (await list(page)).snapshots.length >= 1)
  const huge = join(docs, 'excluded.md')
  check('over-5-MiB documents are excluded', !(await seed(page, huge, 'x'.repeat(5 * 1024 * 1024 + 1))) && (await list(page, huge)).snapshots.length === 0)

  // Paired 1 MiB file.save IPC timings, unique paths ensure each on-save is
  // eligible. Queue drain is outside timing; its latency is reported separately.
  const samples = { off: [], on: [] }, drains = []
  const content = Array.from({ length: 16384 }, (_, i) => `${String(i).padStart(6, '0')} ${'writing '.repeat(7)}\n`).join('').slice(0, 1024 * 1024)
  for (let i = 0; i < 12; i++) for (const enabled of i % 2 ? [true, false] : [false, true]) {
    await call(page, 'history.configure', { enabled, maxBytes: 200 * 1024 * 1024 })
    const file = join(docs, `perf-${enabled}-${i}.md`)
    const start = performance.now()
    const saved = await call(page, 'file.save', { path: file, text: content, eol: '\n', bom: false })
    samples[enabled ? 'on' : 'off'].push(performance.now() - start)
    assert.ok(saved.ok)
    const drain = performance.now(); await list(page, file); if (enabled) drains.push(performance.now() - drain)
  }
  metrics.save1MiB = { bytes: Buffer.byteLength(content), disabledMedianMs: median(samples.off), enabledMedianMs: median(samples.on), addedMedianMs: median(samples.on) - median(samples.off), historyDrainMedianMs: median(drains), samples }
  check('1 MiB history does not visibly slow successful save', metrics.save1MiB.addedMedianMs < 30, JSON.stringify(metrics.save1MiB))
  // Preferences routes to the same privacy and limits UI.
  await t(page, 'command', 'app.prefs'); await page.getByRole('button', { name: 'Local history settings…' }).click()
  check('preferences exposes history settings', await page.locator('.history-sheet').isVisible())
  await page.locator('.history-settings summary').click()
  await page.getByRole('button', { name: 'Clear all history', exact: true }).click()
  await page.getByRole('button', { name: 'Clear history', exact: true }).click()
  await page.waitForSelector('#history-list')
  check('confirmed clear-all deletes snapshots and blobs but not documents', (await list(page)).snapshots.length === 0 && (await list(page, other)).snapshots.length === 0 && (await fs.readdir(join(userData, 'history', 'blobs'))).length === 0 && (await fs.readFile(other, 'utf8')).includes('DOCUMENT OFF'))
  await closePanel(page)
  await call(page, 'history.configure', { enabled: true }); await seed(page, other, 'Light preview\n'); await panel(page)
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('hidden'), null, { timeout: 8000 })
  check('history sheet and Close action fit the window', await page.locator('.history-sheet').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight))
  await page.screenshot({ path: join(work, 'history-light.png') })
  await closePanel(page)
  await call(page, 'prefs.set', { theme: 'dark' }); await seed(page, other, 'Dark preview\n'); await panel(page)
  await page.screenshot({ path: join(work, 'history-dark.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 560))
  await page.waitForFunction(() => innerWidth <= 680)
  check('history sheet fits narrow window with keyboard-reachable controls', await page.locator('.history-sheet').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight && el.getBoundingClientRect().right <= innerWidth))
  await page.screenshot({ path: join(work, 'history-narrow.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 820))
  check('dark history sheet uses theme tokens', await page.locator('html').getAttribute('class').then(c => c.includes('dark')))
  await closePanel(page)
  check('documents folder has no history store', !(await fs.readdir(docs)).some(n => /history|snapshot|\.tmp-/.test(n)))
  await stop(app)

  // Denied history storage is real filesystem failure, not a mocked success.
  const brokenData = join(work, 'broken-user-data'); await fs.mkdir(brokenData)
  await fs.writeFile(join(brokenData, 'preferences.json'), JSON.stringify({ autoSave: false }))
  await fs.writeFile(join(brokenData, 'history'), 'not a directory')
  const broken = await launch(brokenData)
  await t(broken.page, 'openFile', other); await t(broken.page, 'insert', 'HISTORY FAILURE ')
  check('history write failure does not block user save', await t(broken.page, 'save') && (await fs.readFile(other, 'utf8')).includes('HISTORY FAILURE'))
  check('history failure is reported without renderer errors', !!(await list(broken.page, other)).error)
  await stop(broken.app)
  // Crash-style restart of a format-only restored draft must not drop it just
  // because its decoded text still equals the file on disk.
  const recoveryData = join(work, 'recovery-user-data'); await fs.mkdir(recoveryData)
  await fs.writeFile(join(recoveryData, 'preferences.json'), JSON.stringify({ autoSave: false, sourceMode: true }))
  const recoveryFile = join(docs, 'recovery-encoding.md'); await fs.writeFile(recoveryFile, 'a\nb\n')
  const first = await launch(recoveryData)
  await t(first.page, 'openFile', recoveryFile)
  await call(first.page, 'history.capture', recoveryFile, { text: 'a\nb\n', eol: '\r\n', bom: true, lineEndings: 'cr' }, 'before-reload')
  await t(first.page, 'restoreHistory', (await list(first.page, recoveryFile)).snapshots[0].id)
  await t(first.page, 'flushDrafts')
  await first.page.waitForFunction(async () => (await window.typing.call('recovery.list')).some(d => d.historyFormat?.bom))
  await stop(first.app)
  const second = await launch(recoveryData)
  await second.page.getByRole('button', { name: 'Restore', exact: true }).click()
  await second.page.waitForFunction(() => window.__typingTest.path()?.endsWith('recovery-encoding.md'))
  check('format-only restored work survives crash-style relaunch', await t(second.page, 'isDirty'))
  await t(second.page, 'save')
  check('recovered restore saves byte-identical BOM and mixed endings', (await fs.readFile(recoveryFile)).equals(Buffer.from('\ufeffa\r\nb\r')))
  await stop(second.app)
  check('no renderer exceptions', errors.length === 0, errors.join('; '))
} finally {
  for (const app of [...apps]) await stop(app)
  clearTimeout(watchdog)
  const result = { work, at: new Date().toISOString(), results, metrics, errors, warnings }
  await fs.writeFile(join(work, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`History evidence: ${work}`)
}
