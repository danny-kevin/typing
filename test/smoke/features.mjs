#!/usr/bin/env node
/**
 * Feature-level end-to-end checks against the packaged app: folder sidebar,
 * quick open, tables, task lists, IME composition, image paste, external file
 * changes, autosave and export.
 *
 *   node test/smoke/features.mjs
 */
import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const appPath = process.argv[2] ?? join(projectRoot, 'release/mac-arm64/Typing.app')
const executablePath = join(appPath, 'Contents/MacOS/Typing')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(ok)
}

const DOC = `# Features

| left | right |
| --- | --- |
| 1 | 2 |

- [ ] one open task
- [x] one done task

Paragraph for editing.
`

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function main() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'typing-features-'))
  const docPath = join(dir, 'feature-doc.md')
  await fs.writeFile(docPath, DOC, 'utf8')
  await fs.writeFile(join(dir, 'second.md'), '# Second\n', 'utf8')

  const userData = join(dir, 'user-data')
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, dir],
    env: { ...process.env, TYPING_TEST: '1' },
    timeout: 60000
  })
  const page = await app.firstWindow({ timeout: 60000 })
  const logs = []
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text())
  })
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))

  const read = () => fs.readFile(docPath, 'utf8')
  const save = async () => {
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(700)
  }
  const editorClick = async () => {
    await page.locator('.cm-content').click()
    await page.waitForTimeout(200)
  }

  try {
    await page.waitForSelector('.cm-content', { timeout: 30000 })
    await page.waitForTimeout(800)

    // ---- folder sidebar -------------------------------------------------
    const treeRows = await page.locator('.tree-row').count()
    check('folder sidebar lists the opened folder', treeRows >= 2, `${treeRows} rows`)
    const sidebarVisible = await page.evaluate(() => !document.querySelector('#sidebar').classList.contains('hidden'))
    check('sidebar is visible for a folder launch', sidebarVisible)

    // ---- quick open ------------------------------------------------------
    await page.keyboard.press('Meta+Shift+O')
    await page.waitForTimeout(400)
    const quickVisible = await page.locator('.quick-input').count()
    check('⌘⇧O opens quick open', quickVisible === 1)
    await page.keyboard.type('feature')
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    const title = await page.evaluate(() => document.title)
    check('quick open opens the chosen file', title.includes('feature-doc.md'), title)

    // ---- live preview widgets -------------------------------------------
    const tableWidget = await page.locator('.cm-table').count()
    check('GFM table renders as a table widget', tableWidget === 1)

    // Click the table widget: it should reveal editable markdown source.
    await page.locator('.cm-table').click()
    await page.waitForTimeout(500)
    const rawTable = await page.locator('.cm-table-raw').count()
    check('clicking a table shows its markdown source', rawTable > 0, `${rawTable} raw lines`)

    // Add a row via the Table menu command.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('typing:event', 'menu:command', { command: 'table.addRowBelow' })
    })
    await page.waitForTimeout(400)
    await save()
    const afterRow = await read()
    const rowCount = afterRow.split('\n').filter((l) => l.trim().startsWith('|')).length
    check('table row insertion edits the markdown', rowCount === 4, `${rowCount} pipe rows`)

    // ---- task list checkbox ---------------------------------------------
    await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')
      scroller.scrollTop = 0
    })
    await page.waitForTimeout(600)
    const boxes = await page.locator('.cm-task input').count()
    check('task list renders checkboxes', boxes === 2, `${boxes} boxes`)
    if (boxes) {
      await page.locator('.cm-task input').first().click({ force: true })
      await page.waitForTimeout(400)
      await save()
      const afterTask = await read()
      check('toggling a checkbox rewrites the task marker', afterTask.includes('- [x] one open task'), afterTask.match(/- \[.\]/g)?.join(' '))
    }

    // ---- IME composition ------------------------------------------------
    await editorClick()
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.press('Enter')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
    await page.waitForTimeout(120)
    await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
    await page.waitForTimeout(120)
    await cdp.send('Input.insertText', { text: '你好，世界。' })
    await page.waitForTimeout(400)
    await save()
    const afterIme = await read()
    check('Chinese IME composition commits cleanly', afterIme.includes('你好，世界。'), afterIme.slice(-40).replace(/\n/g, '\\n'))

    // ---- image paste -----------------------------------------------------
    const pasted = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const file = new File([bytes], 'pixel.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: dt })
      document.querySelector('.cm-content').dispatchEvent(event)
      await new Promise((r) => setTimeout(r, 1200))
      return true
    }, PNG_1x1)
    await page.waitForTimeout(1200)
    await save()
    const afterImage = await read()
    const assetsDir = join(dir, 'assets')
    const assetFiles = existsSync(assetsDir) ? await fs.readdir(assetsDir) : []
    check('pasted image is saved into assets/', Boolean(pasted) && assetFiles.length > 0, assetFiles.join(', '))
    check('markdown gets a relative image link', /!\[[^\]]*\]\(assets\/[^)]+\)/.test(afterImage), (afterImage.match(/!\[[^\]]*\]\([^)]*\)/) ?? [''])[0])

    // ---- autosave --------------------------------------------------------
    await editorClick()
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type('AUTOSAVE-MARK')
    await page.waitForTimeout(2600)
    const afterAuto = await read()
    check('autosave writes changes without ⌘S', afterAuto.includes('AUTOSAVE-MARK'))

    // ---- external file change -------------------------------------------
    await page.keyboard.type(' local edit')
    await page.waitForTimeout(300)
    await fs.writeFile(docPath, DOC + '\n\nEdited by another program.\n', 'utf8')
    await page.waitForTimeout(2600)
    const bannerVisible = await page.evaluate(() => !document.querySelector('#banner').classList.contains('hidden'))
    const bannerText = await page.evaluate(() => document.querySelector('#banner')?.textContent ?? '')
    check('external change raises a non-destructive prompt', bannerVisible && /changed on disk/i.test(bannerText), bannerText.slice(0, 60))
    const diskNow = await read()
    check('external content was not silently overwritten', diskNow.includes('Edited by another program.'))

    // Keep the local version: it must land in a conflict copy, not overwrite.
    const keepBtn = page.locator('#banner button', { hasText: 'Keep mine' })
    if (await keepBtn.count()) {
      await keepBtn.click()
      await page.waitForTimeout(1200)
    }
    const files = await fs.readdir(dir)
    const conflict = files.find((f) => f.includes('conflict'))
    check('keeping local edits writes a conflict copy', Boolean(conflict), conflict ?? files.join(', '))
    const original = await read()
    check('the original file still holds the other program\'s text', original.includes('Edited by another program.'))

    // ---- export ----------------------------------------------------------
    const exportHtmlPath = join(dir, 'export-test.html')
    const exportPdfPath = join(dir, 'export-test.pdf')
    const exportHtml = await page.evaluate(() => window.typingExportHtml())
    check('HTML export is produced in the renderer', typeof exportHtml === 'string' && exportHtml.length > 500, `${exportHtml?.length ?? 0} chars`)
    const htmlResult = await page.evaluate(
      async ({ html, target }) => window.typing.call('export.html', { html, path: target }),
      { html: exportHtml, target: exportHtmlPath }
    )
    check('HTML export writes a file', htmlResult?.ok === true, JSON.stringify(htmlResult).slice(0, 80))
    const exported = await fs.readFile(exportHtmlPath, 'utf8').catch(() => '')
    check('exported HTML keeps rendered maths', exported.includes('katex'))
    check('exported HTML has no remote resources', !/<(img|script|link)[^>]+src="https?:/.test(exported))
    const pdfResult = await page.evaluate(
      async ({ html, target }) => window.typing.call('export.pdf', { html, path: target }),
      { html: exportHtml, target: exportPdfPath }
    )
    const pdfBytes = await fs.readFile(exportPdfPath).catch(() => Buffer.alloc(0))
    check('PDF export writes a valid PDF', pdfResult?.ok && pdfBytes.subarray(0, 5).toString() === '%PDF-', `${pdfBytes.length} bytes`)

    // ---- source fidelity on the corpus --------------------------------
    const corpusDir = join(projectRoot, 'test/corpus')
    const corpusFiles = (await fs.readdir(corpusDir)).filter((f) => f.endsWith('.md')).sort()
    let fidelityOk = 0
    const fidelityProblems = []
    for (const name of corpusFiles) {
      const source = join(corpusDir, name)
      const target = join(dir, `fidelity-${name}`)
      await fs.copyFile(source, target)
      const bytesBefore = await fs.readFile(target)
      const statBefore = await fs.stat(target)
      await page.evaluate(async (p) => window.__typingTest.openFile(p), target)
      await page.waitForTimeout(250)
      await page.evaluate(() => window.__typingTest.focus())
      await page.keyboard.press('Meta+s')
      await page.waitForTimeout(320)
      const bytesAfter = await fs.readFile(target)
      const statAfter = await fs.stat(target)
      if (Buffer.compare(bytesBefore, bytesAfter) === 0) fidelityOk++
      else fidelityProblems.push(`${name}: bytes changed`)
      if (statBefore.mtimeMs !== statAfter.mtimeMs) fidelityProblems.push(`${name}: rewritten (mtime)`)
    }
    check(
      `open + save is byte-identical for all ${corpusFiles.length} corpus files`,
      fidelityOk === corpusFiles.length && fidelityProblems.length === 0,
      fidelityProblems.slice(0, 3).join(' | ')
    )

    // CRLF files keep CRLF after an edit.
    const crlfPath = join(dir, 'crlf.md')
    await fs.writeFile(crlfPath, '# CRLF\r\n\r\nline one\r\nline two\r\n', 'utf8')
    await page.evaluate(async (p) => window.__typingTest.openFile(p), crlfPath)
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__typingTest.focus())
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type('X')
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(600)
    const crlfBytes = await fs.readFile(crlfPath)
    const crlfText = crlfBytes.toString('utf8')
    check(
      'editing a CRLF file keeps CRLF line endings',
      crlfText.includes('line two\r\n') && crlfText.includes('X') && !/[^\r]\n/.test(crlfText),
      JSON.stringify(crlfText.slice(-18))
    )

    // A BOM survives an edit and is not duplicated.
    const bomPath = join(dir, 'bom.md')
    await fs.writeFile(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\n\ntext\n', 'utf8')]))
    await page.evaluate(async (p) => window.__typingTest.openFile(p), bomPath)
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__typingTest.focus())
    await page.keyboard.type('!')
    await page.waitForTimeout(150)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(600)
    const bomBytes = await fs.readFile(bomPath)
    const bomCount = [...bomBytes].filter((b, i) => i < 3 && b === 0xef).length
    check(
      'a UTF-8 BOM survives editing exactly once',
      bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf && bomCount === 1 && bomBytes.toString('utf8').includes('!'),
      `${bomBytes.length} bytes`
    )

    // ---- closing with unsaved changes ---------------------------------
    await page.evaluate(() => window.__typingTest.focus())
    await page.keyboard.type('unsaved closing test')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(600)
    const closeDialogTitle = await page.evaluate(() => document.querySelector('.dialog h2')?.textContent ?? '')
    check('⌘W with unsaved changes asks before closing', /unsaved/i.test(closeDialogTitle), closeDialogTitle)
    const cancelBtn = page.locator('.dialog .btn', { hasText: 'Cancel' })
    if (await cancelBtn.count()) await cancelBtn.click()
    await page.waitForTimeout(400)
    check('cancelling keeps the document open', (await page.locator('.cm-content').count()) === 1)

    check('no renderer errors', logs.length === 0, logs.slice(0, 2).join(' | '))
  } finally {
    if (logs.length) {
      console.log('\nRenderer errors:')
      for (const l of logs.slice(0, 10)) console.log('   ', l)
    }
    await app.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('feature test crashed:', err)
  process.exitCode = 1
})