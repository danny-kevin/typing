#!/usr/bin/env node
/**
 * Performance check on the packaged app: launch time, keystroke latency and
 * scroll frame time for a ~100 KB everyday document and a ~1 MB stress document.
 *
 *   node test/perf/bench.mjs [path-to-Typing.app]
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const appPath = process.argv[2] ?? join(projectRoot, 'release/mac-arm64/Typing.app')
const executablePath = join(appPath, 'Contents/MacOS/Typing')

execFileSync('node', [join(here, 'generate.mjs')], { stdio: 'inherit' })
const generated = join(here, 'generated')

const stats = (values) => {
  if (!values.length) return { median: 0, p95: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    median: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1))
  }
}

async function measure(file) {
  const started = Date.now()
  const userData = await fs.mkdtemp(join('/tmp', 'typing-perf-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, file],
    timeout: 120000
  })
  const page = await app.firstWindow({ timeout: 120000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.cm-content', { timeout: 120000 })
  await page.waitForFunction(
    () => !document.querySelector('#doc-title')?.textContent?.includes('Untitled'),
    null,
    { timeout: 120000 }
  )
  const launchMs = Date.now() - started
  await page.waitForTimeout(1500)

  // Keystroke → next animation frame latency, measured in the renderer.
  await page.locator('.cm-content').click()
  await page.evaluate(() => {
    window.__latency = []
    document.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now()
        requestAnimationFrame(() => window.__latency.push(performance.now() - t0))
      },
      true
    )
  })
  for (let i = 0; i < 25; i++) {
    await page.keyboard.type('x')
    await page.waitForTimeout(45)
  }
  const latency = await page.evaluate(() => window.__latency.slice(0, 25))

  // Scroll through the document, measuring frame time per step.
  const scroll = await page.evaluate(async () => {
    const scroller = document.querySelector('.cm-scroller')
    const frames = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      // One screen per step: how a reader actually scrolls.
      scroller.scrollTop += Math.round(scroller.clientHeight * 0.9)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      frames.push(performance.now() - t0)
    }
    return frames
  })

  const content = await page.evaluate(() => ({
    chars: document.querySelector('.cm-content')?.textContent?.length ?? 0,
    lines: document.querySelectorAll('.cm-line').length,
    widgets: document.querySelectorAll('.cm-table, .cm-mermaid, .cm-math-block').length
  }))

  await app.close()
  return { file: file.split('/').pop(), launchMs, latency: stats(latency), scroll: stats(scroll), content, errors }
}

const files = [join(generated, 'everyday-100kb.md'), join(generated, 'stress-1mb.md')]
const report = []
for (const file of files) {
  console.log(`\nMeasuring ${file}`)
  const result = await measure(file)
  report.push(result)
  console.log(
    `  launch ${result.launchMs}ms · typing median ${result.latency.median}ms p95 ${result.latency.p95}ms · ` +
      `scroll median ${result.scroll.median}ms p95 ${result.scroll.p95}ms`
  )
  console.log(`  rendered ${result.content.lines} lines, ${result.content.widgets} block widgets`)
  if (result.errors.length) console.log('  errors:', result.errors.slice(0, 3))
}

await fs.writeFile(join(here, 'last-run.json'), JSON.stringify(report, null, 2))
console.log('\nwrote test/perf/last-run.json')