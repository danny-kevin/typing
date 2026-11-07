/**
 * The write side of the fidelity promise: turn the editor's text into the bytes
 * a file already had, and never replace bytes that someone else owns.
 *
 * This module is deliberately free of Electron imports so it can be unit tested
 * against a real temporary directory (see test/unit/save-safety.test.ts).
 *
 * The rules it enforces, in order:
 *
 *  1. A file whose bytes are not valid UTF-8 is never rewritten in place unless
 *     the caller carries the user's explicit consent — decoding replaced those
 *     bytes, so writing back would silently destroy them.
 *  2. If the editor text equals what the file already decodes to, nothing is
 *     written at all: the bytes *and* the modification time stay untouched.
 *  3. A file that changed since it was opened (compared by content hash, not by
 *     the millisecond mtime) is not overwritten: the caller's version goes to a
 *     conflict copy and the other writer's file is left alone.
 *  4. The same comparison runs again after the temporary file is written, right
 *     before the atomic rename, so a write that lands inside that window cannot
 *     be lost either.
 *  5. A file that vanished between open and save is written back and reported
 *     as recreated, so the text is never dropped and the user is told.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeDoc, encodeDoc, remapLineEndings, bytesEqual, type Eol } from '../shared/doc'

export interface SaveRequest {
  path: string
  text: string
  /** mtime the caller read, used only when no hash is available. */
  baseMtimeMs?: number
  /** sha256 of the bytes the caller read; the authoritative change check. */
  baseHash?: string
  eol?: Eol
  bom?: boolean
  /** Explicit per-line endings from an undoable history restore. */
  lineEndings?: string
  /** Overwrite whatever is on disk (Save As onto an existing path). */
  force?: boolean
  /** The user explicitly agreed to replace bytes that are not valid UTF-8. */
  acceptInvalidUtf8?: boolean
  /**
   * What to do when someone else's bytes are in the file instead of ours.
   * `copy` (the default) writes our version next to it; `report` writes nothing
   * and returns `code: 'conflict'`, which is what a background autosave uses so
   * a human gets to decide instead of waking up to a renamed document.
   */
  onConflict?: 'copy' | 'report'
}

export interface SaveSuccess {
  ok: true
  path: string
  mtimeMs: number
  size: number
  /** sha256 of the bytes now on disk. */
  hash: string
  /** Per-line endings of the text now on disk ('c' CRLF, 'l' LF, 'r' lone CR). */
  lineEndings: string
  eol: Eol
  bom: boolean
  /** True when the bytes already matched; nothing was written. */
  unchanged?: boolean
  /** Set when our version was written next to a file someone else changed. */
  conflictCopy?: string
  /** Set when the file had been deleted and this save created it again. */
  recreated?: boolean
}

export interface SaveFailure {
  ok: false
  error: string
  code?: string
}

export type SaveResult = SaveSuccess | SaveFailure

export interface SaveHooks {
  /** Receives the exact successful bytes; never awaited and cannot fail a save. */
  afterSave?: (path: string, bytes: Uint8Array) => void | Promise<unknown>
  /**
   * Called after the temporary file exists and before the atomic rename.
   * The unit tests use it to simulate a concurrent writer landing inside the
   * save window; production never passes it.
   */
  beforeRename?: () => Promise<void> | void
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `-` reads as "missing" and every other error is real. */
async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number; mode: number } | null> {
  try {
    const st = await fs.stat(path)
    return { mtimeMs: st.mtimeMs, size: st.size, mode: st.mode }
  } catch {
    return null
  }
}

function conflictCopyName(path: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const ext = path.endsWith('.md') ? '.md' : ''
  const base = ext ? path.slice(0, -ext.length) : path
  return `${base} (conflict ${stamp})${ext}`
}

/**
 * Write `bytes` to `path` through a temporary file in the same directory, then
 * rename it into place. `verify` runs after the temporary file is complete and
 * decides whether the rename may still happen.
 */
