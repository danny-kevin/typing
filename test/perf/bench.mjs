#!/usr/bin/env node
/**
 * Performance check on the packaged app: launch time, keystroke latency and
 * scroll frame time for a ~100 KB everyday document and a ~1 MB stress document.
 *
 *   node test/perf/bench.mjs [path-to-Typing.app]
 *
 * Hygiene rules for this script (it used to use a fixed /tmp path and a global
 * `pkill -f`, which could kill unrelated processes and could hang forever):
 *
 *  - every run works in its own `mkdtemp` directory and removes it afterwards,
 *  - it only ever signals the Electron processes it launched itself (and their
 *    descendants, resolved from `ps`), never anything else on the machine,
 *  - it has a per-document timeout and an overall watchdog, and both kill the
 *    processes this run owns before exiting non-zero.
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const appPath = process.argv[2] ?? join(projectRoot, 'release/mac-arm64/Typing.app')
const executablePath = join(appPath, 'Contents/MacOS/Typing')

/** Hard ceilings so this script can never hang the caller. */
const DOC_TIMEOUT_MS = 150_000
const WATCHDOG_MS = 300_000

/** The processes this run started; nothing else is ever signalled. */
const startedPids = new Set()
let runDir = null
let finished = false

function track(proc) {
  const pid = proc?.pid
  if (!pid) return
  startedPids.add(pid)
  proc.once('exit', () => startedPids.delete(pid))
}

/** Our pids plus every descendant, resolved from ps (never by name pattern). */
function ownedPids() {
  if (!startedPids.size) return []
  let rows
  try {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return [...startedPids]
  }
  const children = new Map()
  for (const line of rows.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const out = []
  const queue = [...startedPids]
  while (queue.length) {
    const pid = queue.shift()
    if (out.includes(pid)) continue
    out.push(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  // Children before parents so the tree goes away cleanly.
  return out.reverse()
}

function killOwned() {
  for (const pid of ownedPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  startedPids.clear()
}

async function cleanup() {
  killOwned()
  if (runDir) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {})
    runDir = null
  }
}

const watchdog = setTimeout(() => {
  if (finished) return
  console.error(`\nbench timed out after ${WATCHDOG_MS / 1000}s — stopping this run's Electron processes`)
  void cleanup().then(() => process.exit(3))
}, WATCHDOG_MS)

function stats(values) {
  if (!values.length) return { median: 0, p95: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    median: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1))
  }
}

async function measure(file, label) {
  const started = Date.now()
  const userData = await fs.mkdtemp(join(runDir, `user-data-${label}-`))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, file],
    timeout: 120000
  })
  track(app.process())
  try {
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

    return { file: file.split('/').pop(), launchMs, latency: stats(latency), scroll: stats(scroll), content, errors }
  } finally {
    // Close politely, then make sure the process this run started is gone.
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    killOwned()
  }
}

/** Run one measurement, but never let it run past DOC_TIMEOUT_MS. */
async function measureBounded(file, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      killOwned()
      reject(new Error(`${file} did not finish in ${DOC_TIMEOUT_MS / 1000}s`))
    }, DOC_TIMEOUT_MS)
  })
  try {
    return await Promise.race([measure(file, label), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  runDir = await fs.mkdtemp(join(tmpdir(), 'typing-perf-'))
  console.log(`work directory: ${runDir}`)
  execFileSync('node', [join(here, 'generate.mjs')], { stdio: 'inherit' })
  const generated = join(here, 'generated')

  const files = [
    { path: join(generated, 'everyday-100kb.md'), label: 'everyday' },
    { path: join(generated, 'stress-1mb.md'), label: 'stress' }
  ]
  const report = []
  for (const { path, label } of files) {
    console.log(`\nMeasuring ${path}`)
    const result = await measureBounded(path, label)
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
}

try {
  await main()
  finished = true
  clearTimeout(watchdog)
  await cleanup()
  process.exit(0)
} catch (err) {
  finished = true
  clearTimeout(watchdog)
  console.error('\nbench failed:', err?.message ?? err)
  await cleanup()
  process.exit(1)
}