#!/usr/bin/env node
/**
 * Generates Typing's app icon — original artwork, drawn from scratch with
 * analytic anti-aliasing and a tiny PNG encoder so the build has no image
 * dependencies.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const buildDir = join(root, 'build')
const iconset = join(buildDir, 'icon.iconset')

// ---------------------------------------------------------------------------
// PNG writer
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

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Drawing helpers (signed distance fields)
// ---------------------------------------------------------------------------

const clamp01 = (v) => Math.max(0, Math.min(1, v))

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r
}

function coverage(distance, aa = 1) {
  return clamp01(0.5 - distance / aa)
}

function mix(a, b, t) {
  return a + (b - a) * t
}

/** Draw the icon at a given pixel size into an RGBA buffer. */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4)
  const s = size
  const aa = Math.max(1, s / 220)
  const radius = s * 0.2237
  const pad = s * 0.055
  const hw = s / 2 - pad
  const hh = s / 2 - pad
  const cx = s / 2
  const cy = s / 2

  // Glyph geometry (fractions of the icon size).
  const barY = s * 0.285
  const barHalfW = s * 0.195
  const barHalfH = s * 0.0425
  const stemHalfW = s * 0.0395
  const stemBottom = s * 0.66
  const caretY = s * 0.745
  const caretHalfW = s * 0.115
  const caretHalfH = s * 0.021

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const i = (y * s + x) * 4

      const dBase = sdRoundedRect(px, py, cx, cy, hw, hh, radius)
      const aBase = coverage(dBase, aa)
      if (aBase <= 0) {
        buf[i] = 0
        buf[i + 1] = 0
        buf[i + 2] = 0
        buf[i + 3] = 0
        continue
      }

      // Vertical gradient: deep teal top → mid teal bottom, plus a soft
      // diagonal sheen so the icon reads well on light and dark docks.
      const t = clamp01((py / s - 0.05) / 0.9)
      let r = mix(0x2c, 0x1d, t)
      let g = mix(0x71, 0x4c, t)
      let b = mix(0x6b, 0x47, t)
      const sheen = clamp01(1 - Math.hypot(px - s * 0.28, py - s * 0.16) / (s * 0.72))
      r = mix(r, 0x3d, sheen * 0.35)
      g = mix(g, 0x8b, sheen * 0.35)
      b = mix(b, 0x84, sheen * 0.35)

      // Ink colour for the glyph.
      const inkR = 0xf7, inkG = 0xf4, inkB = 0xee
      let cr = r
      let cg = g
      let cb = b

      const dBar = sdRoundedRect(px, py, cx, barY, barHalfW, barHalfH, barHalfH * 0.55)
      const dStem = sdRoundedRect(px, py, cx, (barY + stemBottom) / 2, stemHalfW, (stemBottom - barY) / 2, stemHalfW)
      const dCaret = sdRoundedRect(px, py, cx, caretY, caretHalfW, caretHalfH, caretHalfH)
      const glyph = Math.max(coverage(dBar, aa), coverage(dStem, aa), coverage(dCaret * 0.92, aa))

      cr = mix(cr, inkR, glyph)
      cg = mix(cg, inkG, glyph)
      cb = mix(cb, inkB, glyph)

      // A warm caret tick inside the glyph area (the "typing" accent).
      const dTick = sdRoundedRect(px, py, cx + s * 0.0, caretY, caretHalfW, caretHalfH, caretHalfH)
      if (glyph > 0 && coverage(dTick, aa) > 0.5) {
        const tickT = 0.55
        cr = mix(cr, 0xe0, tickT)
        cg = mix(cg, 0xa8, tickT)
        cb = mix(cb, 0x63, tickT)
      }

      // Subtle inner rim.
      const rim = coverage(Math.abs(dBase + aa * 1.4) - aa * 0.6, aa) * 0.12
      cr = mix(cr, 255, rim)
      cg = mix(cg, 255, rim)
      cb = mix(cb, 255, rim)

      buf[i] = Math.round(cr)
      buf[i + 1] = Math.round(cg)
      buf[i + 2] = Math.round(cb)
      buf[i + 3] = Math.round(aBase * 255)
    }
  }
  return buf
}

// ---------------------------------------------------------------------------
// ICO writer (Windows): 32-bit BGRA bitmaps, one per size, exactly as the
// Windows shell and electron-builder expect for `build/icon.ico`.
// ---------------------------------------------------------------------------

function encodeDib(width, height, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(width, 4) // biWidth
  header.writeInt32LE(height * 2, 8) // biHeight: XOR bitmap + AND mask
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(width * height * 4, 20) // biSizeImage
  // Rows are stored bottom-up, as BGRA.
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y
    for (let x = 0; x < width; x++) {
      const from = (srcRow * width + x) * 4
      const to = (y * width + x) * 4
      pixels[to] = rgba[from + 2] // B
      pixels[to + 1] = rgba[from + 1] // G
      pixels[to + 2] = rgba[from] // R
      pixels[to + 3] = rgba[from + 3] // A
    }
  }
  // AND mask: one bit per pixel, rows padded to 32 bits. All zero because the
  // alpha channel carries transparency.
  const maskStride = Math.ceil(width / 32) * 4
  const mask = Buffer.alloc(maskStride * height)
  return Buffer.concat([header, pixels, mask])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  const payloads = []
  let offset = 6 + 16 * images.length
  for (const img of images) {
    const data = encodeDib(img.size, img.size, img.rgba)
    const entry = Buffer.alloc(16)
    entry[0] = img.size >= 256 ? 0 : img.size // 0 means 256
    entry[1] = img.size >= 256 ? 0 : img.size
    entry[2] = 0 // palette size
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
    payloads.push(data)
  }
  return Buffer.concat([header, ...entries, ...payloads])
}

// ---------------------------------------------------------------------------

mkdirSync(buildDir, { recursive: true })
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

const specs = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png']
]

for (const [size, name] of specs) {
  writeFileSync(join(iconset, name), encodePng(size, size, drawIcon(size)))
}
writeFileSync(join(buildDir, 'icon.png'), encodePng(512, 512, drawIcon(512)))

try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')], { stdio: 'inherit' })
  console.log('wrote build/icon.icns')
} catch (err) {
  // iconutil only exists on macOS; the .ico below is produced everywhere.
  console.error('iconutil failed (expected off macOS):', err.message)
}
rmSync(iconset, { recursive: true, force: true })

// Windows icon: the same artwork at every size the shell asks for.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
writeFileSync(
  join(buildDir, 'icon.ico'),
  encodeIco(icoSizes.map((size) => ({ size, rgba: drawIcon(size) })))
)
console.log('wrote build/icon.ico')
console.log('icon generated')