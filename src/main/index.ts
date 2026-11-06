import { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net, nativeTheme, clipboard, Notification } from 'electron'
import { join, dirname, basename, resolve, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { promises as fs, watchFile, unwatchFile, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { decodeDoc, encodeDoc, bytesEqual } from '../shared/doc'
import { DEFAULT_PREFS, type Prefs, type DirEntry, type RecentFile } from '../shared/types'
import { buildMenu } from './menu'

const isDev = !app.isPackaged
const ASSET_SCHEME = 'typing-asset'

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
  }
])

let mainWindow: BrowserWindow | null = null
/** Directories that `typing-asset://` may serve from (document folders we opened). */
const assetRoots = new Set<string>()
/** Files currently open in the window, watched for external modification. */
const watched = new Map<string, { mtimeMs: number }>()

// ---------------------------------------------------------------------------
// Preferences / recents persistence
// ---------------------------------------------------------------------------

const userDataDir = (): string => app.getPath('userData')
const prefsPath = (): string => join(userDataDir(), 'preferences.json')
const recentsPath = (): string => join(userDataDir(), 'recent-files.json')
const recoveryDir = (): string => join(userDataDir(), 'recovery')

let prefsCache: Prefs | null = null

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return { ...fallback, ...(JSON.parse(raw) as T) }
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

