#!/usr/bin/env node
/**
 * Data-safety end-to-end suite against the packaged app.
 *
 * Every check here exists because something could lose or rewrite a writer's
 * text; each one fails on the build before the fix that added it.
 *
 *   node test/smoke/datasafety.mjs [path-to-Typing.app]
 *
 * Sections:
 *   1. the unsaved-work guard (new, open, quick open, close, cancelled/failed save)
 *   2. undo history and in-flight saves do not leak across documents
 *   3. mixed CRLF/LF/lone-CR files, with and without a BOM
 *   4. files that are not valid UTF-8
 *   5. concurrent writers (same-millisecond mtime, deleted file)
 *   6. the local asset protocol (symlink escape)
 *   7. the spell-check preference and the packaged Content-Security-Policy
 */
import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const appPath =
  process.env.TYPING_APP ??
  process.argv[2] ??
  join(projectRoot, 'release', process.platform === 'darwin' ? 'mac-arm64/Typing.app' : 'win-unpacked')
// The packaged app lives in a bundle on macOS and in a plain folder on Windows/Linux.
const executablePath =
  process.env.TYPING_EXE ??
  (process.platform === 'darwin' ? join(appPath, 'Contents/MacOS/Typing') : join(appPath, 'Typing.exe'))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(ok)
}

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const work = await fs.mkdtemp(join(tmpdir(), 'typing-datasafety-'))
const saveAsScript = join(work, 'save-as-script.txt')
const folder = join(work, 'docs')
const outside = join(work, 'outside')

const docPath = (name) => join(folder, name)
const read = (name) => fs.readFile(docPath(name))
const readText = async (name) => (await read(name)).toString('utf8')
const binary = async (name) => (await read(name)).toString('binary')

async function launch(args, extraEnv = {}) {
  // A fresh data directory per instance: Electron's single-instance lock is keyed
  // by it, so a leftover process can never answer for the one we just launched.
  const userData = await fs.mkdtemp(join(work, 'ud-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, ...args],
    env: { ...process.env, TYPING_TEST: '1', TYPING_TEST_SAVE_AS_FILE: saveAsScript, ...extraEnv },
    timeout: 60000
  })
  const page = await app.firstWindow({ timeout: 60000 })
  const logs = []
  page.on('console', (m) => {
    // This suite deliberately requests forbidden assets and provokes one CSP
    // violation, and Chromium logs both as console errors; only real script
    // errors are collected.
    if (m.type() === 'error' && !/Failed to load resource|Content Security Policy|Refused to connect/.test(m.text())) {
      logs.push(m.text())
    }
  })
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
  await page.waitForSelector('.cm-content', { timeout: 30000 })
  await page.waitForTimeout(900)
  return { app, page, logs }
}

/** Close the app and make sure the process is really gone before the next section. */
async function closeApp(app) {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 500))
}

const text = (page) => page.evaluate(() => window.__typingTest.getText())
const state = (page) => page.evaluate(() => window.__typingTest.state())
const openFile = async (page, name) => {
  await page.evaluate(async (p) => window.__typingTest.openFile(p), docPath(name))
  await page.waitForTimeout(500)
}
const dialogTitle = (page) => page.evaluate(() => document.querySelector('.dialog h2')?.textContent ?? null)
const bannerText = (page) => page.evaluate(() => document.querySelector('#banner')?.textContent ?? '')
const bannerVisible = (page) => page.evaluate(() => !document.querySelector('#banner').classList.contains('hidden'))

async function clickDialog(page, label) {
  // Exact accessible name: "Save" must not match "Don't Save".
  const button = page.getByRole('button', { name: label, exact: true }).first()
  if (!(await button.count())) return false
  await button.click()
  await page.waitForTimeout(600)
  return true
}

/** Open a file that may need the guard answered; returns the dialog title seen. */
async function openFileAnswering(page, name, choice = "Don't Save") {
  await page.evaluate((p) => {
    void window.__typingTest.openFile(p)
  }, docPath(name))
  await page.waitForTimeout(500)
  const title = await dialogTitle(page)
  if (title) await clickDialog(page, choice)
  await page.waitForTimeout(700)
  return title
}

