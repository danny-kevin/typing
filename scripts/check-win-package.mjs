#!/usr/bin/env node
/**
 * Verifies the Windows package produced by `npm run package:win`.
 *
 * Nothing here runs the app — no Windows machine is involved. It checks the
 * artefact by inspection:
 *
 *  - `release/win-unpacked/` exists and holds the Electron runtime Windows needs;
 *  - `Typing.exe` is a genuine PE32+ (64-bit) executable for the x64 machine type;
 *  - `resources/app.asar` holds the built main, preload and renderer bundles, and
 *    no macOS-only files were packaged;
 *  - the zip is a well-formed archive that extracts cleanly (central directory,
 *    local headers, CRC32 of every entry) and contains the same layout.
 *
 *   node scripts/check-win-package.mjs [path-to-release-dir]
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const releaseDir = resolve(process.argv[2] ?? join(projectRoot, 'release'))
const appDir = join(releaseDir, 'win-unpacked')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(ok)
}

// ---------------------------------------------------------------------------
// PE header
// ---------------------------------------------------------------------------

const MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' }

function readPeInfo(path) {
  const fd = readFileSync(path)
  if (fd.length < 0x40 || fd[0] !== 0x4d || fd[1] !== 0x5a) return { ok: false, error: 'no MZ header' }
  const peOffset = fd.readUInt32LE(0x3c)
  if (fd.length < peOffset + 24) return { ok: false, error: 'truncated DOS stub' }
  if (fd.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return { ok: false, error: 'no PE signature' }
  const machine = fd.readUInt16LE(peOffset + 4)
  const sections = fd.readUInt16LE(peOffset + 6)
  const characteristics = fd.readUInt16LE(peOffset + 22)
  const optionalMagic = fd.readUInt16LE(peOffset + 24)
  const subsystem = fd.readUInt16LE(peOffset + 24 + 68)
  const format = optionalMagic === 0x20b ? 'PE32+' : optionalMagic === 0x10b ? 'PE32' : `0x${optionalMagic.toString(16)}`
  return {
    ok: true,
    machine,
    machineName: MACHINE[machine] ?? `0x${machine.toString(16)}`,
    format,
    bits: optionalMagic === 0x20b ? 64 : 32,
    sections,
    characteristics,
    subsystem,
    size: fd.length
  }
}

// ---------------------------------------------------------------------------
// ASAR
// ---------------------------------------------------------------------------

/** Read an asar archive's file index without unpacking it. */
function readAsarIndex(path) {
  const fd = readFileSync(path)
  // asar layout: UInt32LE(4) | UInt32LE(pickle size) | UInt32LE(json length) | json
  const jsonLength = fd.readUInt32LE(12)
  const json = fd.toString('utf8', 16, 16 + jsonLength)
  const header = JSON.parse(json)
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, full)
      else files.push({ path: full, size: entry.size ?? 0, unpacked: Boolean(entry.unpacked) })
    }
  }
  walk(header, '')
  return files
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function readZip(path) {
  const buf = readFileSync(path)
  // Locate the end-of-central-directory record.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 0x10000 - 22); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { ok: false, error: 'no end-of-central-directory record' }
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, error: `bad central directory header at entry ${i}` }
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { ok: true, entries }
}