async function getPrefs(): Promise<Prefs> {
  if (!prefsCache) prefsCache = await readJson<Prefs>(prefsPath(), DEFAULT_PREFS)
  return prefsCache
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

interface SavePayload {
  path: string
  text: string
  baseMtimeMs?: number
  eol?: '\n' | '\r\n'
  bom?: boolean
  /** Write even if the file changed on disk (used after an explicit user choice). */
  force?: boolean
}

async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(path)
    if (!st.isFile()) return null
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<{ mtimeMs: number; size: number }> {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.typing-tmp-${process.pid}-${Date.now()}`)
  await fs.writeFile(tmp, bytes)
  let mode: number | undefined
  try {
    mode = (await fs.stat(path)).mode
  } catch {
    mode = undefined
  }
  if (mode !== undefined) await fs.chmod(tmp, mode)
  try {
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  const st = await fs.stat(path)
  return { mtimeMs: st.mtimeMs, size: st.size }
}

function conflictCopyName(path: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const ext = path.endsWith('.md') ? '.md' : ''
  const base = ext ? path.slice(0, -ext.length) : path
  return `${base} (conflict ${stamp})${ext}`
}

async function readFileForEditor(path: string): Promise<unknown> {
  const abs = resolve(path)
  try {
    const bytes = new Uint8Array(await fs.readFile(abs))
    const doc = decodeDoc(bytes)
    assetRoots.add(dirname(abs))
    const st = await fs.stat(abs)
    watchDocument(abs, st.mtimeMs)
    const recents = await readJson<{ items: RecentFile[] }>(recentsPath(), { items: [] })
    const items = [
      { path: abs, name: basename(abs), openedAt: Date.now() },
      ...recents.items.filter((r) => r.path !== abs)
    ].slice(0, 25)
    await writeJson(recentsPath(), { items })
    return {
      ok: true,
      path: abs,
      text: doc.text,
      size: bytes.length,
      mtimeMs: st.mtimeMs,
      bom: doc.bom,
      eol: doc.eol,
      validUtf8: doc.validUtf8
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, code: (err as NodeJS.ErrnoException).code }
  }
}

function watchDocument(path: string, mtimeMs: number): void {
  if (watched.has(path)) return
  watched.set(path, { mtimeMs })
  watchFile(path, { interval: 1500 }, async (curr) => {
    const known = watched.get(path)
    if (!known) return
    if (curr.mtimeMs !== known.mtimeMs) {
      known.mtimeMs = curr.mtimeMs
      mainWindow?.webContents.send('typing:event', 'file:external-change', { path, mtimeMs: curr.mtimeMs })
    }
  })
}

function unwatchDocument(path: string): void {
  unwatchFile(path)
  watched.delete(path)
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

type Handler = (args: any[]) => Promise<unknown> | unknown

const handlers: Record<string, Handler> = {
  async appInfo() {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  },
  async 'prefs.get'() {
    return getPrefs()
  },
  async 'prefs.set'([patch]) {
    const next = { ...(await getPrefs()), ...patch } as Prefs
    prefsCache = next
    await writeJson(prefsPath(), next)
    if (patch.theme) applyTheme(next.theme)
    return next
  },
  async 'dialog.openFile'() {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  },
  async 'dialog.openFolder'() {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    const dir = result.filePaths[0]
    assetRoots.add(resolve(dir))
    return dir
  },
  async 'dialog.pickImage'() {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  },
  async 'dialog.saveAs'([suggested]) {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: suggested || undefined,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  },
  async 'file.read'([path]) {
    return readFileForEditor(String(path))
  },
  async 'file.stat'([path]) {
    return statOrNull(String(path))
  },
  async 'file.exists'([path]) {
    return existsSync(String(path))
  },
  async 'file.save'([payload]) {
    return saveDocument(payload as SavePayload)
  },
  async 'file.saveAs'([payload]) {
    const p = payload as SavePayload
    assetRoots.add(dirname(resolve(p.path)))
    return saveDocument({ ...p, force: true })
  },
  async 'dir.list'([path]) {
    const dir = resolve(String(path))
    assetRoots.add(dir)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const out: DirEntry[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name === 'node_modules') continue
      out.push({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() })
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return out
  },
  async 'dir.walk'([path, limit]) {
    const root = resolve(String(path))
    assetRoots.add(root)
    const max = Number(limit) || 4000
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= max || depth > 8) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= max) return
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full, depth + 1)
        else if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(e.name)) out.push(relative(root, full))
      }
    }
    await walk(root, 0)
    return out.sort((a, b) => a.localeCompare(b))
  },
  async 'recents.list'() {
    const r = await readJson<{ items: RecentFile[] }>(recentsPath(), { items: [] })
    return r.items
  },
  async 'recents.clear'() {
    await writeJson(recentsPath(), { items: [] })
    return true
  },
  async 'recents.add'([entry]) {
    const e = entry as RecentFile
    const r = await readJson<{ items: RecentFile[] }>(recentsPath(), { items: [] })
    const items = [e, ...r.items.filter((i) => i.path !== e.path)].slice(0, 25)
    await writeJson(recentsPath(), { items })
    return items
  },
  async 'window.setTitle'([title, filePath]) {
    if (!mainWindow) return false
    mainWindow.setTitle(String(title))
    mainWindow.setDocumentEdited(Boolean(title && title.startsWith('•')))
    if (filePath) mainWindow.setRepresentedFilename(String(filePath))
    return true
  },
  async 'window.setRepresentedFile'([filePath]) {
    mainWindow?.setRepresentedFilename(String(filePath))
    return true
  },
  async 'window.setDocumentEdited'([edited]) {
    mainWindow?.setDocumentEdited(Boolean(edited))
    return true
  },
  async 'assets.saveImage'([payload]) {
    // payload: { docPath, dataUrl, suggestedName }
    const p = payload as { docPath: string | null; dataUrl: string; suggestedName?: string }
    const baseDir = p.docPath ? dirname(p.docPath) : (await getPrefs()).lastFolder
    if (!baseDir) return { ok: false, error: 'Save the document first, then paste images.' }
    const assetsDir = join(baseDir, 'assets')
    assetRoots.add(baseDir)
    await fs.mkdir(assetsDir, { recursive: true })
    const m = /^data:(image\/([a-zA-Z0-9.+-]+));base64,(.*)$/s.exec(p.dataUrl)
    if (!m) return { ok: false, error: 'Unsupported image data' }
    const ext = m[2].replace('jpeg', 'jpg').replace('svg+xml', 'svg')
    const safe = (p.suggestedName || 'image').replace(/[^\w.-]+/g, '-').slice(0, 40)
    let name = `${safe}-${Date.now().toString(36)}.${ext}`
    let target = join(assetsDir, name)
    let i = 1
    while (existsSync(target)) {
      name = `${safe}-${Date.now().toString(36)}-${i++}.${ext}`
      target = join(assetsDir, name)
    }
    const bytes = Buffer.from(m[3], 'base64')
    await fs.writeFile(target, bytes)
    return { ok: true, path: target, relative: `assets/${name}` }
  },
  async 'export.html'([payload]) {
    const p = payload as { html: string; suggestedPath?: string }
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: p.suggestedPath,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
    await fs.writeFile(result.filePath, p.html, 'utf8')
    return { ok: true, path: result.filePath }
  },
  async 'export.pdf'([payload]) {
    const p = payload as { html: string; suggestedPath?: string; title?: string }
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: p.suggestedPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
    const tmp = join(tmpdir(), `typing-print-${process.pid}-${Date.now()}.html`)
    await fs.writeFile(tmp, p.html, 'utf8')
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, offscreen: false }
    })
    try {
      await win.loadFile(tmp)
      await new Promise((r) => setTimeout(r, 250))
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 },
        preferCSSPageSize: true
      })
      await fs.writeFile(result.filePath, pdf)
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      win.destroy()
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  },
  async 'recovery.save'([draft]) {
    const d = draft as { path: string | null; text: string; savedAt: number; baseMtimeMs: number }
    const key = createHash('sha1')
      .update(d.path ?? `untitled-${d.savedAt}`)
      .digest('hex')
      .slice(0, 16)
    await fs.mkdir(recoveryDir(), { recursive: true })
    const target = join(recoveryDir(), `${key}.json`)
    await writeJson(target, { ...d, key, name: d.path ? basename(d.path) : 'Untitled' })
    return key
  },
  async 'recovery.clear'([target]) {
    const raw = String(target ?? '')
    const key = /^[0-9a-f]{16}$/.test(raw)
      ? raw
      : createHash('sha1').update(raw).digest('hex').slice(0, 16)
    await fs.rm(join(recoveryDir(), `${key}.json`), { force: true })
    return true
  },
  async 'recovery.list'() {
    try {
      const names = await fs.readdir(recoveryDir())
      const out = []
      for (const n of names) {
        if (!n.endsWith('.json')) continue
        try {
          const raw = JSON.parse(await fs.readFile(join(recoveryDir(), n), 'utf8'))
          out.push(raw)
        } catch {
          /* ignore malformed drafts */
        }
      }
      return out
    } catch {
      return []
    }
  },
  async 'recovery.read'([file]) {
    const key = createHash('sha1').update(String(file)).digest('hex').slice(0, 16)
    try {
      return JSON.parse(await fs.readFile(join(recoveryDir(), `${key}.json`), 'utf8'))
    } catch {
      return null
    }
  },
  async 'shell.openExternal'([url]) {
    const s = String(url)
    if (!/^https?:\/\/|^mailto:/i.test(s) && !s.startsWith('#')) return false
    await shell.openExternal(s)
    return true
  },
  async 'shell.showItemInFolder'([path]) {
    shell.showItemInFolder(String(path))
    return true
  },
  async 'clipboard.readImage'() {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toDataURL()
  },
  async notify([payload]) {
    const p = payload as { title: string; body: string }
    if (!Notification.isSupported()) return false
    new Notification({ title: p.title, body: p.body, silent: true }).show()
    return true
  }
}

async function saveDocument(p: SavePayload): Promise<unknown> {
  const abs = resolve(p.path)
  try {
    const existing = await fs.readFile(abs).catch(() => null)
    const stat = existing ? await fs.stat(abs) : null
    const doc = decodeDoc(existing ?? new Uint8Array())
    const bytes = encodeDoc({
      text: p.text,
      eol: p.eol ?? doc.eol,
      bom: p.bom ?? doc.bom,
      validUtf8: true
    })
    if (existing && bytesEqual(bytes, new Uint8Array(existing))) {
      return { ok: true, path: abs, mtimeMs: stat?.mtimeMs ?? Date.now(), size: bytes.length, unchanged: true }
    }
    // Never overwrite someone else's newer version without the caller asking.
    if (existing && p.baseMtimeMs && stat && Math.abs(stat.mtimeMs - p.baseMtimeMs) > 1 && !p.force) {
      const copy = conflictCopyName(abs)
      await atomicWrite(copy, bytes)
      return {
        ok: true,
        path: abs,
        conflictCopy: copy,
        mtimeMs: p.baseMtimeMs,
        size: bytes.length
      }
    }
    const result = await atomicWrite(abs, bytes)
    watchDocument(abs, result.mtimeMs)
    return { ok: true, path: abs, ...result }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ok: false, error: e.message, code: e.code }
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function applyTheme(mode: Prefs['theme']): void {
  nativeTheme.themeSource = mode
}

function sendCommand(command: string, payload?: unknown): void {
  mainWindow?.webContents.send('typing:event', 'menu:command', { command, payload })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Typing',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e22' : '#faf9f7',
    vibrancy: undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    for (const path of [...watched.keys()]) unwatchDocument(path)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (!current.startsWith('file:') || !url.startsWith('file:')) {
      if (!url.startsWith(current.split('#')[0])) event.preventDefault()
    }
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('typing:event', 'window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('typing:event', 'window:fullscreen', false))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (mainWindow) {
    mainWindow.webContents.send('typing:event', 'file:open-request', { path })
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    pendingOpenPath = path
  }
})

let pendingOpenPath: string | null = null

function fileFromArgv(argv: string[]): string | null {
  const candidate = argv
    .slice(1)
    .reverse()
    .find((a) => !a.startsWith('-') && /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(a))
  return candidate ? resolve(candidate) : null
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const file = fileFromArgv(argv)
    if (file && mainWindow) mainWindow.webContents.send('typing:event', 'file:open-request', { path: file })
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Serve only files inside folders the user has opened. No remote loading.
    protocol.handle(ASSET_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        const raw = decodeURIComponent(url.pathname.replace(/^\//, ''))
        const abs = resolve(raw)
        const allowed = [...assetRoots].some((root) => abs === root || abs.startsWith(root + sep))
        if (!allowed) return new Response('forbidden', { status: 403 })
        return await net.fetch(pathToFileURL(abs).toString())
      } catch (err) {
        return new Response(`error: ${(err as Error).message}`, { status: 500 })
      }
    })

    ipcMain.handle('typing:call', async (_event, method: string, args: unknown[]) => {
      const handler = handlers[method]
      if (!handler) return { ok: false, error: `unknown method ${method}` }
      try {
        return await handler(args ?? [])
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
    ipcMain.handle('typing:command', (_event, command: string, payload?: unknown) => {
      sendCommand(command, payload)
      return true
    })
    ipcMain.on('typing:menu', () => {
      Menu.setApplicationMenu(buildMenu(sendCommand, getPrefsSnapshot()))
    })

    const prefs = await getPrefs()
    applyTheme(prefs.theme)
    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('typing:event', 'theme:changed', {
        dark: nativeTheme.shouldUseDarkColors,
        source: nativeTheme.themeSource
      })
    })

    createWindow()
    Menu.setApplicationMenu(buildMenu(sendCommand, prefs))

    const initial = pendingOpenPath ?? fileFromArgv(process.argv)
    pendingOpenPath = null
    if (initial) {
      mainWindow?.webContents.once('did-finish-load', () =>
        mainWindow?.webContents.send('typing:event', 'file:open-request', { path: initial })
      )
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

function getPrefsSnapshot(): Prefs {
  return prefsCache ?? DEFAULT_PREFS
}

export { isDev, assetRoots }