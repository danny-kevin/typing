import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDocument, hashBytes, type SaveRequest } from '../../src/main/save-doc'
import { decodeDoc } from '../../src/shared/doc'

it('publishes exact saved bytes to history without waiting for or rejecting its failure', async () => {
  const path = target('history-save.md')
  const seen: Uint8Array[] = []
  const result = await writeDocument({ path, text: 'a\nb\nc\n', eol: '\r\n', bom: true, lineEndings: 'clr' }, {
    afterSave: (_path, bytes) => { seen.push(bytes); throw new Error('history unavailable') }
  })
  expect(result.ok).toBe(true)
  expect(Buffer.from(seen[0])).toEqual(Buffer.from('\ufeffa\r\nb\nc\r'))
  expect(await fs.readFile(path)).toEqual(Buffer.from(seen[0]))
})

it('restores encoding-only changes and exact mixed endings without bypassing conflicts', async () => {
  const path = target('history-encoding.md')
  await fs.writeFile(path, 'a\nb\nc\n')
  const request = await requestFor('history-encoding.md', 'a\nb\nc\n', { bom: true, lineEndings: 'clr' })
  const saved = await writeDocument(request)
  expect(saved.ok).toBe(true)
  expect(await fs.readFile(path)).toEqual(Buffer.from('\ufeffa\r\nb\nc\r'))
  await fs.writeFile(path, 'external writer')
  const blocked = await writeDocument({ ...request, onConflict: 'report' })
  expect(blocked.ok).toBe(false)
  expect(await fs.readFile(path, 'utf8')).toBe('external writer')
})

let dir = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'typing-save-unit-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Path of a file that only this test knows about. */
function target(name: string): string {
  return join(dir, name)
}

/** The request the renderer sends after opening `name`. */
async function requestFor(name: string, text: string, extra: Partial<SaveRequest> = {}): Promise<SaveRequest> {
  const path = target(name)
  const bytes = new Uint8Array(await fs.readFile(path))
  const doc = decodeDoc(bytes)
  return {
    path,
    text,
    baseMtimeMs: (await fs.stat(path)).mtimeMs,
    baseHash: hashBytes(bytes),
    eol: doc.eol,
    bom: doc.bom,
    ...extra
  }
}

async function tempFiles(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => n.includes('.typing-tmp-'))
}