/** Extract every entry and verify its CRC; returns the names of bad entries. */
function extractZip(path, targetDir) {
  const zip = readZip(path)
  if (!zip.ok) return { ok: false, error: zip.error, entries: [] }
  const buf = readFileSync(path)
  const bad = []
  for (const entry of zip.entries) {
    const local = entry.localOffset
    if (buf.readUInt32LE(local) !== 0x04034b50) {
      bad.push(`${entry.name}: bad local header`)
      continue
    }
    const nameLen = buf.readUInt16LE(local + 26)
    const extraLen = buf.readUInt16LE(local + 28)
    const dataStart = local + 30 + nameLen + extraLen
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
    let data
    try {
      data = entry.method === 0 ? raw : inflateRawSync(raw)
    } catch (err) {
      bad.push(`${entry.name}: ${err.message}`)
      continue
    }
    if (data.length !== entry.uncompressedSize) bad.push(`${entry.name}: size ${data.length} != ${entry.uncompressedSize}`)
    if (crc32(data) !== entry.crc) bad.push(`${entry.name}: CRC mismatch`)
    if (targetDir) {
      const out = join(targetDir, entry.name)
      if (entry.name.endsWith('/')) continue
      // Defend against zip-slip even though we built the archive ourselves.
      if (relative(targetDir, out).startsWith('..')) {
        bad.push(`${entry.name}: escapes the target directory`)
        continue
      }
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, data)
    }
  }
  return { ok: bad.length === 0, error: bad.slice(0, 5).join(' | '), entries: zip.entries }
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) listFiles(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log(`Checking ${releaseDir}`)

if (!check('release/win-unpacked exists (unpacked x64 app directory)', existsSync(appDir))) {
  console.error(`\nRun "npm run package:win" first.`)
  process.exit(1)
}

const exePath = join(appDir, 'Typing.exe')
const pe = existsSync(exePath) ? readPeInfo(exePath) : { ok: false, error: 'Typing.exe missing' }
check('Typing.exe exists', pe.ok, pe.error ?? '')
if (pe.ok) {
  check('Typing.exe is a PE32+ (64-bit) executable', pe.format === 'PE32+', pe.format)
  check('Typing.exe targets the x64 machine type', pe.machineName === 'x64', pe.machineName)
  check('Typing.exe is a Windows GUI subsystem binary', pe.subsystem === 2, `subsystem ${pe.subsystem}`)
  check('Typing.exe is a real application binary, not a stub', pe.size > 20_000_000, `${(pe.size / 1e6).toFixed(1)} MB`)
}

// The Electron runtime files a Windows build must ship. Electron 45 links ANGLE
// into its binaries, so the Windows payload is this set (verified against the
// contents of electron-v45.2.3-win32-x64.zip).
for (const required of [
  'resources/app.asar',
  'resources.pak',
  'chrome_100_percent.pak',
  'icudtl.dat',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'ffmpeg.dll',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'locales/en-US.pak',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html'
]) {
  check(`ships ${required}`, existsSync(join(appDir, required)))
}

// Windows binaries only: a macOS or Linux shared library in the package would be
// dead weight at best and a packaging mistake at worst.
const rootFiles = readdirSync(appDir)
const sharedLibs = rootFiles.filter((f) => /\.(dylib|so)$|\.so\./.test(f))
check('ships no macOS or Linux shared libraries', sharedLibs.length === 0, sharedLibs.join(', '))
check(
  'ships the Windows DLL set',
  ['ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll'].every((f) => rootFiles.includes(f)),
  rootFiles.filter((f) => f.endsWith('.dll')).join(', ')
)

// The original icon artwork is embedded in the executable (no wine needed: the
// builder edits the resource section itself), and the version metadata is there.
const icoPath = join(projectRoot, 'build/icon.ico')
if (existsSync(icoPath) && pe.ok) {
  const ico = readFileSync(icoPath)
  const exe = readFileSync(exePath)
  const count = ico.readUInt16LE(4)
  let embedded = 0
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const bytes = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    // Compare the first 200 bytes of the bitmap payload (after the DIB header).
    const head = ico.subarray(offset + 40, offset + 240)
    if (bytes > 240 && exe.includes(head)) embedded++
  }
  check(`Typing.exe embeds every icon size from build/icon.ico`, embedded === count, `${embedded}/${count} sizes found`)
} else {
  console.log('  SKIP  icon embedding check (build/icon.ico or Typing.exe missing)')
}

if (pe.ok) {
  const exe = readFileSync(exePath)
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const utf16 = (str) => Buffer.from(str, 'utf16le')
  check('Typing.exe carries the product name in its version resource', exe.includes(utf16(pkg.productName ?? 'Typing')))
  check('Typing.exe carries the version in its version resource', exe.includes(utf16(pkg.version)))
}