async function atomicWrite(
  path: string,
  bytes: Uint8Array,
  verify: () => Promise<'ok' | 'changed' | 'deleted'>,
  hooks: SaveHooks
): Promise<{ mtimeMs: number; size: number; recreated: boolean } | 'changed'> {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.typing-tmp-${process.pid}-${Date.now()}`)
  await fs.writeFile(tmp, bytes)
  try {
    const before = await statOrNull(path)
    if (before) await fs.chmod(tmp, before.mode)
    if (hooks.beforeRename) await hooks.beforeRename()
    const verdict = await verify()
    if (verdict === 'changed') {
      await fs.rm(tmp, { force: true }).catch(() => {})
      return 'changed'
    }
    // Windows refuses to replace a file another process has open (an editor, an
    // antivirus scanner, a sync client). Retry briefly, then fall back to writing
    // in place rather than losing the user's save.
    const delays = process.platform === 'win32' ? [0, 40, 120, 300] : [0]
    let lastError: unknown = null
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      try {
        await fs.rename(tmp, path)
        const st = await fs.stat(path)
        return { mtimeMs: st.mtimeMs, size: st.size, recreated: verdict === 'deleted' }
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      }
    }
    if (process.platform === 'win32') {
      try {
        await fs.writeFile(path, bytes)
        await fs.rm(tmp, { force: true }).catch(() => {})
        const st = await fs.stat(path)
        return { mtimeMs: st.mtimeMs, size: st.size, recreated: verdict === 'deleted' }
      } catch {
        /* fall through to the error the rename produced */
      }
    }
    throw lastError instanceof Error ? lastError : new Error('could not replace the file')
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Tell the caller that someone else owns the file right now; write nothing. */
function conflictReport(path: string): SaveFailure {
  return {
    ok: false,
    code: 'conflict',
    error: 'The file changed on disk since it was opened, so it was not written.'
  }
}

/** Has the file on disk moved away from the state the caller read? */
function changedSince(existing: Uint8Array, baseHash: string | undefined, baseMtimeMs: number | undefined, diskMtimeMs: number): boolean {
  if (baseHash) return hashBytes(existing) !== baseHash
  // No hash (older callers): fall back to the coarse mtime comparison.
  if (baseMtimeMs) return Math.abs(diskMtimeMs - baseMtimeMs) > 1
  return false
}

export async function writeDocument(request: SaveRequest, hooks: SaveHooks = {}): Promise<SaveResult> {
  const abs = resolve(request.path)
  const saved = (result: SaveSuccess, bytes: Uint8Array): SaveSuccess => {
    try {
      const task = hooks.afterSave?.(result.conflictCopy ?? result.path, bytes)
      if (task) void task.catch(() => {})
    } catch { /* History is best effort, never part of a user save's outcome. */ }
    return result
  }
  try {
    const existing = await readOrNull(abs)
    const existingStat = existing ? await statOrNull(abs) : null
    const disk = decodeDoc(existing ?? new Uint8Array())
    const eol: Eol = request.eol ?? disk.eol
    const bom = request.bom ?? disk.bom

    if (existing) {
      // Nothing to do: keep the bytes and the modification time exactly as they
      // are. This is what makes "open and save" a no-op for every encoding,
      // including files that mix CRLF, LF and lone CR.
      if (request.text === disk.text && (request.lineEndings === undefined || (!disk.validUtf8 && request.lineEndings === disk.lineEndings && bom === disk.bom) || bytesEqual(existing, encodeDoc({ text: request.text, eol, bom, lineEndings: request.lineEndings })))) {
        return saved({
          ok: true,
          path: abs,
          mtimeMs: existingStat?.mtimeMs ?? Date.now(),
          size: existing.length,
          hash: hashBytes(existing),
          lineEndings: disk.lineEndings,
          eol: disk.eol,
          bom: disk.bom,
          unchanged: true
        }, existing)
      }

      if (!disk.validUtf8 && !request.acceptInvalidUtf8 && !request.force) {
        return {
          ok: false,
          code: 'invalid-utf8',
          error:
            'This file contains bytes that are not valid UTF-8. Saving in place would replace them; use Save As to write a UTF-8 copy instead.'
        }
      }

      if (!request.force && changedSince(existing, request.baseHash, request.baseMtimeMs, existingStat?.mtimeMs ?? 0)) {
        if (request.onConflict === 'report') return conflictReport(abs)
        const copy = conflictCopyName(abs)
        const lineEndings = request.lineEndings ?? remapLineEndings(disk.text, disk.lineEndings, request.text, eol)
        const bytes = encodeDoc({ text: request.text, eol, lineEndings, bom })
        const written = await fs.writeFile(copy, bytes).then(() => statOrNull(copy))
        return saved({
          ok: true,
          path: abs,
          mtimeMs: written?.mtimeMs ?? Date.now(),
          size: bytes.length,
          hash: hashBytes(bytes),
          lineEndings,
          eol,
          bom,
          conflictCopy: copy
        }, bytes)
      }
    }

    const lineEndings = request.lineEndings ?? remapLineEndings(disk.text, disk.lineEndings, request.text, eol)
    const bytes = encodeDoc({ text: request.text, eol, lineEndings, bom })
    if (existing && bytesEqual(bytes, existing)) {
      return saved({
        ok: true,
        path: abs,
        mtimeMs: existingStat?.mtimeMs ?? Date.now(),
        size: existing.length,
        hash: hashBytes(existing),
        lineEndings,
        eol,
        bom,
        unchanged: true
      }, existing)
    }

    // Re-check immediately before the rename: a write that lands while our
    // temporary file is being prepared must not be replaced either.
    const verify = async (): Promise<'ok' | 'changed' | 'deleted'> => {
      if (request.force || !existing) return 'ok'
      const now = await readOrNull(abs)
      if (!now) return 'deleted'
      return bytesEqual(now, existing) ? 'ok' : 'changed'
    }
    const written = await atomicWrite(abs, bytes, verify, hooks)
    if (written === 'changed') {
      if (request.onConflict === 'report') return conflictReport(abs)
      const copy = conflictCopyName(abs)
      await fs.writeFile(copy, bytes)
      return saved({
        ok: true,
        path: abs,
        mtimeMs: (await statOrNull(copy))?.mtimeMs ?? Date.now(),
        size: bytes.length,
        hash: hashBytes(bytes),
        lineEndings,
        eol,
        bom,
        conflictCopy: copy
      }, bytes)
    }
    // `recreated` tells the renderer to say so: the file was there when it was
    // opened (so a hash or an mtime came with the request) and is not there now.
    const recreated = written.recreated || (!existing && Boolean(request.baseHash ?? request.baseMtimeMs))
    return saved({
      ok: true,
      path: abs,
      mtimeMs: written.mtimeMs,
      size: written.size,
      hash: hashBytes(bytes),
      lineEndings,
      eol,
      bom,
      ...(recreated ? { recreated } : {})
    }, bytes)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ok: false, error: e.message, code: e.code }
  }
}