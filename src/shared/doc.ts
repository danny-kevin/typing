/**
 * Byte-faithful text decoding/encoding.
 *
 * Typing keeps the raw file in its editor verbatim: the document model *is* the
 * text. Decoding therefore records the information that cannot be represented in
 * a JavaScript string (which only holds `\n` line breaks) but must survive a
 * round trip:
 *
 *  - a UTF-8 byte order mark,
 *  - the ending of **every** line in the file, so files that mix CRLF, LF and
 *    lone CR come back unchanged, and
 *  - the dominant ending, used for lines the user adds.
 *
 * `encodeDoc(decodeDoc(bytes))` returns the original bytes for every valid UTF-8
 * file, including mixed-ending ones, which is the property the source-fidelity
 * tests assert. Editing preserves each existing line's ending and gives new
 * lines the file's dominant ending (`remapLineEndings`).
 */

/** A newline convention this editor can synthesise for new lines. */
export type Eol = '\n' | '\r\n'

export interface DecodedDoc {
  /** Editing text: every line ending (CRLF, LF or lone CR) normalised to LF. */
  text: string
  /** Dominant line ending; used for lines the user adds. */
  eol: Eol
  /**
   * One character per line break of the file, in order: `c` = CRLF, `l` = LF,
   * `r` = lone CR. Entry `i` terminates line `i` of `text`.
   */
  lineEndings: string
  /** True when the file starts with a UTF-8 byte order mark. */
  bom: boolean
  /** True when the bytes were valid UTF-8 (invalid sequences are replaced). */
  validUtf8: boolean
}

/** Everything `encodeDoc` needs; a decoded document satisfies it. */
export interface EncodableDoc {
  text: string
  eol: Eol
  /** Per-line endings of `text`; missing entries fall back to `eol`. */
  lineEndings?: string
  bom: boolean
}

const BOM_BYTES = [0xef, 0xbb, 0xbf]
const ENDING_CRLF = 'c'
const ENDING_LF = 'l'
const ENDING_CR = 'r'

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM_BYTES[0] && bytes[1] === BOM_BYTES[1] && bytes[2] === BOM_BYTES[2]
}

/**
 * Split raw file text into LF-normalised editing text plus the ending of every
 * line, so nothing about the file's line breaks is lost.
 */
export function splitLineEndings(raw: string): { text: string; lineEndings: string } {
  if (!raw.includes('\r')) return { text: raw, lineEndings: ENDING_LF.repeat((raw.match(/\n/g) || []).length) }
  let text = ''
  let lineEndings = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\r') {
      if (raw[i + 1] === '\n') {
        lineEndings += ENDING_CRLF
        i++
      } else {
        lineEndings += ENDING_CR
      }
      text += '\n'
    } else if (ch === '\n') {
      lineEndings += ENDING_LF
      text += '\n'
    } else {
      text += ch
    }
  }
  return { text, lineEndings }
}

/** Dominant newline convention of a raw file text. A file with no newline keeps LF. */
export function detectEol(raw: string): Eol {
  const crlf = (raw.match(/\r\n/g) || []).length
  const lf = (raw.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** Dominant newline convention of an encoded endings string. */
export function eolForEndings(lineEndings: string): Eol {
  let crlf = 0
  let lf = 0
  for (const ch of lineEndings) {
    if (ch === ENDING_CRLF) crlf++
    else if (ch === ENDING_LF) lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

export function decodeDoc(bytes: Uint8Array): DecodedDoc {
  const bom = hasBom(bytes)
  const body = bom ? bytes.subarray(3) : bytes
  let text: string
  let validUtf8 = true
  // We already removed the marker; a second U+FEFF is content, not another BOM.
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    validUtf8 = false
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)
  }
  const { text: normalised, lineEndings } = splitLineEndings(text)
  return { text: normalised, eol: eolForEndings(lineEndings), lineEndings, bom, validUtf8 }
}

/**
 * Endings for `newText`, given the endings that `oldText` had on disk.
 *
 * Lines the user did not touch keep the ending they already had (so a file that
 * mixes CRLF and LF stays mixed); lines the user inserted, or whose text changed,
 * get the file's dominant ending. The comparison trims the common prefix and
 * suffix of lines, which is exact for the usual case of editing, appending to, or
 * inserting lines into a document and costs O(lines).
 */
export function remapLineEndings(oldText: string, oldEndings: string, newText: string, eol: Eol): string {
  const dominant = eol === '\r\n' ? ENDING_CRLF : ENDING_LF
  if (oldText === newText) return oldEndings.length ? oldEndings : dominant.repeat(countBreaks(newText))
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const shift = oldLines.length - newLines.length
  let out = ''
  for (let line = 0; line < newLines.length - 1; line++) {
    let ending: string | undefined
    if (line < prefix) ending = oldEndings[line]
    else if (line >= newLines.length - suffix) ending = oldEndings[line + shift]
    out += ending === ENDING_CRLF || ending === ENDING_LF || ending === ENDING_CR ? ending : dominant
  }
  return out
}

function countBreaks(text: string): number {
  let n = 0
  for (const ch of text) if (ch === '\n') n++
  return n
}

function endingText(token: string | undefined, dominant: Eol): string {
  if (token === ENDING_CRLF) return '\r\n'
  if (token === ENDING_LF) return '\n'
  if (token === ENDING_CR) return '\r'
  return dominant
}

export function encodeDoc(doc: EncodableDoc): Uint8Array {
  const lines = doc.text.split('\n')
  const dominant: Eol = doc.eol === '\r\n' ? '\r\n' : '\n'
  const endings = doc.lineEndings ?? ''
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]
    if (i < lines.length - 1) out += endingText(endings[i], dominant)
  }
  const body = new TextEncoder().encode(out)
  if (!doc.bom) return body
  const withBom = new Uint8Array(body.length + 3)
  withBom.set(BOM_BYTES, 0)
  withBom.set(body, 3)
  return withBom
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}