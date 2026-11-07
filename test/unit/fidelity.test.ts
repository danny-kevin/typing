import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeDoc,
  encodeDoc,
  bytesEqual,
  detectEol,
  remapLineEndings,
  splitLineEndings,
  eolForEndings
} from '../../src/shared/doc'

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

const BOM = [0xef, 0xbb, 0xbf]

/** Decode written bytes the way a reader of the file would. */
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8')
const binary = (bytes: Uint8Array): string => Buffer.from(bytes).toString('binary')

function bytes(text: string, bom = false): Uint8Array {
  const body = Buffer.from(text, 'utf8')
  return new Uint8Array(bom ? [...BOM, ...body] : [...body])
}

/** Open a file, apply an edit to the editing text, save, and return the bytes. */
function editAndSave(original: Uint8Array, edit: (text: string) => string): Uint8Array {
  const doc = decodeDoc(original)
  const text = edit(doc.text)
  return encodeDoc({ ...doc, text, lineEndings: remapLineEndings(doc.text, doc.lineEndings, text, doc.eol) })
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
      expect(doc.eol).toBe(detectEol(new TextDecoder().decode(file.bytes)))
    })
  }

  it('keeps a UTF-8 BOM exactly once', () => {
    const body = '# héllo\n\ntext with 中文\n'
    const withBom = bytes(body, true)
    const doc = decodeDoc(withBom)
    expect(doc.bom).toBe(true)
    expect(doc.text.startsWith('#')).toBe(true)
    expect(bytesEqual(encodeDoc(doc), withBom)).toBe(true)
    // Saving twice must not accumulate markers.
    expect(bytesEqual(encodeDoc(decodeDoc(encodeDoc(doc))), withBom)).toBe(true)
  })

  it('preserves a leading content U+FEFF after the actual BOM (history byte fidelity)', () => {
    const original = bytes('\ufeffone\r\ntwo\n', true)
    const doc = decodeDoc(original)
    expect(doc.text.startsWith('\ufeffone')).toBe(true)
    expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
  })

  it('handles files without a trailing newline', () => {
    const original = bytes('# title\n\nlast line without newline')
    expect(bytesEqual(roundTrip(original), original)).toBe(true)
  })

  it('handles an empty file', () => {
    const original = new Uint8Array(0)
    const doc = decodeDoc(original)
    expect(doc.text).toBe('')
    expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
  })

  it('handles a BOM-only file', () => {
    const original = new Uint8Array(BOM)
    const doc = decodeDoc(original)
    expect(doc.text).toBe('')
    expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
  })

  it('keeps CR characters that are not part of a line ending', () => {
    const original = bytes('a\rb\nc')
    const doc = decodeDoc(original)
    // The editor has no notion of a bare CR: it is a line break like any other,
    // and the bytes come back exactly.
    expect(doc.text).toBe('a\nb\nc')
    expect(doc.lineEndings).toBe('rl')
    expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
  })

  it('flags invalid UTF-8 instead of silently mangling it', () => {
    const original = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a])
    const doc = decodeDoc(original)
    expect(doc.validUtf8).toBe(false)
    expect(doc.text.includes('\uFFFD')).toBe(true)
    // Re-encoding cannot reproduce the original bytes; the save path therefore
    // refuses to write them back without explicit consent.
    expect(bytesEqual(encodeDoc(doc), original)).toBe(false)
  })

  it('preserves trailing whitespace and tabs verbatim', () => {
    const original = bytes('line with trailing spaces   \n\ttabbed\n\n\n')
    const doc = decodeDoc(original)
    expect(doc.text.endsWith('\n\n\n')).toBe(true)
    expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
  })

  it('survives a second save after an unrelated edit', () => {
    const original = new Uint8Array(readFileSync(join(corpusDir, '09-unknown-syntax.md')))
    const doc = decodeDoc(original)
    const edited = doc.text.replace('Emoji :smile: shortcode.', 'Emoji :smile: shortcode. (edited)')
    const saved = encodeDoc({ ...doc, text: edited, lineEndings: remapLineEndings(doc.text, doc.lineEndings, edited, doc.eol) })
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

describe('mixed line endings survive opening and saving', () => {
  const cases: Array<{ name: string; text: string; eol: '\n' | '\r\n'; endings: string }> = [
    { name: 'the reported CRLF + LF case', text: 'one\r\ntwo\r\nthree\n', eol: '\r\n', endings: 'ccl' },
    { name: 'LF dominant with one CRLF line', text: 'a\nb\nc\r\nd\n', eol: '\n', endings: 'llcl' },
    { name: 'CRLF, LF and a lone CR', text: 'a\r\nb\nc\rd', eol: '\n', endings: 'clr' },
    { name: 'only lone CR (classic Mac)', text: 'a\rb\rc', eol: '\n', endings: 'rr' },
    { name: 'no trailing newline after a mix', text: 'x\r\ny\r\nz', eol: '\r\n', endings: 'cc' }
  ]

  for (const { name, text, eol, endings } of cases) {
    it(`round-trips ${name} byte for byte`, () => {
      const original = bytes(text)
      const doc = decodeDoc(original)
      expect(doc.eol).toBe(eol)
      expect(doc.lineEndings).toBe(endings)
      expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
    })

    it(`round-trips ${name} with a BOM`, () => {
      const original = bytes(text, true)
      const doc = decodeDoc(original)
      expect(doc.bom).toBe(true)
      expect(bytesEqual(encodeDoc(doc), original)).toBe(true)
    })

    it(`keeps every existing ending when ${name} is edited elsewhere`, () => {
      const original = bytes(text)
      // Append a new line: existing lines keep their own endings, the new line
      // takes the file's dominant ending.
      const saved = editAndSave(original, (t) => `${t}${t.endsWith('\n') ? '' : '\n'}NEW LINE\n`)
      // The original bytes, plus the terminator the last line may have lacked
      // (dominant), plus the new line.
      const rebuilt = Buffer.concat([
        Buffer.from(text, 'utf8'),
        Buffer.from(text.endsWith('\n') || text.endsWith('\r') ? '' : eol, 'utf8'),
        Buffer.from(`NEW LINE${eol}`, 'utf8')
      ])
      expect(binary(saved)).toBe(binary(rebuilt))
      // Nothing that was already there moved.
      expect(binary(saved.subarray(0, Buffer.from(text, 'utf8').length))).toBe(binary(Buffer.from(text, 'utf8')))
    })
  }

  it('gives an inserted line the dominant ending and leaves the rest alone', () => {
    const original = bytes('a\nb\r\nc\n') // LF, CRLF, LF -> LF dominant
    const doc = decodeDoc(original)
    expect(doc.eol).toBe('\n')
    const saved = editAndSave(original, (t) => t.replace('b\n', 'b\nINSERTED\n'))
    // `b` itself did not change, so it keeps its CRLF; the inserted line takes
    // the dominant ending; `c` was LF and stays LF.
    expect(binary(saved)).toBe('a\nb\r\nINSERTED\nc\n')
  })

  it('preserves CRLF in a CRLF-dominant file with one LF line', () => {
    const original = bytes('a\r\nb\r\nc\n')
    const doc = decodeDoc(original)
    expect(doc.eol).toBe('\r\n')
    const saved = editAndSave(original, (t) => t.replace('a\n', 'a EDIT\n'))
    // The edited line becomes dominant (CRLF); the untouched lone LF stays LF.
    expect(binary(saved)).toBe('a EDIT\r\nb\r\nc\n')
  })
})

describe('remapLineEndings', () => {
  it('returns the original endings when nothing changed', () => {
    expect(remapLineEndings('a\nb\n', 'cl', 'a\nb\n', '\r\n')).toBe('cl')
  })

  it('falls back to the dominant ending for a brand new document', () => {
    expect(remapLineEndings('', '', 'x\ny\nz', '\r\n')).toBe('cc')
    expect(remapLineEndings('', '', 'x\ny\nz', '\n')).toBe('ll')
  })

  it('handles deleting a line', () => {
    // a\nb\r\nc\n -> delete b; a and c keep their endings, LF dominant.
    expect(remapLineEndings('a\nb\nc\n', 'lcl', 'a\nc\n', '\n')).toBe('ll')
  })

  it('handles a file that used no trailing newline and now has one', () => {
    expect(remapLineEndings('a\r\nb', 'c', 'a\r\nb\n', '\r\n')).toBe('cc')
  })

  it('survives an empty original', () => {
    expect(remapLineEndings('', '', '', '\n')).toBe('')
  })
})

describe('line ending helpers', () => {
  it('splits every kind of line break', () => {
    expect(splitLineEndings('a\r\nb\nc\rd')).toEqual({ text: 'a\nb\nc\nd', lineEndings: 'clr' })
    expect(splitLineEndings('no breaks')).toEqual({ text: 'no breaks', lineEndings: '' })
  })

  it('detects the dominant ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(detectEol('a\nb\nc\r\n')).toBe('\n')
    expect(detectEol('nothing')).toBe('\n')
    expect(eolForEndings('ccl')).toBe('\r\n')
    expect(eolForEndings('llc')).toBe('\n')
  })
})