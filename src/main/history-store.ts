import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { DEFAULT_HISTORY, HISTORY_MAX_FILE_BYTES, type HistoryConfig, type HistoryEntry, type HistoryListing, type HistoryReason } from '../shared/history'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const CHUNK = 64 * 1024
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
interface Snapshot extends HistoryEntry { chunks: string[] }
interface DocumentHistory { path: string; disabled: boolean; snapshots: Snapshot[] }
interface Index { version: 1; config: HistoryConfig; documents: Record<string, DocumentHistory>; blobs: Record<string, number> }
interface Options {
  now?: () => number
  log?: (error: unknown) => void
  maxFileBytes?: number
  /** Fault injection at the atomic manifest boundary, not used in production. */
  beforeCommit?: () => void | Promise<void>
}

/** Serialized, fail-open, content-addressed store. No Electron or document writes. */
export class HistoryStore {
  private index?: Index
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly maxFileBytes: number
  constructor(readonly directory: string, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now
    this.maxFileBytes = options.maxFileBytes ?? HISTORY_MAX_FILE_BYTES
  }

  private log(error: unknown): void {
    // Logging itself must not make a save fail.
    try { (this.options.log ?? ((e) => console.warn('[local history]', e)))(error) } catch { /* fail open */ }
  }

  private run<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      let previous: Index | undefined
      try {
        await this.load()
        previous = this.index
        // Copy-on-write: failure cannot leave an unpublished snapshot in memory.
        this.index = structuredClone(this.index!)
        return await operation()
      } catch (error) {
        this.index = previous
        this.log(error)
        return fallback
      }
    })
    this.queue = next.then(() => {}, () => {})
    return next
  }

  async flush(): Promise<void> { await this.queue }

  private async localDirectory(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: 0o700 })
    if ((await fs.lstat(path)).isSymbolicLink()) throw new Error('History directory must not be a symlink')
  }

  private async load(): Promise<void> {
    if (/^(\\\\|\/\/)/.test(this.directory)) throw new Error('History requires a local user-data directory')
    await this.localDirectory(this.directory)
    await this.localDirectory(join(this.directory, 'blobs'))
    if (this.index) return
    try {
      const raw = JSON.parse(await fs.readFile(join(this.directory, 'index.json'), 'utf8')) as Index
      if (raw.version !== 1 || !raw.documents || !raw.blobs || !raw.config) throw new Error('Unsupported history index')
      this.index = raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.index = { version: 1, config: { ...DEFAULT_HISTORY }, documents: {}, blobs: {} }
    }
  }

  private async identity(path: string): Promise<{ key: string; path: string }> {
    const absolute = resolve(path)
    const canonical = await fs.realpath(absolute).catch(async () => join(await fs.realpath(dirname(absolute)).catch(() => dirname(absolute)), basename(absolute)))
    const key = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    return { key, path: canonical }
  }

  private async atomic(path: string, bytes: Uint8Array | string, manifest = false): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
      if (manifest) await this.options.beforeCommit?.()
      await fs.rename(tmp, path)
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
  }

  private total(): number {
    return Object.values(this.index!.blobs).reduce((a, b) => a + b, 0) + Buffer.byteLength(JSON.stringify(this.index))
  }

  private pruneIndex(): void {
    const index = this.index!
    const { maxCount, maxAgeDays, maxBytes } = index.config
    const cutoff = this.now() - maxAgeDays * 86400_000
    for (const doc of Object.values(index.documents)) {
      doc.snapshots = doc.snapshots.filter((s, i, all) => i === all.length - 1 || s.time >= cutoff)
      if (doc.snapshots.length > maxCount) doc.snapshots.splice(0, doc.snapshots.length - maxCount)
    }
    const refs = new Map<string, number>()
    for (const doc of Object.values(index.documents)) for (const s of doc.snapshots) for (const c of s.chunks) refs.set(c, (refs.get(c) ?? 0) + 1)
    for (const key of Object.keys(index.blobs)) if (!refs.has(key)) delete index.blobs[key]
    let total = this.total()
    const candidates = Object.values(index.documents).flatMap(doc => doc.snapshots.slice(0, -1).map(s => ({ doc, s }))).sort((a, b) => a.s.time - b.s.time)
    for (const { doc, s } of candidates) {
      if (total <= maxBytes) break
      doc.snapshots.splice(doc.snapshots.indexOf(s), 1)
      total -= Buffer.byteLength(JSON.stringify(s)) + 1
      for (const c of s.chunks) {
        const remaining = (refs.get(c) ?? 1) - 1
        refs.set(c, remaining)
        if (!remaining) { total -= index.blobs[c] ?? 0; delete index.blobs[c] }
      }
    }
  }

  private async commit(): Promise<void> {
    this.pruneIndex()
    await this.atomic(join(this.directory, 'index.json'), JSON.stringify(this.index), true)
    // Publish manifest first. GC failure is harmless; an interrupted write only
    // leaves unreferenced blobs, never dangling committed references.
    try {
      for (const name of await fs.readdir(join(this.directory, 'blobs'))) {
        if (!this.index!.blobs[name] && /^[a-f0-9]{64}$/.test(name)) await fs.rm(join(this.directory, 'blobs', name), { force: true })
      }
    } catch (error) { this.log(error) }
  }

  capture(path: string, input: Uint8Array, reason: HistoryReason): Promise<boolean> {
    // Own the buffer before returning: caller edits/reuses cannot change it.
    if (input.byteLength > this.maxFileBytes) return Promise.resolve(false)
    const bytes = Buffer.from(input)
    return this.run(false, async () => {
      const index = this.index!
      const id = await this.identity(path)
      const doc = index.documents[id.key] ?? { path: id.path, disabled: false, snapshots: [] }
      if (!index.config.enabled || doc.disabled) return false
      const time = this.now()
      const digest = hash(bytes)
      const latest = doc.snapshots.at(-1)
      if (latest?.hash === digest) return false
      if (reason === 'save' && latest && time - latest.time < 60_000) return false
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const chunk = bytes.subarray(offset, offset + CHUNK)
        const key = hash(chunk)
        if (index.blobs[key] === undefined) {
          const zipped = await compress(chunk)
          await this.atomic(join(this.directory, 'blobs', key), zipped)
          index.blobs[key] = zipped.length
        }
        chunks.push(key)
      }
      doc.snapshots.push({ id: randomUUID(), time, hash: digest, size: bytes.length, reason, chunks })
      index.documents[id.key] = doc
      await this.commit()
      return true
    })
  }

  list(path?: string): Promise<HistoryListing> {
    const fallback: HistoryListing = { directory: this.directory, config: { ...DEFAULT_HISTORY }, disabled: false, snapshots: [], usedBytes: 0, overBudget: false, maxFileBytes: this.maxFileBytes, error: 'History is unavailable. Your documents can still be saved.' }
    return this.run(fallback, async () => {
      const doc = path ? this.index!.documents[(await this.identity(path)).key] : undefined
      return { directory: this.directory, config: { ...this.index!.config }, disabled: doc?.disabled ?? false,
        snapshots: [...(doc?.snapshots ?? [])].reverse().map(({ chunks: _chunks, ...entry }) => entry),
        usedBytes: this.total(), overBudget: this.total() > this.index!.config.maxBytes, maxFileBytes: this.maxFileBytes }
    })
  }

  read(path: string, id: string): Promise<Uint8Array | null> {
    return this.run(null, async () => {
      const doc = this.index!.documents[(await this.identity(path)).key]
      const snapshot = doc?.snapshots.find(s => s.id === id)
      if (!snapshot) return null
      const chunks: Buffer[] = []
      for (const key of snapshot.chunks) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid history chunk')
        const bytes = await decompress(await fs.readFile(join(this.directory, 'blobs', key)), { maxOutputLength: CHUNK })
        if (hash(bytes) !== key) throw new Error('History chunk checksum mismatch')
        chunks.push(bytes)
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== snapshot.size || hash(bytes) !== snapshot.hash) throw new Error('History snapshot checksum mismatch')
      return bytes
    })
  }

  configure(patch: Partial<HistoryConfig>): Promise<boolean> {
    return this.run(false, async () => {
      const config = this.index!.config
      if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled
      for (const key of ['maxCount', 'maxAgeDays', 'maxBytes'] as const) {
        if (typeof patch[key] === 'number' && Number.isFinite(patch[key]) && patch[key]! >= 1) config[key] = Math.floor(patch[key]!)
      }
      await this.commit(); return true
    })
  }

  setDisabled(path: string, disabled: boolean): Promise<boolean> {
    return this.run(false, async () => {
      const id = await this.identity(path)
      const doc = this.index!.documents[id.key] ?? { path: id.path, disabled: false, snapshots: [] }
      doc.disabled = disabled
      this.index!.documents[id.key] = doc
      await this.commit(); return true
    })
  }

  clear(path?: string): Promise<boolean> {
    return this.run(false, async () => {
      if (path) {
        const doc = this.index!.documents[(await this.identity(path)).key]
        if (doc) doc.snapshots = []
      } else for (const doc of Object.values(this.index!.documents)) doc.snapshots = []
      await this.commit(); return true
    })
  }

  prune(): Promise<boolean> { return this.run(false, async () => { await this.commit(); return true }) }
}
