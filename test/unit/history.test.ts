import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HistoryStore } from '../../src/main/history-store'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
async function setup(options: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'typing-history-unit-')); dirs.push(dir)
  let now = 1_000_000
  const errors: unknown[] = []
  const store = new HistoryStore(join(dir, 'history'), { now: () => now, log: (e: unknown) => errors.push(e), ...options })
  const path = join(dir, 'document.md')
  return { dir, path, store, errors, tick: (ms = 60_000) => { now += ms } }
}
const bytes = (s: string) => Buffer.from(s)

describe('local history store', () => {
  it('dedupes identical newest bytes and strictly throttles ordinary saves to one per minute', async () => {
    const { store, path, tick } = await setup()
    expect(await store.capture(path, bytes('one'), 'save')).toBe(true)
    expect(await store.capture(path, bytes('one'), 'save')).toBe(false)
    expect(await store.capture(path, bytes('two'), 'save')).toBe(false)
    tick()
    expect(await store.capture(path, bytes('two'), 'save')).toBe(true)
    expect(await store.capture(path, bytes('three'), 'before-restore')).toBe(true)
    expect((await store.list(path)).snapshots.map(x => x.reason)).toEqual(['before-restore', 'save', 'save'])
  })

  it.each(['one\ntwo\n', 'one\r\ntwo\r\n', '\ufeffone\r\ntwo\nthree\rfour', '\ufeff'])('restores exact bytes %j across restart', async raw => {
    const { store, path, dir } = await setup()
    await store.capture(path, bytes(raw), 'save')
    const fresh = new HistoryStore(join(dir, 'history'))
    const snapshot = (await fresh.list(path)).snapshots[0]
    expect(Buffer.from((await fresh.read(path, snapshot.id))!)).toEqual(bytes(raw))
  })

  it('shares unchanged compressed chunks rather than storing hundreds of whole documents', async () => {
    const { store, path, tick, dir } = await setup()
    const original = Buffer.alloc(1024 * 1024, 'x')
    for (let i = 0; i < 40; i++) {
      original.write(String(i).padStart(3, '0'), 50_000)
      await store.capture(path, original, 'save'); tick()
    }
    const blobs = await fs.readdir(join(dir, 'history', 'blobs'))
    expect(blobs.length).toBeLessThanOrEqual(41)
    expect((await store.list(path)).snapshots).toHaveLength(40)
    expect(Buffer.from((await store.read(path, (await store.list(path)).snapshots[0].id))!)).toEqual(original)
  })

  it('prunes count and age oldest first but always keeps each newest', async () => {
    const { store, path, tick } = await setup()
    await store.configure({ maxCount: 2, maxAgeDays: 1 })
    for (const text of ['a', 'b', 'c']) { await store.capture(path, bytes(text), 'save'); tick() }
    expect((await store.list(path)).snapshots).toHaveLength(2)
    tick(2 * 86400_000)
    await store.prune()
    const remaining = (await store.list(path)).snapshots
    expect(remaining).toHaveLength(1)
    expect(Buffer.from((await store.read(path, remaining[0].id))!).toString()).toBe('c')
  })

  it('global disk cap prunes oldest snapshots and orphan blobs, never latest of any path', async () => {
    const { store, path, dir, tick } = await setup()
    const other = join(dir, 'other.md')
    for (const file of [path, other]) {
      for (let i = 0; i < 3; i++) { await store.capture(file, bytes(`${file}-${i}`), 'save'); tick() }
    }
    // Deliberately impossible budget: latest entries still survive.
    await store.configure({ maxBytes: 1 })
    expect((await store.list(path)).snapshots).toHaveLength(1)
    expect((await store.list(other)).snapshots).toHaveLength(1)
    expect(await fs.readdir(join(dir, 'history', 'blobs'))).toHaveLength(2)
    expect((await store.list(path)).overBudget).toBe(true)
  })

  it('supports global and per-document opt out, size exclusion, and clears', async () => {
    const { store, path } = await setup({ maxFileBytes: 10 })
    expect(await store.capture(path, bytes('too large document'), 'save')).toBe(false)
    await store.configure({ enabled: false })
    expect(await store.capture(path, bytes('one'), 'before-reload')).toBe(false)
    await store.configure({ enabled: true })
    await store.setDisabled(path, true)
    expect(await store.capture(path, bytes('one'), 'save')).toBe(false)
    await store.setDisabled(path, false)
    await store.capture(path, bytes('one'), 'save')
    await store.clear(path)
    expect((await store.list(path)).snapshots).toHaveLength(0)
    await store.capture(path, bytes('two'), 'save')
    await store.clear()
    expect((await store.list(path)).snapshots).toHaveLength(0)
  })

  it('canonical aliases share history; rename starts a separate path history', async () => {
    const { store, path, dir } = await setup()
    await fs.writeFile(path, 'one')
    const alias = join(dir, 'alias.md'); await fs.symlink(path, alias)
    await store.capture(alias, bytes('one'), 'save')
    expect((await store.list(path)).snapshots).toHaveLength(1)
    const moved = join(dir, 'moved.md'); await fs.rename(path, moved)
    expect((await store.list(moved)).snapshots).toHaveLength(0)
    expect((await store.list(path)).snapshots).toHaveLength(1)
    expect(await store.read(moved, (await store.list(path)).snapshots[0].id)).toBeNull()
  })

  it('atomic manifest failure preserves prior history on disk and is logged and swallowed', async () => {
    let fail = false
    const { store, path, dir, tick, errors } = await setup({ beforeCommit: () => { if (fail) throw new Error('injected rename failure') } })
    await store.capture(path, bytes('original'), 'save'); tick(); fail = true
    expect(await store.capture(path, bytes('new'), 'save')).toBe(false)
    expect(errors.length).toBe(1)
    const fresh = new HistoryStore(join(dir, 'history'))
    const list = (await fresh.list(path)).snapshots
    expect(list).toHaveLength(1)
    expect(Buffer.from((await fresh.read(path, list[0].id))!).toString()).toBe('original')
    expect((await fs.readdir(join(dir, 'history'))).some(x => x.includes('.tmp-'))).toBe(false)
    // Recovery: a failed write must not poison the in-memory index or queue.
    fail = false
    expect(await store.capture(path, bytes('recovered'), 'save')).toBe(true)
    expect((await store.list(path)).snapshots).toHaveLength(2)
  })

  it('directory failure cannot reject capture or a caller save', async () => {
    const { dir, path } = await setup()
    const broken = join(dir, 'not-a-directory'); await fs.writeFile(broken, 'blocked')
    const errors: unknown[] = []
    const store = new HistoryStore(broken, { log: e => errors.push(e) })
    expect(await store.capture(path, bytes('saved'), 'save')).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it('refuses a network filesystem rather than writing private snapshots there', async () => {
    const { dir, path } = await setup()
    const stat = await fs.statfs(dir)
    const spy = vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stat, type: process.platform === 'darwin' ? 2 : 0x6969 })
    try {
      const store = new HistoryStore(join(dir, 'remote-history'), { log: () => {} })
      expect(await store.capture(path, bytes('private'), 'save')).toBe(false)
      expect(await fs.stat(join(dir, 'remote-history')).catch(() => null)).toBeNull()
    } finally { spy.mockRestore() }
  })

  it('refuses a known synced user-data location', async () => {
    const { dir, path } = await setup()
    const cloud = join(dir, 'CloudStorage'); await fs.mkdir(cloud)
    const store = new HistoryStore(join(cloud, 'history'), { log: () => {} })
    expect(await store.capture(path, bytes('private'), 'save')).toBe(false)
    expect(await fs.readdir(cloud)).toEqual([])
  })

  it('persists opt-outs and settings across restart, clears content without erasing exclusions', async () => {
    const { store, path, dir } = await setup()
    await store.capture(path, bytes('private'), 'save')
    await store.setDisabled(path, true)
    await store.configure({ enabled: false, maxCount: 50 })
    await store.clear()
    const fresh = new HistoryStore(join(dir, 'history'))
    const listing = await fresh.list(path)
    expect(listing.config.enabled).toBe(false)
    expect(listing.config.maxCount).toBe(50)
    expect(listing.disabled).toBe(true)
    expect(listing.snapshots).toEqual([])
    expect(await fs.readdir(join(dir, 'history', 'blobs'))).toEqual([])
  })

  it('refuses redirected history directories rather than writing alongside other files', async () => {
    const { dir, path } = await setup()
    const elsewhere = join(dir, 'elsewhere'); await fs.mkdir(elsewhere)
    const root = join(dir, 'redirected'); await fs.symlink(elsewhere, root)
    const store = new HistoryStore(root, { log: () => {} })
    expect(await store.capture(path, bytes('secret'), 'save')).toBe(false)
    expect(await fs.readdir(elsewhere)).toEqual([])
  })
})