describe('no-edit save writes nothing at all', () => {
  const cases: Array<{ name: string; bytes: Buffer; label: string }> = [
    { name: 'mixed.md', bytes: Buffer.from('one\r\ntwo\r\nthree\n', 'utf8'), label: 'the reported CRLF+LF case' },
    { name: 'mixed-bom.md', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\nc', 'utf8')]), label: 'a mixed file with a BOM' },
    { name: 'lone-cr.md', bytes: Buffer.from('a\rb\rc\r\n', 'utf8'), label: 'a lone-CR file' },
    { name: 'plain.md', bytes: Buffer.from('# Title\n\nbody\n', 'utf8'), label: 'an ordinary LF file' }
  ]

  for (const { name, bytes, label } of cases) {
    it(`leaves ${label} byte- and mtime-identical`, async () => {
      const path = target(name)
      await fs.writeFile(path, bytes)
      const before = await fs.stat(path)
      await new Promise((r) => setTimeout(r, 20))
      const doc = decodeDoc(new Uint8Array(bytes))
      const result = await writeDocument({
        path,
        text: doc.text,
        baseMtimeMs: before.mtimeMs,
        baseHash: hashBytes(new Uint8Array(bytes)),
        eol: doc.eol,
        bom: doc.bom
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.unchanged).toBe(true)
      const after = await fs.stat(path)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(Buffer.compare(await fs.readFile(path), bytes)).toBe(0)
      expect(result.hash).toBe(hashBytes(new Uint8Array(bytes)))
      expect(result.lineEndings.length).toBe(doc.lineEndings.length)
    })
  }
})

describe('mixed line endings survive an edit', () => {
  it('keeps each existing line ending and gives new lines the dominant one', async () => {
    const path = target('edit-mixed.md')
    await fs.writeFile(path, Buffer.from('one\r\ntwo\r\nthree\n', 'utf8'))
    const req = await requestFor('edit-mixed.md', 'one\ntwo\nthree\nfour\n')
    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    expect(Buffer.from(await fs.readFile(path)).toString('binary')).toBe('one\r\ntwo\r\nthree\nfour\r\n')
    if (result.ok) {
      expect(result.lineEndings).toBe('cclc')
      expect(result.hash).toBe(hashBytes(new Uint8Array(await fs.readFile(path))))
    }
  })

  it('preserves a BOM exactly once while editing', async () => {
    const path = target('edit-bom.md')
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# a\r\n\r\nb\r\n', 'utf8')])
    await fs.writeFile(path, withBom)
    const req = await requestFor('edit-bom.md', '# a\n\nb edited\n')
    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    const after = await fs.readFile(path)
    expect(after[0]).toBe(0xef)
    expect(Buffer.from(after).toString('binary')).toBe('\xef\xbb\xbf# a\r\n\r\nb edited\r\n')
  })
})

describe('files that are not valid UTF-8', () => {
  const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])

  it('refuses an in-place write and leaves the bytes alone', async () => {
    const path = target('invalid.md')
    await fs.writeFile(path, invalid)
    const doc = decodeDoc(new Uint8Array(invalid))
    expect(doc.validUtf8).toBe(false)
    const result = await writeDocument({
      path,
      text: `${doc.text}edited\n`,
      baseHash: hashBytes(new Uint8Array(invalid)),
      eol: doc.eol,
      bom: doc.bom
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-utf8')
    expect(Buffer.compare(await fs.readFile(path), invalid)).toBe(0)
  })

  it('still reports an unchanged file without writing', async () => {
    const path = target('invalid-quiet.md')
    await fs.writeFile(path, invalid)
    const doc = decodeDoc(new Uint8Array(invalid))
    const result = await writeDocument({ path, text: doc.text, eol: doc.eol, bom: doc.bom })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.unchanged).toBe(true)
    expect(Buffer.compare(await fs.readFile(path), invalid)).toBe(0)
  })

  it('writes valid UTF-8 once the user explicitly consents', async () => {
    const path = target('invalid-consent.md')
    await fs.writeFile(path, invalid)
    const doc = decodeDoc(new Uint8Array(invalid))
    const result = await writeDocument({
      path,
      text: `${doc.text}edited\n`,
      eol: doc.eol,
      bom: doc.bom,
      acceptInvalidUtf8: true
    })
    expect(result.ok).toBe(true)
    const after = await fs.readFile(path)
    expect(after.includes(0xff)).toBe(false)
    expect(Buffer.from(after).toString('utf8')).toContain('edited')
  })
})

describe('another writer is never overwritten', () => {
  it('creates a conflict copy when the content changed but the mtime did not', async () => {
    const path = target('race-content.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('race-content.md', 'mine\n')
    const before = await fs.stat(path)
    // A concurrent writer replacing the file within the same millisecond, with
    // the mtime restored, defeats an mtime-only check.
    await fs.writeFile(path, 'theirs\n')
    await fs.utimes(path, before.atime, before.mtime)

    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conflictCopy).toBeTruthy()
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('theirs\n')
    expect(Buffer.from(await fs.readFile(result.conflictCopy!)).toString('utf8')).toBe('mine\n')
    expect(await tempFiles()).toEqual([])
  })

  it('detects a write that lands after the temporary file exists', async () => {
    const path = target('race-window.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('race-window.md', 'mine\n')
    const result = await writeDocument(req, {
      beforeRename: async () => {
        await fs.writeFile(path, 'late writer\n')
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conflictCopy).toBeTruthy()
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('late writer\n')
    expect(Buffer.from(await fs.readFile(result.conflictCopy!)).toString('utf8')).toBe('mine\n')
    expect(await tempFiles()).toEqual([])
  })

  it('writes in place when the file did not change', async () => {
    const path = target('in-place.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('in-place.md', 'original\nmore\n')
    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conflictCopy).toBeUndefined()
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('original\nmore\n')
    expect(await tempFiles()).toEqual([])
  })

  it('reports a conflict instead of writing a copy when asked to', async () => {
    const path = target('report-conflict.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('report-conflict.md', 'mine\n', { onConflict: 'report' })
    await fs.writeFile(path, 'theirs\n')
    const result = await writeDocument(req)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('conflict')
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('theirs\n')
    expect((await fs.readdir(dir)).filter((n) => n.startsWith('report-conflict ('))).toEqual([])
    expect(await tempFiles()).toEqual([])
  })

  it('honours an explicit force (Save As onto an existing path)', async () => {
    const path = target('forced.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('forced.md', 'replacement\n', { force: true })
    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conflictCopy).toBeUndefined()
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('replacement\n')
  })
})

describe('a file deleted outside Typing', () => {
  it('is recreated and reported', async () => {
    const path = target('deleted.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('deleted.md', 'original\nrecovered\n')
    await fs.rm(path)
    const result = await writeDocument(req)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.recreated).toBe(true)
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('original\nrecovered\n')
  })

  it('is recreated when it disappears during the save', async () => {
    const path = target('deleted-late.md')
    await fs.writeFile(path, 'original\n')
    const req = await requestFor('deleted-late.md', 'original\nrecovered\n')
    const result = await writeDocument(req, {
      beforeRename: async () => {
        await fs.rm(path)
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.recreated).toBe(true)
    expect(Buffer.from(await fs.readFile(path)).toString('utf8')).toBe('original\nrecovered\n')
  })
})

describe('new documents', () => {
  it('writes LF for a brand new file', async () => {
    const path = target('brand-new.md')
    const result = await writeDocument({ path, text: 'hello\nworld\n', eol: '\n', bom: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unchanged).toBeUndefined()
    expect(result.recreated).toBeFalsy()
    expect(Buffer.from(await fs.readFile(path)).toString('binary')).toBe('hello\nworld\n')
  })

  it('creates missing parent directories', async () => {
    const path = join(dir, 'nested', 'deep', 'doc.md')
    const result = await writeDocument({ path, text: 'x\n', eol: '\r\n', bom: false })
    expect(result.ok).toBe(true)
    expect(Buffer.from(await fs.readFile(path)).toString('binary')).toBe('x\r\n')
  })
})