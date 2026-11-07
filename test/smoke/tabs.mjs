#!/usr/bin/env node
/** Packaged document-tab integration, safety, recovery and bounded stress checks. */
import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = process.env.TYPING_APP ?? process.argv[2] ?? join(root, 'release/mac-arm64/Typing.app')
const executablePath = process.env.TYPING_EXE ?? join(bundle, process.platform === 'darwin' ? 'Contents/MacOS/Typing' : 'Typing.exe')
const work = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'typing-tabs-')))
const script = join(work, 'save-as.txt')
const docs = join(work, 'docs')
await fs.mkdir(docs)
await fs.writeFile(script, 'canceled')
const paths = Array.from({ length: 14 }, (_, i) => join(docs, `document-${i + 1}.md`))
for (const [i, path] of paths.entries()) await fs.writeFile(path, `# Document ${i + 1}\n\nOriginal ${i + 1}\n`)
const mixed = join(docs, 'mixed.md')
await fs.writeFile(mixed, '\ufeffone\r\ntwo\nthree\r')
const large = join(docs, 'large.md')
await fs.writeFile(large, Array.from({ length: 12000 }, (_, i) => `Paragraph ${i}: a writing document with **bold**, [local](./note.md) and ordinary words.\n\n`).join(''))
const results = []
const launched = new Set()
const allErrors = []
const watchdog = setTimeout(() => {
  for (const app of launched) app.process()?.kill('SIGKILL')
  console.error('tabs smoke exceeded its 300s bound')
  process.exit(3)
}, 300000)
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  assert.ok(ok, name)
}
const t = (page, method, ...args) => page.evaluate(({ method, args }) => window.__typingTest[method](...args), { method, args })
const tabState = page => t(page, 'tabs')
const open = (page, path) => t(page, 'openFile', path)
const activate = (page, index) => t(page, 'activate', index)
const text = page => t(page, 'getText')
const insert = (page, value) => t(page, 'insert', value)
const command = (page, value) => t(page, 'command', value)
async function launch(userData, args = []) {
  await fs.mkdir(userData, { recursive: true })
  // Explicit autosave off makes dirty-tab decisions deterministic.
  if (!(await fs.stat(join(userData, 'preferences.json')).catch(() => null))) {
    await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ autoSave: false, showOutline: false }))
  }
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, '--js-flags=--expose-gc', ...args], env: { ...process.env, TYPING_TEST: '1', TYPING_TEST_SAVE_AS_FILE: script }, timeout: 60000 })
  launched.add(app)
  const page = await app.firstWindow({ timeout: 30000 })
  const errors = []
  page.on('pageerror', e => { errors.push(e.message); allErrors.push(e.message) })
  await page.waitForSelector('.cm-content')
  return { app, page, errors }
}
async function stop(app) {
  if (!launched.has(app)) return
  await Promise.race([
    app.evaluate(({ BrowserWindow, app }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit() }).catch(() => {}),
    new Promise(r => setTimeout(r, 3000))
  ])
  if (app.process()?.exitCode === null) app.process().kill('SIGKILL')
  await new Promise(r => setTimeout(r, 500))
  launched.delete(app)
}
async function closeAnswer(page, choice) {
  await page.evaluate(() => { void window.__typingTest.closeTab() })
  await page.getByRole('button', { name: choice, exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#overlay').classList.contains('hidden'))
  await page.waitForTimeout(150)
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
let perf
try {
  const { app, page, errors } = await launch(join(work, 'ui'), [docs])
  await page.waitForFunction(() => document.querySelector('#sidebar-folder').textContent !== 'No folder')
  check('starts with one empty tab', (await tabState(page)).length === 1)
  await open(page, paths[0])
  check('opening replaces untouched Untitled', (await tabState(page)).length === 1)
  await open(page, paths[1])
  await open(page, paths[2])
  check('three documents open at once', (await tabState(page)).length === 3)
  await open(page, paths[0])
  check('duplicate open focuses existing identity', (await tabState(page)).length === 3 && (await tabState(page))[0].active)
  const alias = join(docs, 'alias.md')
  await fs.symlink(paths[0], alias)
  await open(page, alias)
  check('symlink duplicate focuses same tab', (await tabState(page)).length === 3)
  await insert(page, 'ALPHA')
  const selected = await t(page, 'selection', 1, 4)
  await command(page, 'view.source')
  await activate(page, 1)
  await insert(page, 'BETA')
  await command(page, 'edit.undo')
  check('undo in second tab affects only second', !(await text(page)).includes('BETA'))
  await activate(page, 0)
  check('first tab text/selection/source are retained', (await text(page)).includes('ALPHA') && JSON.stringify(await t(page, 'selection')) === JSON.stringify(selected) && (await tabState(page))[0].sourceMode)
  await command(page, 'edit.undo')
  check('first tab has its own undo', !(await text(page)).includes('ALPHA'))
  await command(page, 'edit.redo')
  check('dirty marker and accessible selected tab', await page.getByRole('tab', { selected: true }).getAttribute('aria-label').then(x => /unsaved changes/.test(x)))
  await closeAnswer(page, 'Cancel')
  check('Cancel retains dirty tab', (await tabState(page)).length === 3 && (await text(page)).includes('ALPHA'))
  await closeAnswer(page, "Don't Save")
  check('discard closes only selected tab and leaves disk alone', (await tabState(page)).length === 2 && !(await fs.readFile(paths[0], 'utf8')).includes('ALPHA'))
  await t(page, 'newDocument')
  await insert(page, 'UNTITLED_SAVE')
  await closeAnswer(page, 'Save')
  check('cancelled Save As aborts tab close', (await text(page)) === 'UNTITLED_SAVE')
  const rescued = join(docs, 'rescued.md')
  await fs.writeFile(script, rescued)
  await closeAnswer(page, 'Save')
  check('Save As writes correct untitled and then closes it', (await fs.readFile(rescued, 'utf8')) === 'UNTITLED_SAVE' && (await tabState(page)).length === 2)
  const notDirectory = join(work, 'not-a-directory')
  await fs.writeFile(notDirectory, 'file')
  await fs.writeFile(script, join(notDirectory, 'cannot-save.md'))
  await t(page, 'newDocument')
  await insert(page, 'FAILED_SAVE')
  await closeAnswer(page, 'Save')
  check('failed save aborts close and keeps text', (await text(page)) === 'FAILED_SAVE')
  await closeAnswer(page, "Don't Save")
  await fs.writeFile(script, 'canceled')
  await t(page, 'newDocument')
  const touchedId = (await tabState(page)).find(x => x.active).id
  await insert(page, 'undo-to-empty')
  await command(page, 'edit.undo')
  await open(page, paths[0])
  check('opening does not replace an edited-then-undone Untitled', (await tabState(page)).some(x => x.id === touchedId))
  await t(page, 'closeTab')
  await activate(page, (await tabState(page)).findIndex(x => x.id === touchedId))
  await t(page, 'closeTab')

  // Opening from quick-open, folder tree and the OS keeps dirty work in place.
  await activate(page, 0)
  await insert(page, 'BACKGROUND_EDIT')
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await page.locator('.quick-input').fill('document-1.md')
  check('quick open ranks exact filename first', (await page.getByRole('option').first().innerText()) === 'document-1.md')
  // The legacy picker replaces result nodes on mouseenter. Dispatch the exact
  // result's click without pointer-hover churn; features.mjs covers keyboard pick.
  await page.getByRole('option', { name: 'document-1.md', exact: true }).dispatchEvent('click')
  await page.waitForFunction(() => window.__typingTest.path()?.endsWith('document-1.md'))
  check('quick open adds a tab without discarding dirty work', (await tabState(page)).some(x => x.dirty && x.path === paths[1]))
  await page.getByRole('treeitem').filter({ hasText: 'document-4.md' }).click()
  await page.waitForFunction(() => window.__typingTest.path()?.endsWith('document-4.md'))
  check('folder tree opens a tab', (await tabState(page)).some(x => x.path === paths[3]))
  await app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), paths[4])
  await page.waitForFunction(() => window.__typingTest.path()?.endsWith('document-5.md'))
  check('Finder/Dock open-file opens a tab', (await tabState(page)).some(x => x.path === paths[4]))
  await command(page, 'doc.recent')
  const recentCount = (await tabState(page)).length
  await page.locator('.dialog-list .item').filter({ hasText: paths[0] }).click()
  await page.waitForFunction(() => window.__typingTest.path()?.endsWith('document-1.md'))
  check('recent-files duplicate focuses without adding a tab', (await tabState(page)).length === recentCount)

  // Real Chromium File objects exercise the preload's pathForFile drop path.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'drop-fixture'; input.multiple = true; input.hidden = true; document.body.append(input) })
  await page.locator('#drop-fixture').setInputFiles([paths[5], paths[6]])
  await page.evaluate(() => {
    const dt = new DataTransfer()
    for (const file of document.querySelector('#drop-fixture').files) dt.items.add(file)
    document.querySelector('#editor-host').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    document.querySelector('#drop-fixture').remove()
  })
  await page.waitForFunction(() => window.__typingTest.path()?.endsWith('document-7.md'))
  check('dropping several real local files opens separate tabs', (await tabState(page)).some(x => x.path === paths[5]) && (await tabState(page)).some(x => x.path === paths[6]))

  // Background external changes and deletions retain the target's metadata.
  const background = (await tabState(page)).findIndex(x => x.path === paths[1])
  await activate(page, (await tabState(page)).findIndex(x => x.path === paths[4]))
  await fs.writeFile(paths[1], 'EXTERNAL_WRITER\n')
  await page.waitForFunction(p => window.__typingTest.tabs().find(t => t.path === p)?.externalChange, paths[1], { timeout: 7000 })
  check('background dirty tab notices external change', (await tabState(page))[background].externalChange)
  await activate(page, background)
  check('background conflict banner is shown on activation', /changed on disk/.test(await page.locator('#banner').innerText()) && (await text(page)).includes('BACKGROUND_EDIT'))
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await page.waitForFunction(() => window.__typingTest.getText() === 'EXTERNAL_WRITER\n')
  check('reload affects only that tab', (await text(page)) === 'EXTERNAL_WRITER\n')
  await activate(page, (await tabState(page)).findIndex(x => x.path === paths[4]))
  await fs.unlink(paths[1])
  await page.waitForFunction(p => window.__typingTest.tabs().find(t => t.path === p)?.deleted, paths[1], { timeout: 7000 })
  await activate(page, background)
  check('background deletion retains text and shows banner', /deleted/.test(await page.locator('#banner').innerText()) && (await text(page)) === 'EXTERNAL_WRITER\n')

  await open(page, mixed)
  const meta = await t(page, 'state')
  await t(page, 'selection', 2, 5)
  await activate(page, 0)
  await open(page, mixed)
  check('line-ending/hash/encoding model survives switch', JSON.stringify(await t(page, 'state')) === JSON.stringify(meta))
  await t(page, 'save')
  check('BOM and mixed endings survive tab switching and save', (await fs.readFile(mixed, 'utf8')) === '\ufeffone\r\ntwo\nthree\r')

  // All dirty tabs participate in quit, and a later Cancel preserves prior discards.
  await activate(page, 0); await insert(page, 'QUIT_A')
  await activate(page, 1); await insert(page, 'QUIT_B')
  await app.evaluate(({ app }) => app.quit())
  await page.getByRole('button', { name: "Don't Save", exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(200)
  await activate(page, 0)
  check('quit Cancel retains window and earlier discard candidate', (await text(page)).includes('QUIT_A'))
  await activate(page, 1)
  check('quit Cancel retains later dirty tab', (await text(page)).includes('QUIT_B'))

  // Reordering, keyboard operability, overflow and both shortcut families.
  const beforeReorder = await tabState(page)
  const labels = page.getByRole('tab')
  await labels.nth(0).dragTo(labels.nth(2))
  check('drag reorder preserves document identity', (await tabState(page))[2].id === beforeReorder[0].id)
  await page.keyboard.press('ControlOrMeta+t')
  check('new-tab shortcut', (await tabState(page)).at(-1).path === null)
  await page.keyboard.press('ControlOrMeta+w')
  check('close-tab shortcut leaves window open', (await tabState(page)).length === beforeReorder.length)
  await activate(page, 0)
  await page.keyboard.press('Control+Tab')
  check('Ctrl+Tab activates next', (await tabState(page))[1].active)
  await page.keyboard.press('Control+Shift+Tab')
  check('Ctrl+Shift+Tab activates previous', (await tabState(page))[0].active)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+]' : 'Control+PageDown')
  check('platform next-tab alternate', (await tabState(page))[1].active)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+[' : 'Control+PageUp')
  check('platform previous-tab alternate', (await tabState(page))[0].active)
  for (const i of [1, 2, 9]) {
    await page.keyboard.press(`ControlOrMeta+Alt+${i}`)
    const state = await tabState(page)
    check(`jump-to-tab ${i}`, state[i === 9 ? state.length - 1 : i - 1].active)
  }
  await page.getByRole('tab', { selected: true }).focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  check('tablist arrow keys and roving focus', (await tabState(page))[1].active && await page.getByRole('tab').nth(1).evaluate(el => el === document.activeElement))
  const keyboardMoved = (await tabState(page))[1].id
  await page.keyboard.press('Alt+Shift+ArrowRight')
  check('keyboard reorder retains focus and identity', (await tabState(page))[2].id === keyboardMoved && await page.getByRole('tab').nth(2).evaluate(el => el === document.activeElement))
  for (const path of paths.slice(5)) await open(page, path)
  check('tab strip overflows horizontally', await page.locator('#tab-list').evaluate(el => el.scrollWidth > el.clientWidth))
  await page.getByRole('tab').last().click({ button: 'middle' })
  check('middle-click closes a tab', !(await tabState(page)).some(x => x.path === paths.at(-1)))
  for (const dark of [false, true]) {
    await app.evaluate(({ nativeTheme }, dark) => { nativeTheme.themeSource = dark ? 'dark' : 'light' }, dark)
    await page.waitForFunction(d => document.documentElement.classList.contains('dark') === d, dark)
    check(`${dark ? 'dark' : 'light'} theme tab strip`, await page.getByRole('tablist').isVisible())
    if (process.env.TYPING_TABS_SHOTS) await page.screenshot({ path: `${process.env.TYPING_TABS_SHOTS}-${dark ? 'dark' : 'light'}.png` })
  }
  check('no renderer errors during tab integration', errors.length === 0, errors.join(' | '))
  await stop(app)

  // Crash recovery: named plus multiple Untitled tabs, stable identities, all offered.
  const ud = join(work, 'recovery')
  const crash = await launch(ud)
  await open(crash.page, paths[0]); await insert(crash.page, 'CRASH_NAMED')
  for (let i = 0; i < 3; i++) { await t(crash.page, 'newDocument'); await insert(crash.page, `CRASH_UNTITLED_${i}`) }
  await crash.page.waitForTimeout(800)
  await insert(crash.page, '_AGAIN')
  await crash.page.waitForTimeout(600)
  const records = (await fs.readdir(join(ud, 'recovery'))).filter(x => x.endsWith('.json'))
  check('one stable recovery record per unsaved tab', records.length === 4)
  crash.app.process().kill('SIGKILL')
  launched.delete(crash.app)
  await new Promise(r => setTimeout(r, 800))
  const restored = await launch(ud)
  for (let i = 0; i < 4; i++) await restored.page.getByRole('button', { name: 'Restore', exact: true }).click()
  await restored.page.waitForFunction(() => document.querySelector('#overlay').classList.contains('hidden'))
  const restoredTexts = []
  for (let i = 0; i < (await tabState(restored.page)).length; i++) { await activate(restored.page, i); restoredTexts.push(await text(restored.page)) }
  check('forced-kill relaunch offers and restores every unsaved tab', restoredTexts.length === 4 && restoredTexts.some(x => x.includes('CRASH_NAMED')) && [0, 1, 2].every(i => restoredTexts.some(x => x.includes(`CRASH_UNTITLED_${i}`))))
  check('all recovered tabs remain dirty', (await tabState(restored.page)).every(x => x.dirty))
  check('recovery preserves durable draft identities', (await tabState(restored.page)).every(x => records.includes(`${x.id}.json`)))
  await stop(restored.app)

  const autosaveData = join(work, 'autosave')
  await fs.mkdir(autosaveData)
  await fs.writeFile(join(autosaveData, 'preferences.json'), JSON.stringify({ autoSave: true, autoSaveMs: 350, showOutline: false }))
  const automatic = await launch(autosaveData)
  await open(automatic.page, paths[0]); await insert(automatic.page, 'AUTO_FIRST')
  await open(automatic.page, paths[2]); await insert(automatic.page, 'AUTO_SECOND')
  await t(automatic.page, 'newDocument')
  await automatic.page.waitForFunction(() => window.__typingTest.tabs().every(t => !t.dirty), null, { timeout: 7000 })
  const firstAuto = await fs.readFile(paths[0], 'utf8'), secondAuto = await fs.readFile(paths[2], 'utf8')
  check('background autosave writes each tab only to its own file', firstAuto.includes('AUTO_FIRST') && !firstAuto.includes('AUTO_SECOND') && secondAuto.includes('AUTO_SECOND') && !secondAuto.includes('AUTO_FIRST'))
  await stop(automatic.app)

  const stress = await launch(join(work, 'stress'), [large, paths[0]])
  await stress.page.waitForFunction(() => window.__typingTest.tabs().length === 2)
  check('command line opens multiple documents in tabs', (await tabState(stress.page)).some(x => x.path === large))
  await activate(stress.page, 0)
  const scrollSelection = await t(stress.page, 'selection', 1000, 1005)
  await stress.page.locator('.cm-scroller').evaluate(el => { el.scrollTop = 2500 })
  await stress.page.waitForTimeout(100)
  const scrollBefore = await t(stress.page, 'selection')
  await activate(stress.page, 1)
  await activate(stress.page, 0)
  await stress.page.waitForTimeout(100)
  const scrollAfter = await t(stress.page, 'selection')
  check('large document selection and scroll survive switching', scrollAfter.anchor === scrollSelection.anchor && scrollAfter.head === scrollSelection.head && Math.abs(scrollAfter.scroll - scrollBefore.scroll) < 2, JSON.stringify({ scrollBefore, scrollAfter }))
  const latency = await stress.page.evaluate(async () => {
    const sync = [], presented = []
    for (let i = 0; i < 40; i++) {
      const start = performance.now()
      window.__typingTest.activate(i % 2)
      sync.push(performance.now() - start)
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      presented.push(performance.now() - start)
    }
    return { sync, presented }
  })
  const cdp = await stress.page.context().newCDPSession(stress.page)
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
  // Warm the editor/parser and filesystem caches before measuring retained memory.
  for (let i = 0; i < 5; i++) { assert.ok(await open(stress.page, paths[2])); await t(stress.page, 'closeTab') }
  const before = await heap()
  const heapSamples = []
  for (let i = 0; i < 50; i++) {
    await open(stress.page, large) // existing large tab focuses; then test a disposable large copy
    const copy = join(docs, 'cycle.md')
    if (i === 0) await fs.copyFile(large, copy)
    assert.ok(await open(stress.page, copy))
    await insert(stress.page, 'DISCARD_CYCLE')
    await closeAnswer(stress.page, "Don't Save")
    if ([9, 24, 49].includes(i)) heapSamples.push({ cycles: i + 1, bytes: await heap() })
  }
  const after = await heap()
  perf = { documentBytes: (await fs.stat(large)).size, switches: 40, switchSyncMedianMs: percentile(latency.sync, .5), switchSyncP95Ms: percentile(latency.sync, .95), switchTwoFramesMedianMs: percentile(latency.presented, .5), switchTwoFramesP95Ms: percentile(latency.presented, .95), cycles: 50, heapBeforeBytes: before, heapAfterBytes: after, heapDeltaBytes: after - before, heapSamples }
  check('1 MB tab switches stay fast', perf.switchSyncP95Ms < 100, JSON.stringify(perf))
  check('50 large dirty open/discard cycles release views and bounded retained heap', (await tabState(stress.page)).length === 2 && after - before < 20 * 1024 * 1024 && heapSamples.at(-1).bytes - heapSamples[0].bytes < 5 * 1024 * 1024, `${((after - before) / 1024 / 1024).toFixed(2)} MiB retained delta`)
  check('no stress renderer errors', stress.errors.length === 0, stress.errors.join(' | '))
  await stop(stress.app)
  const last = await launch(join(work, 'last-tab'))
  const lastClosed = last.page.waitForEvent('close')
  await last.page.keyboard.press('ControlOrMeta+w').catch(error => { if (!last.page.isClosed()) throw error })
  await lastClosed
  check('closing the last tab closes the window', last.page.isClosed())
  if (process.platform === 'darwin') {
    await last.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('tab.new').click())
    const fresh = await last.app.firstWindow()
    await fresh.waitForSelector('.cm-content')
    check('macOS New Tab recreates a closed window with one Untitled', (await tabState(fresh)).length === 1 && (await tabState(fresh))[0].path === null)
    const freshClosed = fresh.waitForEvent('close')
    await fresh.keyboard.press('ControlOrMeta+w').catch(error => { if (!fresh.isClosed()) throw error })
    await freshClosed
    await last.app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), paths[0])
    const reopened = await last.app.firstWindow()
    await reopened.waitForSelector('.cm-content')
    await reopened.waitForFunction(() => window.__typingTest?.path()?.endsWith('document-1.md'))
    check('macOS Finder open recreates a closed window and opens its tab', (await tabState(reopened)).length === 1)
  }
  await stop(last.app)
  console.log(`\n${results.length} tab checks passed`)
} catch (error) {
  console.error(error)
  console.error('renderer errors:', allErrors)
  for (const app of launched) {
    const page = app.windows()[0]
    if (page && !page.isClosed()) console.error('failure state:', await page.evaluate(() => ({ title: document.title, tabs: window.__typingTest.tabs(), overlay: document.querySelector('#overlay').textContent, quick: document.querySelector('.quick-list')?.textContent })).catch(() => null))
  }
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  for (const app of launched) await stop(app)
  if (process.env.TYPING_TABS_REPORT) await fs.writeFile(process.env.TYPING_TABS_REPORT, JSON.stringify({ results, perf }, null, 2))
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.error('cleanup:', error.message))
}