async function focusEnd(page) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.waitForTimeout(150)
}

/** Type one character so the document is definitely dirty right now. */
async function poke(page, ch = 'x') {
  await page.keyboard.type(ch)
  await page.waitForTimeout(80)
}

/** Turn the autosave preference on or off through the real Preferences dialog. */
async function setAutosave(page, on) {
  await page.keyboard.press('ControlOrMeta+,')
  await page.waitForTimeout(500)
  const box = page.locator('.dialog .row', { hasText: 'Autosave' }).locator('input[type=checkbox]').first()
  const found = (await box.count()) > 0
  if (found && (await box.isChecked()) !== on) {
    await box.click()
    await page.waitForTimeout(300)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return found
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
await fs.mkdir(folder, { recursive: true })
await fs.mkdir(outside, { recursive: true })
await fs.writeFile(join(outside, 'secret.txt'), 'TOP SECRET\n', 'utf8')
await fs.writeFile(docPath('inner.png'), Buffer.from(PNG_1x1, 'base64'))
await fs.symlink(join(outside, 'secret.txt'), docPath('escape.png'))
await fs.writeFile(docPath('plain.md'), '# Plain\n\nbody\n', 'utf8')
await fs.writeFile(docPath('second.md'), '# Second\n\nother text\n', 'utf8')
await fs.writeFile(docPath('mixed.md'), Buffer.from('one\r\ntwo\r\nthree\n', 'utf8'))
await fs.writeFile(
  docPath('mixed-bom.md'),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\ngamma\r\n', 'utf8')])
)
await fs.writeFile(docPath('invalid.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
await fs.writeFile(docPath('race.md'), 'original\n', 'utf8')
await fs.writeFile(docPath('gone.md'), 'about to be deleted\n', 'utf8')
await fs.writeFile(saveAsScript, 'canceled', 'utf8')

// ===========================================================================
// 1. the unsaved-work guard
// ===========================================================================
console.log('\n1. Unsaved-work guard')
{
  const { app, page, logs } = await launch([folder])
  try {
    // Keep the timing deterministic: autosave is exercised separately below.
    check('autosave can be switched off in Preferences', await setAutosave(page, false))

    // ---- the reported bug: new document with an untitled draft ------------
    await openFile(page, 'plain.md')
    await page.evaluate(() => window.__typingTest.newDocument())
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.keyboard.type('UNSAVED_SENTINEL')
    await page.waitForTimeout(300)
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(700)
    const title = await dialogTitle(page)
    check('⌘N on an untitled draft asks before discarding it', /unsaved/i.test(title ?? ''), String(title))
    check('the draft is still in the editor while the question is open', (await text(page)).includes('UNSAVED_SENTINEL'))

    await clickDialog(page, 'Cancel')
    check('Cancel keeps the untitled draft', (await text(page)).includes('UNSAVED_SENTINEL'))
    check('Cancel leaves the document untitled', (await state(page)).path === null)

    // A cancelled Save As must not switch either: the old code ignored the result.
    await fs.writeFile(saveAsScript, 'canceled', 'utf8')
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(600)
    await clickDialog(page, 'Save')
    await page.waitForTimeout(700)
    check('a cancelled Save As keeps the draft and aborts the switch', (await text(page)).includes('UNSAVED_SENTINEL'))
    check('a cancelled Save As leaves the document untitled', (await state(page)).path === null)

    // Save on an untitled draft goes through Save As, and only then switches.
    const rescuedTarget = docPath('rescued-draft.md')
    await fs.writeFile(saveAsScript, rescuedTarget, 'utf8')
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(600)
    await clickDialog(page, 'Save')
    await page.waitForTimeout(1200)
    const rescued = await fs.readFile(rescuedTarget, 'utf8').catch(() => '')
    check('Save on an untitled draft writes the text through Save As', rescued.includes('UNSAVED_SENTINEL'), rescued.slice(0, 40))
    check('the switch happens only after the save finished', (await text(page)) === '')
    check('the new document has no path yet', (await state(page)).path === null)
    await fs.writeFile(saveAsScript, 'canceled', 'utf8')

    // ---- named, dirty document ------------------------------------------
    await openFile(page, 'second.md')
    await focusEnd(page)
    await poke(page)
    await page.keyboard.type('NAMED_EDIT')
    await page.waitForTimeout(150)
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(700)
    check('⌘N on a named dirty document asks too', /unsaved/i.test((await dialogTitle(page)) ?? ''))
    await clickDialog(page, 'Cancel')
    check('Cancel keeps the named document and its edit', (await text(page)).includes('NAMED_EDIT'))
    check('Cancel did not write anything to disk', !(await readText('second.md')).includes('NAMED_EDIT'))

    await poke(page)
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(600)
    await clickDialog(page, "Don't Save")
    await page.waitForTimeout(500)
    check("Don't Save switches to a new empty document", (await text(page)) === '')
    check("Don't Save leaves the file on disk untouched", !(await readText('second.md')).includes('NAMED_EDIT'))

    await openFile(page, 'plain.md')
    await focusEnd(page)
    await poke(page)
    await page.keyboard.type('SAVE_THEN_SWITCH')
    await page.waitForTimeout(150)
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(600)
    await clickDialog(page, 'Save')
    await page.waitForTimeout(1200)
    check('Save writes the edit before switching', (await readText('plain.md')).includes('SAVE_THEN_SWITCH'))
    check('Save then switches to the new document', (await text(page)) === '')

    // ---- quick open goes through the same guard --------------------------
    await openFile(page, 'plain.md')
    await focusEnd(page)
    await poke(page)
    await page.keyboard.type('QUICK_OPEN_EDIT')
    await page.waitForTimeout(150)
    await page.keyboard.press('ControlOrMeta+Shift+O')
    await page.waitForTimeout(500)
    const quickOpenShown = (await page.locator('.quick-input').count()) === 1
    await page.keyboard.type('second')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    check(
      'quick open asks before replacing unsaved work',
      quickOpenShown && /unsaved/i.test((await dialogTitle(page)) ?? ''),
      String(await dialogTitle(page))
    )
    await clickDialog(page, 'Cancel')
    check('Cancel from quick open keeps the edited document', (await text(page)).includes('QUICK_OPEN_EDIT'))

    // ---- a file opened from the Finder / the Dock -----------------------
    // The same IPC path the OS uses: main receives `open-file` and asks the
    // renderer to open the path, which must go through the guard as well.
    await page.evaluate(() => {
      void window.__typingTest.newDocument()
    })
    await page.waitForTimeout(500)
    if (await dialogTitle(page)) await clickDialog(page, "Don't Save")
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.keyboard.type('FINDER_OPEN_DRAFT')
    await page.waitForTimeout(250)
    await app.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault() {} }, path)
    }, docPath('second.md'))
    await page.waitForTimeout(700)
    check('a file opened from the Finder or the Dock asks first', /unsaved/i.test((await dialogTitle(page)) ?? ''))
    await clickDialog(page, 'Cancel')
    check('cancelling that keeps the draft in the editor', (await text(page)).includes('FINDER_OPEN_DRAFT'))

    // ---- window close ---------------------------------------------------
    await poke(page)
    await page.keyboard.press('ControlOrMeta+w')
    await page.waitForTimeout(700)
    check('⌘W asks through the same guard', /unsaved/i.test((await dialogTitle(page)) ?? ''))
    await clickDialog(page, 'Cancel')
    check(
      'cancelling ⌘W keeps the window and the text',
      (await page.locator('.cm-content').count()) === 1 && (await text(page)).includes('FINDER_OPEN_DRAFT')
    )

    check('no renderer errors during the guard checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

console.log('\n1b. A pending autosave is dropped when the document is left')
{
  // Fresh instance whose document is clean at launch, autosave on (the default).
  const { app, page, logs } = await launch([docPath('second.md')])
  try {
    const before = await readText('second.md')
    await focusEnd(page)
    await page.keyboard.type('AUTOSAVE_MUST_NOT_LEAK')
    await page.waitForTimeout(150)
    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(500)
    await clickDialog(page, "Don't Save")
    await page.waitForTimeout(2400)
    const after = await readText('second.md')
    check(
      'a pending autosave is dropped when the document is left',
      after === before && !after.includes('AUTOSAVE_MUST_NOT_LEAK'),
      after.slice(-44).replace(/\n/g, '\\n')
    )
    check('the new empty document did not receive the old text', (await text(page)) === '')
    check('no renderer errors during the autosave check', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

// ===========================================================================
// 2. undo history and in-flight saves
// ===========================================================================
console.log('\n2. Undo history and in-flight saves stay with their document')
{
  const { app, page, logs } = await launch([folder])
  try {
    await setAutosave(page, false)
    await openFile(page, 'plain.md')
    await focusEnd(page)
    await page.keyboard.type('ALPHA_TEXT')
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(800)
    await openFile(page, 'second.md')
    const secondText = await text(page)
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(300)
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(300)
    const afterUndo = await text(page)
    check('⌘Z after switching documents does not restore the previous file', afterUndo === secondText, JSON.stringify(afterUndo.slice(0, 30)))
    check('undo did not pull in the other file’s text', !afterUndo.includes('ALPHA_TEXT'))

    // A save started for one file must not write into, or relabel, the other.
    await openFile(page, 'plain.md')
    await focusEnd(page)
    await page.keyboard.type('SAVE_TARGET_CHECK')
    await page.waitForTimeout(150)
    await page.evaluate(async () => {
      const t = window.__typingTest
      const target = `${t.state().path.replace(/[^/]+$/, '')}second.md`
      void t.save()
      void t.openFile(target)
    })
    await page.waitForTimeout(800)
    await clickDialog(page, "Don't Save")
    await page.waitForTimeout(1500)
    const plainNow = await readText('plain.md')
    const secondNow = await readText('second.md')
    check('the save wrote its own document', plainNow.includes('SAVE_TARGET_CHECK'), plainNow.slice(-44).replace(/\n/g, '\\n'))
    check('the other document was not written by that save', !secondNow.includes('SAVE_TARGET_CHECK') && secondNow.includes('other text'))
    check('the editor shows the document that was opened last', (await text(page)).includes('other text'))
    check('no renderer errors during the undo/isolation checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

// ===========================================================================
// 3. mixed line endings
// ===========================================================================
console.log('\n3. Mixed line endings')
{
  const { app, page, logs } = await launch([folder])
  try {
    await setAutosave(page, false)
    const statBefore = await fs.stat(docPath('mixed.md'))
    await openFile(page, 'mixed.md')
    await focusEnd(page)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(900)
    check(
      'open + save keeps the exact bytes of one\\r\\ntwo\\r\\nthree\\n',
      (await binary('mixed.md')) === 'one\r\ntwo\r\nthree\n',
      JSON.stringify(await binary('mixed.md'))
    )
    check('open + save does not even touch the modification time', statBefore.mtimeMs === (await fs.stat(docPath('mixed.md'))).mtimeMs)

    await focusEnd(page)
    await page.keyboard.type('\nfour')
    await page.waitForTimeout(250)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(900)
    check(
      'an edit keeps the existing CRLF/LF lines and gives the new line the dominant CRLF',
      (await binary('mixed.md')) === 'one\r\ntwo\r\nthree\n\r\nfour',
      JSON.stringify(await binary('mixed.md'))
    )

    const bomBefore = await read('mixed-bom.md')
    await openFile(page, 'mixed-bom.md')
    await focusEnd(page)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(800)
    check('a BOM + mixed-ending file is unchanged by open + save', Buffer.compare(await read('mixed-bom.md'), bomBefore) === 0)

    await focusEnd(page)
    await page.keyboard.type('!')
    await page.waitForTimeout(250)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(900)
    const bomAfter = await read('mixed-bom.md')
    check(
      'editing keeps exactly one BOM and every original ending',
      bomAfter.toString('binary') === '\xef\xbb\xbfalpha\r\nbeta\ngamma\r\n!',
      JSON.stringify(bomAfter.toString('binary'))
    )
    check('no renderer errors during the line-ending checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

// ===========================================================================
// 4. files that are not valid UTF-8
// ===========================================================================
console.log('\n4. Files that are not valid UTF-8')
{
  const { app, page, logs } = await launch([folder])
  try {
    await setAutosave(page, false)
    const before = await read('invalid.md')
    await openFile(page, 'invalid.md')
    check('opening a non-UTF-8 file warns about it', (await bannerVisible(page)) && /UTF-8/.test(await bannerText(page)), (await bannerText(page)).slice(0, 60))

    await focusEnd(page)
    await page.keyboard.type('EDIT')
    await page.waitForTimeout(250)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(900)
    check('⌘S does not overwrite the original bytes', Buffer.compare(await read('invalid.md'), before) === 0)
    const saveBanner = await bannerText(page)
    check('⌘S explains why and offers Save As', /UTF-8/.test(saveBanner) && /Save As/.test(saveBanner), saveBanner.slice(0, 70))

    const direct = await page.evaluate(
      async (p) => window.typing.call('file.save', { path: p, text: 'rewritten\n' }),
      docPath('invalid.md')
    )
    check(
      'the main process refuses an in-place rewrite too',
      direct?.ok === false && direct?.code === 'invalid-utf8',
      JSON.stringify(direct).slice(0, 80)
    )
    check('the refused write left the file alone', Buffer.compare(await read('invalid.md'), before) === 0)

    // Explicit consent is the only way through, and it writes valid UTF-8.
    const consentTarget = docPath('invalid-copy.md')
    await fs.copyFile(docPath('invalid.md'), consentTarget)
    const consent = await page.evaluate(
      async (p) => window.typing.call('file.save', { path: p, text: 'rewritten\n', acceptInvalidUtf8: true }),
      consentTarget
    )
    const consentBytes = await fs.readFile(consentTarget)
    check(
      'explicit consent writes valid UTF-8',
      consent?.ok === true && ![...consentBytes].includes(0xff) && consentBytes.toString('utf8') === 'rewritten\n',
      JSON.stringify(consent).slice(0, 60)
    )
    check('no renderer errors during the encoding checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

// ===========================================================================
// 5. concurrent writers
// ===========================================================================
console.log('\n5. Concurrent writers and deleted files')
{
  const { app, page, logs } = await launch([folder])
  try {
    await setAutosave(page, false)
    await openFile(page, 'race.md')
    const before = await fs.stat(docPath('race.md'))
    // Same-millisecond replacement with the mtime restored: an mtime-only check
    // sees nothing, a content hash does.
    await fs.writeFile(docPath('race.md'), 'theirs\n', 'utf8')
    await fs.utimes(docPath('race.md'), before.atime, before.mtime)
    await focusEnd(page)
    await page.keyboard.type('MINE')
    await page.waitForTimeout(250)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(1200)
    const raceNow = await readText('race.md')
    const filesAfterRace = await fs.readdir(folder)
    const copy = filesAfterRace.find((n) => n.includes('conflict'))
    check('a same-mtime external write is detected by content', raceNow === 'theirs\n', JSON.stringify(raceNow))
    check('our version is preserved in a conflict copy', Boolean(copy), copy ?? filesAfterRace.join(', '))
    if (copy) {
      check('the conflict copy holds our text', (await fs.readFile(join(folder, copy), 'utf8')).includes('MINE'))
    }

    // Deleted outside Typing: reported, then written back on save.
    await openFile(page, 'gone.md')
    await fs.rm(docPath('gone.md'))
    await page.waitForTimeout(2400)
    const deletionBanner = await bannerText(page)
    check('deleting the open file on disk is reported', /deleted outside Typing/i.test(deletionBanner), deletionBanner.slice(0, 70))
    await focusEnd(page)
    await page.keyboard.type('AFTER_DELETE')
    await page.waitForTimeout(250)
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(1000)
    const recreated = await fs.readFile(docPath('gone.md'), 'utf8').catch(() => '')
    check('saving recreates the deleted file with the text intact', recreated.includes('AFTER_DELETE'), recreated.slice(0, 44).replace(/\n/g, '\\n'))
    check('no renderer errors during the concurrency checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

// ===========================================================================
// 6 + 7. asset protocol, spell check, CSP
// ===========================================================================
console.log('\n6. Local asset protocol')
{
  const { app, page, logs } = await launch([folder])
  try {
    const assetUrl = (abs) => `typing-asset://asset/${encodeURIComponent(abs)}`
    const status = (abs) =>
      page.evaluate(async (url) => {
        try {
          const response = await fetch(url)
          return response.status
        } catch (err) {
          return `error: ${String(err).slice(0, 40)}`
        }
      }, assetUrl(abs))

    const inside = await status(docPath('inner.png'))
    check('an image inside an opened folder is served', inside === 200, String(inside))
    const escape = await status(docPath('escape.png'))
    check('a symlink inside the folder cannot reach a file outside it', escape === 403, String(escape))
    const outsideFile = await status(join(outside, 'secret.txt'))
    check('a file outside every opened folder is refused', outsideFile === 403, String(outsideFile))

    // ---- spell check ----------------------------------------------------
    // webPreferences.spellcheck is what turns the engine on for the window, and
    // Electron does not expose it at runtime, so this reads the shipped bundle:
    // the preference must not claim "on" while the engine is disabled.
    const asarPath =
      process.platform === 'darwin'
        ? join(appPath, 'Contents/Resources/app.asar')
        : join(appPath, 'resources/app.asar')
    const asar = await fs.readFile(asarPath)
    check(
      'the packaged main process enables the spell checker engine',
      asar.includes('spellcheck: true'),
      asar.includes('spellcheck: false') ? 'bundle still disables it' : 'enabled'
    )
    const enabled = await app.evaluate(async ({ session }) => session.defaultSession.isSpellCheckerEnabled())
    check('the session spell checker is enabled', enabled === true, String(enabled))
    const domOn = await page.evaluate(() => document.querySelector('.cm-content')?.getAttribute('spellcheck'))
    check('the default preference turns spell check on in the editor', domOn === 'true', String(domOn))

    await page.keyboard.press('ControlOrMeta+,')
    await page.waitForTimeout(600)
    const box = page.locator('.dialog .row', { hasText: 'Spell check' }).locator('input[type=checkbox]').first()
    if (await box.count()) {
      await box.click()
      await page.waitForTimeout(400)
      check(
        'turning the preference off really disables it',
        (await page.evaluate(() => document.querySelector('.cm-content')?.getAttribute('spellcheck'))) === 'false'
      )
      await box.click()
      await page.waitForTimeout(400)
      check(
        'turning it back on restores it',
        (await page.evaluate(() => document.querySelector('.cm-content')?.getAttribute('spellcheck'))) === 'true'
      )
    } else {
      check('the spell check preference is reachable', false, 'checkbox not found')
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // ---- CSP ------------------------------------------------------------
    const meta = await page.evaluate(
      () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    )
    check('the packaged CSP allows no localhost origin', !/localhost|127\.0\.0\.1|ws:/.test(meta), meta.slice(0, 100))

    let hits = 0
    const server = createServer((_req, res) => {
      hits++
      res.end('reached')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const reached = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { mode: 'no-cors' })
        return `status ${response.status}`
      } catch (err) {
        return `blocked: ${String(err).slice(0, 30)}`
      }
    }, `http://localhost:${port}/probe`)
    await new Promise((r) => setTimeout(r, 300))
    await new Promise((r) => server.close(r))
    check('page script cannot reach a local HTTP server', hits === 0, `${reached}; server hits=${hits}`)
    check('no renderer errors during the security checks', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    await closeApp(app)
  }
}

await fs.rm(work, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`)
}
// Every app instance has been closed above; exit explicitly so a lingering child
// process handle cannot hang the run after the results are printed.
process.exit(failed.length ? 1 : 0)