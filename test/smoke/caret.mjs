#!/usr/bin/env node
/**
 * Pointer/caret alignment checks against the packaged app.
 *
 * The documented bug: while editing with the mouse the text caret (and the end
 * of a drag selection) landed well below the pointer. CodeMirror builds its
 * height map from the *border box* of every line
 * (`getBoundingClientRect().height`), so vertical space that sits outside those
 * boxes — a `margin-top` on a heading line, the margins of the collapsed
 * front-matter chip — is space the editor cannot see. Every such pixel above
 * the click point moves the document position the click maps to further down,
 * and the caret is drawn lower than the pointer.
 *
 * This suite pins both halves of that:
 *
 *  1. geometry: `.cm-content` must contain no vertical space outside the boxes
 *     CodeMirror measures (padding is fine, margins are not);
 *  2. behaviour: real mouse input must place the caret on the line under the
 *     pointer, and a real drag selection must end on the line under the mouse.
 *
 * Checks 1 and 2 fail on the pre-fix build (offsets grow with every heading
 * above the click point) and pass on the fixed one. Source mode is included as
 * the proven-good control: it has no heading/​chip decorations, so it never
 * drifted.
 *
 *   node test/smoke/caret.mjs [path-to-Typing.app]
 */
import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
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

/** Headings above plain text: the arrangement that drifted the most. */
const HEADINGS_DOC = `# Alpha
para one.
para two.
## Beta
para three.
para four.
### Gamma
para five.
para six.
## Delta
para seven.
para eight.
# Epsilon
para nine.
para ten.
## Zeta
para eleven.
para twelve.
### Eta
para thirteen.
para fourteen.
## Theta
para fifteen.
para sixteen.
`

/** Front matter (collapsed to a chip once the caret leaves it) + headings. */
const FRONTMATTER_DOC = `---
title: Caret alignment
tags: [pointer, caret]
---
intro paragraph.
# One
body one.
## Two
body two.
### Three
body three.
## Four
body four.
# Five
body five.
## Six
body six.
`

/** Everything the live preview replaces with a widget, plus heading rhythm. */
const MIXED_DOC = `---
title: Mixed
---
# Mixed document
Opening paragraph with **bold** and \`inline code\`.

## Table
| a | b |
| --- | --- |
| 1 | 2 |

## Tasks
- [ ] open task
- [x] done task

## Code
\`\`\`js
const x = 1
\`\`\`

## Maths
$e^{i\\pi} + 1 = 0$

## Quote
> quoted line

## Rule
---

Closing paragraph.
`

/** Long document: scrolled mid-way, many headings above the click point. */
const LONG_DOC = (() => {
  const parts = []
  for (let i = 1; i <= 60; i++) {
    parts.push(`# Section ${i}`)
    parts.push(`paragraph ${i} first line of text.`)
    parts.push(`paragraph ${i} second line of text.`)
    parts.push(`## Subsection ${i}`)
    parts.push(`paragraph ${i} third line of text.`)
  }
  return parts.join('\n') + '\n'
})()

/** Marker-insensitive identity for a line, so an active heading can be re-read. */
const normaliseLine = (text) => text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

