import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDoc, encodeDoc, bytesEqual, detectEol } from '../../src/shared/doc'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '..', 'corpus')
const corpus = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(corpusDir, name))) }))

/** What the app does when a document is opened and saved without any edit. */
function roundTrip(bytes: Uint8Array): Uint8Array {
  const doc = decodeDoc(bytes)
  return encodeDoc(doc)
}

describe('source fidelity: decode → encode is byte identical', () => {
  it('has a corpus to test', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(10)
  })

  for (const file of corpus) {
    it(`preserves every byte of ${file.name}`, () => {
      const original = file.bytes
      const result = roundTrip(original)
      expect(bytesEqual(result, original)).toBe(true)
      expect(result.length).toBe(original.length)
    })

    it(`preserves the newline convention of ${file.name}`, () => {
      const doc = decodeDoc(file.bytes)
      const crlfBytes = new TextEncoder().encode(
        new TextDecoder().decode(file.bytes).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      )
      const crlfDoc = decodeDoc(crlfBytes)
      expect(crlfDoc.eol).toBe('\r\n')
      expect(bytesEqual(encodeDoc(crlfDoc), crlfBytes)).toBe(true)
      // And the original is unchanged by this experiment.
      expect(doc.eol).toBe(detectEol(doc.text))
    })
  }

  it('keeps a UTF-8 BOM exactly once', () => {
    const body = '# héllo\n\ntext with 中文\n'
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)])
    const doc = decodeDoc(withBom)
    expect(doc.bom).toBe(true)
    expect(doc.text.startsWith('#')).toBe(true)
    expect(bytesEqual(encodeDoc(doc), withBom)).toBe(true)
    // Saving twice must not accumulate markers.
    expect(bytesEqual(encodeDoc(decodeDoc(encodeDoc(doc))), withBom)).toBe(true)
  })

  it('handles files without a trailing newline', () => {
    const bytes = new TextEncoder().encode('# title\n\nlast line without newline')
    expect(bytesEqual(roundTrip(bytes), bytes)).toBe(true)
  })

  it('handles an empty file', () => {
    const bytes = new Uint8Array(0)
    const doc = decodeDoc(bytes)
    expect(doc.text).toBe('')
    expect(bytesEqual(encodeDoc(doc), bytes)).toBe(true)
  })

  it('handles a BOM-only file', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf])
    const doc = decodeDoc(bytes)
    expect(doc.text).toBe('')
    expect(bytesEqual(encodeDoc(doc), bytes)).toBe(true)
  })

  it('keeps CR characters that are not part of a line ending', () => {
    const bytes = new TextEncoder().encode('a\rb\nc')
    const doc = decodeDoc(bytes)
    expect(bytesEqual(encodeDoc(doc), bytes)).toBe(true)
  })

  it('flags invalid UTF-8 instead of silently mangling it', () => {
    const bytes = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a])
    const doc = decodeDoc(bytes)
    expect(doc.validUtf8).toBe(false)
    expect(doc.text.includes('\uFFFD')).toBe(true)
  })

  it('preserves trailing whitespace and tabs verbatim', () => {
    const bytes = new TextEncoder().encode('line with trailing spaces   \n\ttabbed\n\n\n')
    const doc = decodeDoc(bytes)
    expect(doc.text.endsWith('\n\n\n')).toBe(true)
    expect(bytesEqual(encodeDoc(doc), bytes)).toBe(true)
  })

  it('survives a second save after an unrelated edit', () => {
    const bytes = new Uint8Array(readFileSync(join(corpusDir, '09-unknown-syntax.md')))
    const doc = decodeDoc(bytes)
    const edited = doc.text.replace('Emoji :smile: shortcode.', 'Emoji :smile: shortcode. (edited)')
    const saved = encodeDoc({ ...doc, text: edited })
    const reopened = decodeDoc(saved)
    expect(reopened.text).toBe(edited)
    // Only the edited line differs from the original.
    const a = doc.text.split('\n')
    const b = reopened.text.split('\n')
    expect(a.length).toBe(b.length)
    const differing = a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null)
    expect(differing).toHaveLength(1)
  })
})