// app.asar contents.
const asarPath = join(appDir, 'resources/app.asar')
if (existsSync(asarPath)) {
  let files = []
  try {
    files = readAsarIndex(asarPath)
  } catch (err) {
    check('resources/app.asar header can be read', false, err.message)
  }
  const paths = new Set(files.map((f) => f.path))
  check('app.asar holds the built main bundle', paths.has('out/main/index.js'))
  check('app.asar holds the built preload bundle', paths.has('out/preload/index.js'))
  check('app.asar holds the built renderer page', paths.has('out/renderer/index.html'))
  check(
    'app.asar holds the renderer assets',
    files.some((f) => f.path.startsWith('out/renderer/assets/') && /\.js$/.test(f.path)),
    `${files.filter((f) => f.path.startsWith('out/renderer/assets/')).length} asset files`
  )
  check('app.asar holds the documentation', ['README.md', 'USAGE.md', 'THIRD_PARTY.md'].every((f) => paths.has(f)))
  check('app.asar holds package.json', paths.has('package.json'))

  // No macOS-only payloads inside the app.
  const macOnlyInAsar = files.filter((f) =>
    /(^|\/)(Contents\/|Info\.plist$|.*\.dylib$|.*\.icns$|\.DS_Store$)/.test(f.path)
  )
  check('app.asar has no macOS-only files', macOnlyInAsar.length === 0, macOnlyInAsar.slice(0, 3).map((f) => f.path).join(', '))
  const unpacked = files.filter((f) => f.unpacked)
  check('app.asar has nothing left unpacked beside it', unpacked.length === 0, unpacked.slice(0, 3).map((f) => f.path).join(', '))
}

// No macOS-only binaries anywhere in the unpacked app.
const allFiles = listFiles(appDir)
const macOnly = allFiles.filter((f) => /(\.dylib$|\.icns$|^Contents\/|\.app\/)/.test(f))
check('the package contains no macOS-only binaries', macOnly.length === 0, macOnly.slice(0, 5).join(', '))
const nodeModules = allFiles.filter((f) => f.includes('node_modules'))
check(
  'no development node_modules were packaged',
  nodeModules.length === 0,
  nodeModules.slice(0, 3).join(', ')
)

// The zip.
const zips = readdirSync(releaseDir).filter((f) => f.endsWith('.zip'))
check('a zip archive was produced', zips.length === 1, zips.join(', ') || 'none')
if (zips.length) {
  const zipPath = join(releaseDir, zips[0])
  const zip = readZip(zipPath)
  check('the zip has a readable central directory', zip.ok, zip.error ?? `${zip.entries?.length ?? 0} entries`)
  if (zip.ok) {
    const names = zip.entries.map((e) => e.name)
    check('the zip contains Typing.exe at the archive root', names.includes('Typing.exe'))
    check('the zip contains resources/app.asar', names.includes('resources/app.asar'))
    check('the zip uses forward slashes only', names.every((n) => !n.includes('\\')))
    const temp = mkdtempSync(join(tmpdir(), 'typing-zip-check-'))
    try {
      const extracted = extractZip(zipPath, temp)
      check('every zip entry extracts with a matching CRC32', extracted.ok, extracted.error ?? `${zip.entries.length} entries`)
      check('the extracted zip holds Typing.exe', existsSync(join(temp, 'Typing.exe')))
      check('the extracted zip holds app.asar', existsSync(join(temp, 'resources/app.asar')))
      const extractedCount = listFiles(temp).length
      const fileEntries = zip.entries.filter((e) => !e.name.endsWith('/')).length
      check(
        'the extracted tree matches the entry count',
        extractedCount === fileEntries,
        `${extractedCount} files, ${fileEntries} file entries, ${zip.entries.length - fileEntries} directories`
      )
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
    // A second opinion from the platform tool, when it exists.
    try {
      execFileSync('unzip', ['-tq', zipPath], { stdio: 'pipe' })
      check('unzip -t reports no archive errors', true)
    } catch (err) {
      if (err.code === 'ENOENT') console.log('  SKIP  unzip -t (unzip is not installed here)')
      else check('unzip -t reports no archive errors', false, String(err.stderr ?? err.message).slice(0, 200))
    }
    const bytes = statSync(zipPath).size
    check('the zip is a plausible size', bytes > 50_000_000, `${(bytes / 1e6).toFixed(1)} MB`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failures:')
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`)
  process.exitCode = 1
}