async function launch(dir, docName, doc, extraArgs = [], openFolder = false) {
  const docPath = join(dir, docName)
  if (doc !== null) await fs.writeFile(docPath, doc, 'utf8')
  // A folder launch opens the file sidebar, which shifts and narrows the page.
  const target = openFolder ? dir : docPath
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(dir, `user-data-${docName}`)}`, ...extraArgs, target],
    env: { ...process.env, TYPING_TEST: '1' },
    timeout: 60000
  })
  const page = await app.firstWindow({ timeout: 60000 })
  const logs = []
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text())
  })
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
  await page.waitForSelector('.cm-content', { timeout: 30000 })
  if (openFolder) {
    await page.waitForFunction(() => Boolean(window.__typingTest), null, { timeout: 30000 })
    await page.waitForSelector('.tree-row', { timeout: 30000 })
  } else {
    await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 2, null, { timeout: 30000 })
  }
  // Give the window real focus: an inactive window can swallow the first
  // injected click, which would look like the bug this suite looks for.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.show()
    win.focus()
    win.webContents.focus()
  })
  await page.bringToFront()
  await page.waitForTimeout(900)
  if (openFolder) {
    await page.evaluate(async (p) => window.__typingTest.openFile(p), docPath)
    await page.waitForTimeout(900)
  }
  return { app, page, logs, docPath }
}

/** Real Electron input event: goes through the same hit-testing as a click. */
async function sendInputEvent(app, type, x, y) {
  await app.evaluate(
    ({ BrowserWindow }, p) =>
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
        type: p.type,
        x: Math.round(p.x),
        y: Math.round(p.y),
        button: 'left',
        clickCount: 1
      }),
    { type, x, y }
  )
}

async function menuCommand(app, command) {
  await app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send('typing:event', 'menu:command', { command: c })
  }, command)
  await new Promise((r) => setTimeout(r, 600))
}

/**
 * Ask the renderer for the next line worth clicking: a visible line whose
 * centre point really hits that line, which has not been clicked yet, and which
 * holds no live-preview widget (widgets consume the click themselves).
 */
async function sampleTarget(page, seen) {
  return page.evaluate((seenKeys) => {
    const content = document.querySelector('.cm-content')
    if (!content) return null
    const cr = content.getBoundingClientRect()
    const x = Math.round(cr.left + Math.min(cr.width * 0.3, 220))
    // Lines that hold a live-preview widget consume the click themselves, so
    // they cannot be used to test where CodeMirror maps a pointer to a
    // position.
    const skipClass = /cm-(frontmatter|table|mermaid|math-block|math-inline|hr-wrap|image|task)/
    const skipContent = /(cm-frontmatter|cm-table|cm-mermaid|cm-math|cm-hr-wrap|cm-image|cm-task|katex|<input)/
    for (const el of document.querySelectorAll('[data-caret-target]')) el.removeAttribute('data-caret-target')
    const out = []
    for (const line of document.querySelectorAll('.cm-line')) {
      const r = line.getBoundingClientRect()
      const y = Math.round(r.top + r.height / 2)
      if (r.height < 8 || r.top < 0 || r.bottom > innerHeight - 2) continue
      if (y < 2 || y > innerHeight - 2) continue
      if (skipClass.test(line.className) || skipContent.test(line.innerHTML)) continue
      const hit = document.elementFromPoint(x, y)
      if (!hit || hit.closest('.cm-line') !== line) continue
      const text = line.textContent
      const key = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
      if (!key || seenKeys.includes(key)) continue
      out.push({ el: line, x, y, top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), text, key })
    }
    if (!out.length) return null
    const chosen = out[Math.floor(out.length / 2)]
    // Tag the line so the check can tell which line the caret ended up in even
    // when its markup changes (markers and badges come and go).
    chosen.el.setAttribute('data-caret-target', '1')
    return { x: chosen.x, y: chosen.y, top: chosen.top, bottom: chosen.bottom, text: chosen.text, key: chosen.key }
  }, seen)
}

/** Where did the drawn caret end up? */
async function readCaret(page) {
  return page.evaluate(() => {
    const cursor = document.querySelector('.cm-cursor')
    const lines = [...document.querySelectorAll('.cm-line')]
    const rects = lines.map((l) => {
      const r = l.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, text: l.textContent, marked: l.hasAttribute('data-caret-target') }
    })
    const c = cursor?.getBoundingClientRect()
    const centre = c ? c.top + c.height / 2 : null
    const hit = centre == null ? null : rects.find((r) => centre >= r.top && centre <= r.bottom)
    const selection = [...document.querySelectorAll('.cm-selectionBackground')].map((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    return {
      caret: c ? { top: +c.top.toFixed(1), height: +c.height.toFixed(1), centre: +centre.toFixed(1) } : null,
      lineText: hit?.text ?? null,
      onTarget: hit?.marked ?? false,
      selectionBottom: selection.length ? +Math.max(...selection.map((s) => s.bottom)).toFixed(1) : null
    }
  })
}

/**
 * Poll until the drawn caret reacts to the click (it moved, or it is already on
 * the intended line), then return that reading.
 */
async function waitForCaretUpdate(page, target, before) {
  const want = normaliseLine(target.text)
  let reading = await readCaret(page)
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const got = reading.lineText === null ? null : normaliseLine(reading.lineText)
    const moved =
      reading.caret !== null &&
      (before.caret === null ||
        Math.abs(reading.caret.centre - before.caret.centre) > 1 ||
        Math.abs(reading.caret.top - before.caret.top) > 1)
    if (moved || reading.onTarget || (got !== null && want !== '' && (got === want || got.includes(want)))) {
      // Let a scrolled/re-measured layout settle before believing the reading.
      await page.waitForTimeout(150)
      const settled = await readCaret(page)
      if (settled.caret === null || Math.abs(settled.caret.centre - reading.caret.centre) < 1.5) return settled
      reading = settled
      continue
    }
    await page.waitForTimeout(60)
    reading = await readCaret(page)
  }
  return reading
}

/**
 * Click the centre of every eligible visible line and compare the drawn caret
 * with the line that was clicked.
 */
async function clickSweep(app, page, label) {
  const seen = []
  const rows = []
  for (let guard = 0; guard < 40; guard++) {
    const target = await sampleTarget(page, seen)
    if (!target) break
    seen.push(target.key)
    const before = await readCaret(page)
    // Between sampling and clicking, scrolling (typewriter mode) or a
    // re-measure can move the line. Only click when the point still resolves to
    // the line we sampled; otherwise skip it and pick another one.
    const stillValid = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)?.closest('.cm-line')
      return hit?.hasAttribute('data-caret-target') === true
    }, target)
    if (!stillValid) continue
    await sendInputEvent(app, 'mouseDown', target.x, target.y)
    await sendInputEvent(app, 'mouseUp', target.x, target.y)
    // Wait for the click to land instead of guessing a delay: the caret must
    // move (to the right line or, on a broken build, to a wrong one). Under
    // load a fixed delay read the old caret and reported a false failure.
    const after = await waitForCaretUpdate(page, target, before)
    const want = normaliseLine(target.text)
    const got = after.lineText === null ? null : normaliseLine(after.lineText)
    const drift = after.caret ? after.caret.centre - target.y : null
    // The tag on the clicked line is the primary signal. Clicking a code block
    // makes it active, which removes its language badge and re-renders the line
    // (the tag goes with it), so fall back to comparing the text — one side may
    // carry a badge the other does not.
    const textMatches =
      got !== null &&
      want !== '' &&
      (got === want || (want.length >= 4 && (got.includes(want) || want.includes(got))))
    rows.push({
      text: target.text.replace(/\s+/g, ' ').trim().slice(0, 24),
      clickY: target.y,
      caretTop: after.caret?.top ?? null,
      drift: drift === null ? null : +drift.toFixed(1),
      ok: after.onTarget || textMatches,
      debug: { onTarget: after.onTarget, lineText: (after.lineText ?? 'null').slice(0, 20), centre: after.caret?.centre ?? null }
    })
  }
  const good = rows.filter((r) => r.ok).length
  const drifts = rows.map((r) => Math.abs(r.drift ?? 999))
  const worst = drifts.length ? Math.max(...drifts) : 0
  const offenders = rows.filter((r) => !r.ok).slice(0, 4)
  check(
    `${label}: caret lands on the line under the pointer (${good}/${rows.length} clicks)`,
    rows.length >= 5 && good === rows.length,
    `worst |caret − click| ${worst.toFixed(1)}px (diagnostic)` +
      (offenders.length
        ? ` | e.g. clicked "${offenders[0].text}" at y=${offenders[0].clickY}, caret ${offenders[0].drift}px lower, landed on "${offenders[0].debug.lineText}" (tagged ${offenders[0].debug.onTarget}, centre ${offenders[0].debug.centre})`
        : '')
  )
  return rows
}

/** Drag from one line to another with real pointer input and check the head. */
async function dragCheck(page, label) {
  // Pick two visible lines by viewport position, so a scrolled document still
  // has reachable targets.
  const geometry = await page.evaluate(() => {
    const cr = document.querySelector('.cm-content').getBoundingClientRect()
    const x = Math.round(cr.left + Math.min(cr.width * 0.3, 220))
    const top = Math.max(0, cr.top)
    const bottom = Math.min(innerHeight, cr.bottom)
    const lines = [...document.querySelectorAll('.cm-line')]
      .map((line) => {
        const r = line.getBoundingClientRect()
        return { y: Math.round(r.top + r.height / 2), top: r.top, bottom: r.bottom, text: line.textContent }
      })
      .filter((l) => l.top >= top + 2 && l.bottom <= bottom - 2 && l.y > 4 && l.y < innerHeight - 4)
      .sort((a, b) => a.y - b.y)
    const at = (fraction) =>
      lines.length
        ? lines.reduce((best, l) =>
            Math.abs(l.y - (top + (bottom - top) * fraction)) < Math.abs(best.y - (top + (bottom - top) * fraction))
              ? l
              : best
          )
        : null
    const from = at(0.25)
    const to = at(0.7)
    return { x, from, to }
  })
  if (!geometry.from || !geometry.to || geometry.from === geometry.to) {
    return check(`${label}: drag selection ends on the line under the pointer`, false, 'no reachable target lines')
  }
  const target = {
    from: { x: geometry.x, y: geometry.from.y },
    to: { x: geometry.x, y: geometry.to.y },
    top: +geometry.to.top.toFixed(1),
    bottom: +geometry.to.bottom.toFixed(1),
    text: geometry.to.text.replace(/\s+/g, ' ').trim().slice(0, 24)
  }
  await page.mouse.move(target.from.x, target.from.y)
  await page.mouse.down()
  await page.mouse.move(target.to.x, target.to.y, { steps: 10 })
  await page.mouse.up()
  // Wait for the drawn selection to appear rather than guessing a delay.
  let after = await readCaret(page)
  for (let i = 0; i < 25 && after.selectionBottom === null; i++) {
    await page.waitForTimeout(60)
    after = await readCaret(page)
  }
  const headInLine =
    after.caret !== null && after.caret.centre >= target.top - 2 && after.caret.centre <= target.bottom + 2
  const selectionInside = after.selectionBottom === null || after.selectionBottom <= target.bottom + 2
  const drift = after.caret ? +(after.caret.centre - target.to.y).toFixed(1) : null
  return check(
    `${label}: drag selection ends on the line under the pointer`,
    headInLine && selectionInside,
    `released on "${target.text}" at y=${target.to.y} (line ${target.top}–${target.bottom}), head ${
      drift === null ? 'not drawn' : `${drift}px away`
    }, selection bottom ${after.selectionBottom ?? 'n/a'}`
  )
}

/**
 * The root-cause invariant: no vertical space inside `.cm-content` that is
 * outside the boxes CodeMirror measures. Padding is measured, margins are not.
 */
async function measureUnmeasuredSpace(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    const style = getComputedStyle(content)
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const height = content.getBoundingClientRect().height
    const children = [...content.children].filter((el) => !/cm-widgetBuffer/.test(el.className))
    const boxes = children.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
    const margins = children.reduce((sum, el) => {
      const cs = getComputedStyle(el)
      return sum + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)
    }, 0)
    return {
      contentHeight: +height.toFixed(1),
      padding: +pad.toFixed(1),
      boxesSum: +boxes.toFixed(1),
      childMargins: +margins.toFixed(1),
      // Anything left over is vertical space outside every box CodeMirror
      // measures; a vertical margin is exactly such space.
      unmeasured: +(height - pad - boxes).toFixed(1)
    }
  })
}

async function main() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'typing-caret-'))
  console.log(`Launching ${executablePath}`)

  // ---- 1. WYSIWYG with heading rhythm ------------------------------------
  {
    const { app, page, logs } = await launch(dir, 'headings.md', HEADINGS_DOC)
    try {
      await clickSweep(app, page, 'wysiwyg headings')
      await dragCheck(page, 'wysiwyg headings')
      const space = await measureUnmeasuredSpace(page)
      check(
        'wysiwyg headings: no vertical space CodeMirror cannot measure',
        Math.abs(space.unmeasured) <= 1,
        `unmeasured ${space.unmeasured}px (content ${space.contentHeight}, padding ${space.padding}, line boxes ${space.boxesSum}, margins ${space.childMargins})`
      )
      check('wysiwyg headings: no renderer errors', logs.length === 0, logs.slice(0, 2).join(' | '))
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 2. Front matter collapsed to a chip -------------------------------
  {
    const { app, page } = await launch(dir, 'frontmatter.md', FRONTMATTER_DOC)
    try {
      // Click into the body: the front matter then collapses to its chip.
      await sendInputEvent(app, 'mouseDown', 300, 260)
      await sendInputEvent(app, 'mouseUp', 300, 260)
      await page.waitForTimeout(400)
      const chip = await page.locator('.cm-frontmatter').count()
      check('front matter collapses to a chip when the caret leaves it', chip === 1, `${chip} chips`)
      await page.evaluate(() => {
        document.querySelector('.cm-scroller').scrollTop = 0
      })
      await page.waitForTimeout(300)
      await clickSweep(app, page, 'wysiwyg front matter chip')
      const space = await measureUnmeasuredSpace(page)
      check(
        'front matter chip: no vertical space CodeMirror cannot measure',
        Math.abs(space.unmeasured) <= 1,
        `unmeasured ${space.unmeasured}px (margins ${space.childMargins})`
      )
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 3. Source mode: the proven-good control ---------------------------
  {
    const { app, page } = await launch(dir, 'source.md', HEADINGS_DOC)
    try {
      await page.evaluate(() => window.__typingTest.focus())
      await page.keyboard.press('ControlOrMeta+/')
      await page.waitForTimeout(500)
      const decorated = await page.evaluate(() => document.querySelectorAll('.cm-heading').length)
      check('source mode removes heading decorations', decorated === 0, `${decorated} decorated lines`)
      await clickSweep(app, page, 'source mode')
      const space = await measureUnmeasuredSpace(page)
      check(
        'source mode: no vertical space CodeMirror cannot measure',
        Math.abs(space.unmeasured) <= 1,
        `unmeasured ${space.unmeasured}px`
      )
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 4. Long document, scrolled into the middle ------------------------
  {
    const { app, page } = await launch(dir, 'long.md', LONG_DOC)
    try {
      await page.evaluate(() => {
        const scroller = document.querySelector('.cm-scroller')
        scroller.scrollTop = scroller.scrollHeight * 0.55
      })
      await page.waitForTimeout(600)
      await clickSweep(app, page, 'long document scrolled')
      await dragCheck(page, 'long document scrolled')
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 5. Mixed widgets, focus and typewriter mode ----------------------
  {
    const { app, page } = await launch(dir, 'mixed.md', MIXED_DOC)
    try {
      // The outline panel is on by default; sweep once with it and once without.
      const outlineShown = await page.evaluate(
        () => !document.querySelector('#outline')?.classList.contains('hidden')
      )
      check('outline panel is visible by default', outlineShown)
      await clickSweep(app, page, 'wysiwyg with outline panel')
      await menuCommand(app, 'view.outline')
      const outlineHidden = await page.evaluate(
        () => document.querySelector('#outline')?.classList.contains('hidden')
      )
      check('outline panel can be removed from the layout', outlineHidden)
      await clickSweep(app, page, 'wysiwyg without outline panel')

      await menuCommand(app, 'view.focus')
      await menuCommand(app, 'view.typewriter')
      const modes = await page.evaluate(() => ({
        focus: document.documentElement.classList.contains('focus-mode'),
        source: document.documentElement.classList.contains('source-mode')
      }))
      check('focus mode is on and the document is still in wysiwyg', modes.focus && !modes.source, JSON.stringify(modes))
      await clickSweep(app, page, 'wysiwyg focus + typewriter')
      const space = await measureUnmeasuredSpace(page)
      check(
        'mixed document: no vertical space CodeMirror cannot measure',
        Math.abs(space.unmeasured) <= 1.5,
        `unmeasured ${space.unmeasured}px (widgets included)`
      )
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 6. Window sizes ---------------------------------------------------
  for (const [w, h] of [
    [700, 480],
    [1440, 900]
  ]) {
    const { app, page } = await launch(dir, `size-${w}x${h}.md`, HEADINGS_DOC)
    try {
      await app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h)
      }, { w, h })
      await page.waitForTimeout(700)
      const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
      check(`window resizes to ${w}x${h}`, Math.abs(size.w - w) <= 2 && Math.abs(size.h - h) <= 40, JSON.stringify(size))
      await clickSweep(app, page, `window ${w}x${h}`)
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 7. Folder sidebar open ------------------------------------------
  {
    const { app, page } = await launch(dir, 'sidebar.md', HEADINGS_DOC, [], true)
    try {
      const sidebar = await page.evaluate(() => !document.querySelector('#sidebar')?.classList.contains('hidden'))
      const heading = await page.evaluate(async () => {
        const title = document.querySelector('#doc-title')?.textContent ?? ''
        return { title, styled: document.querySelectorAll('.cm-heading').length }
      })
      check('folder launch shows the sidebar and the opened document', sidebar && heading.styled > 0, JSON.stringify(heading))
      await clickSweep(app, page, 'wysiwyg with folder sidebar')
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ---- 7. Retina-scale factor ------------------------------------------
  {
    const { app, page } = await launch(dir, 'retina.md', HEADINGS_DOC, ['--force-device-scale-factor=2'])
    try {
      const dpr = await page.evaluate(() => devicePixelRatio)
      check('second launch runs at devicePixelRatio 2', dpr === 2, `dpr ${dpr}`)
      if (dpr === 2) await clickSweep(app, page, 'display scale factor 2')
    } finally {
      await app.close().catch(() => {})
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('Failures:')
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`)
    process.exitCode = 1
  }

  // Every app instance has been closed above; exit explicitly so a lingering
  // child process handle cannot hang the run after the results are printed.
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('caret test crashed:', err)
  process.exitCode = 1
})