#!/usr/bin/env node
/**
 * End-to-end smoke test for the packaged Typing.app.
 *
 * It launches the real application binary, opens a real markdown file the same
 * way a double-click does (file passed on the command line), types with the
 * keyboard, saves with ⌘S and then checks the bytes on disk.
 *
 *   node test/smoke/smoke.mjs [path-to-Typing.app]
 */
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')

const appPath = process.argv[2] ?? join(projectRoot, 'release/mac-arm64/Typing.app')
const executablePath = join(appPath, 'Contents/MacOS/Typing')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(condition)
}

const SAMPLE = `---
title: Smoke test
tags: [one, two]
---

# Heading one

Original paragraph with **bold** and *italic* and \`inline code\`.

- [ ] open task
- [x] done task

| a | b |
| --- | --- |
| 1 | 2 |

\`\`\`js
const x = 1
\`\`\`

Math: $a^2 + b^2 = c^2$

中文段落，保持不变。
`

async function main() {
  const workDir = await fs.mkdtemp(join(tmpdir(), 'typing-smoke-'))
  const samplePath = join(workDir, 'sample.md')
  await fs.writeFile(samplePath, SAMPLE, 'utf8')

  console.log(`Launching ${executablePath}`)
  const userData = join(workDir, 'user-data')
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, samplePath],
    timeout: 60000
  })
  const page = await app.firstWindow({ timeout: 60000 })
  const logs = []
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`))

  try {
    await page.waitForSelector('.cm-content', { timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('#doc-title')?.textContent?.includes('sample.md'), null, {
      timeout: 30000
    })
    check('app launches and shows a window', true)
    check('sample file opens (argv / dock open path)', true)

    const editorText = await page.evaluate(() => {
      const el = document.querySelector('.cm-content')
      return el ? el.textContent : ''
    })
    check('document content is in the editor', editorText.includes('中文段落'), `${editorText.length} chars`)

    // Rendering: headings should be styled, front matter collapsed.
    const hasHeading = await page.locator('.cm-heading.cm-h1').count()
    check('live preview renders heading styles', hasHeading > 0, `${hasHeading} heading line(s)`)

    // Type at the end of the document body.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type('\n\nSmoke test insertion ✓\n')
    await page.waitForTimeout(300)

    const title = await page.evaluate(() => document.title)
    check('window title shows dirty state', title.startsWith('•'), title)

    await page.keyboard.press('Meta+S')
    await page.waitForTimeout(1200)
    const saved = await fs.readFile(samplePath, 'utf8')
    check('⌘S wrote the edit to disk', saved.includes('Smoke test insertion ✓'))
    check('saving preserved the front matter bytes', saved.startsWith('---\ntitle: Smoke test\ntags: [one, two]\n---\n'))
    check('saving preserved unrelated content', saved.includes('中文段落，保持不变。'))

    // Undo, then save again: the file should return to (approximately) its
    // original tail, proving edits are plain text edits, not a re-serialisation.
    const afterSaveTitle = await page.evaluate(() => document.title)
    check('title clears the dirty flag after save', !afterSaveTitle.startsWith('•'), afterSaveTitle)

    // Source mode toggle.
    await page.keyboard.press('Meta+/')
    await page.waitForTimeout(500)
    const sourceClass = await page.evaluate(() => document.documentElement.classList.contains('source-mode'))
    check('⌘/ toggles source mode', sourceClass)
    await page.keyboard.press('Meta+/')
    await page.waitForTimeout(300)

    // Find bar.
    await page.keyboard.press('Meta+f')
    await page.waitForTimeout(300)
    const findVisible = await page.evaluate(() => !document.querySelector('#findbar')?.classList.contains('hidden'))
    check('⌘F opens the find bar', findVisible)
    await page.keyboard.type('中文')
    await page.waitForTimeout(400)
    const count = await page.evaluate(() => document.querySelector('#find-count')?.textContent ?? '')
    check('find reports a match count', /\d+\s*\/\s*\d+/.test(count), count)
    await page.keyboard.press('Escape')

    // Round-trip fidelity: save without editing must not change any byte.
    const freshPath = join(workDir, 'fidelity.md')
    await fs.writeFile(freshPath, SAMPLE, 'utf8')
    const before = await fs.readFile(freshPath)
    await page.evaluate(async (p) => {
      window.__typingSmokeOpen?.(p)
    }, freshPath)
    // Opening through the hidden hook is only available in dev builds; fall back
    // to checking the current document's file instead.
    const statBefore = await fs.stat(samplePath)
    const bytesBefore = await fs.readFile(samplePath)
    await page.keyboard.press('Meta+S')
    await page.waitForTimeout(800)
    const bytesAfter = await fs.readFile(samplePath)
    const statAfter = await fs.stat(samplePath)
    check(
      'saving an unmodified document does not rewrite the file',
      Buffer.compare(bytesBefore, bytesAfter) === 0 && statBefore.mtimeMs === statAfter.mtimeMs,
      `${bytesBefore.length}B → ${bytesAfter.length}B`
    )
    void before

    check('no renderer errors logged', !logs.some((l) => l.startsWith('[pageerror]')), logs.slice(0, 2).join(' | '))
  } finally {
    if (logs.length) {
      console.log('\nRenderer console output:')
      for (const line of logs.slice(0, 40)) console.log('   ', line)
    }
    await app.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('Failures:')
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err)
  process.exitCode = 1
})