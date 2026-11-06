/**
 * Byte-faithful text decoding/encoding.
 *
 * Typing keeps the raw file in its editor verbatim: the document model *is* the
 * text. Decoding therefore only records two pieces of information that cannot be
 * represented in a JavaScript string but must survive a round trip:
 *
 *  - a UTF-8 byte order mark, and
 *  - the file's newline convention (LF or CRLF).
 *
 * `encodeDoc(decodeDoc(bytes))` returns the original bytes for every valid UTF-8
 * file, which is the property the source-fidelity tests assert.
 */

export interface DecodedDoc {
  text: string
  eol: '\n' | '\r\n'
  bom: boolean
  /** True when the bytes were valid UTF-8 (invalid sequences are replaced). */
  validUtf8: boolean
}

const BOM_BYTES = [0xef, 0xbb, 0xbf]

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM_BYTES[0] && bytes[1] === BOM_BYTES[1] && bytes[2] === BOM_BYTES[2]
}

/** Detect the dominant newline style. A file with no newline keeps LF. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

export function decodeDoc(bytes: Uint8Array): DecodedDoc {
  const bom = hasBom(bytes)
  const body = bom ? bytes.subarray(3) : bytes
  let text: string
  let validUtf8 = true
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    validUtf8 = false
    text = new TextDecoder('utf-8').decode(body)
  }
  const eol = detectEol(text)
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n')
  return { text, eol, bom, validUtf8 }
}

export function encodeDoc(doc: DecodedDoc): Uint8Array {
  let text = doc.text
  if (doc.eol === '\r\n') text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  const body = new TextEncoder().encode(text)
  if (!doc.bom) return body
  const out = new Uint8Array(body.length + 3)
  out.set(BOM_BYTES, 0)
  out.set(body, 3)
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}