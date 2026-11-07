import { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net, nativeTheme, clipboard, Notification } from 'electron'
import { join, dirname, basename, resolve, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { promises as fs, watchFile, unwatchFile, existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { decodeDoc } from '../shared/doc'
import { writeDocument, hashBytes, type SaveRequest } from './save-doc'
import { isInsidePath } from '../shared/paths'
import { pathFromAssetUrl } from '../shared/assets'
import { DEFAULT_PREFS, type Prefs, type DirEntry, type RecentFile } from '../shared/types'
import { buildMenu } from './menu'
import { filesFromArgv } from './startup'

const isDev = !app.isPackaged
const isMac = process.platform === 'darwin'
const ASSET_SCHEME = 'typing-asset'

// Windows needs an explicit AppUserModelID for notifications and for grouping the
// taskbar entry; it must match the appId in package.json.
if (process.platform === 'win32') app.setAppUserModelId('dev.danny.typing')

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false }
  }
])

// Honour Chromium's data-directory switch for Typing's own files too, so a test
// or a portable run keeps preferences, recents and recovery drafts together.
const userDataOverride = process.argv.find((arg) => arg.startsWith('--user-data-dir='))
if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride.slice('--user-data-dir='.length)))
}

let mainWindow: BrowserWindow | null = null
let rendererReady = false
/** Set once the renderer has confirmed that closing is safe. */
let allowClose = false
let quitRequested = false
/** Directories that `typing-asset://` may serve from (document folders we opened). */
const assetRoots = new Set<string>()
/** Files currently open in the window, watched for external modification. */
const watched = new Map<string, { mtimeMs: number; size: number }>()

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

async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(path)
    if (!st.isFile()) return null
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/**
 * Remember a directory as a source of `typing-asset://` files. The path is
 * resolved through every symlink first, and the protocol handler resolves the
 * requested path the same way, so a symlink inside an opened folder cannot read
 * a file outside it.
 */
async function addAssetRoot(dir: string): Promise<void> {
  const abs = resolve(dir)
  try {
    assetRoots.add(await fs.realpath(abs))
  } catch {
    assetRoots.add(abs)
  }
}

async function readFileForEditor(path: string, track = true): Promise<unknown> {
  const abs = await fs.realpath(resolve(path)).catch(() => resolve(path))
  try {
    const bytes = new Uint8Array(await fs.readFile(abs))
    const doc = decodeDoc(bytes)
    const st = await fs.stat(abs)
    if (track) {
      await addAssetRoot(dirname(abs))
      watchDocument(abs, st.mtimeMs, st.size)
      const recents = await readJson<{ items: RecentFile[] }>(recentsPath(), { items: [] })
      const items = [
        { path: abs, name: basename(abs), openedAt: Date.now() },
        ...recents.items.filter((r) => r.path !== abs)
      ].slice(0, 25)
      await writeJson(recentsPath(), { items })
    }
    return {
      ok: true,
      path: abs,
      text: doc.text,
      size: bytes.length,
      mtimeMs: st.mtimeMs,
      hash: hashBytes(bytes),
      bom: doc.bom,
      eol: doc.eol,
      lineEndings: doc.lineEndings,
      validUtf8: doc.validUtf8
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, code: (err as NodeJS.ErrnoException).code }
  }
}

function watchDocument(path: string, mtimeMs: number, size: number): void {
  if (watched.has(path)) {
    watched.set(path, { mtimeMs, size })
    return
  }
  watched.set(path, { mtimeMs, size })
  watchFile(path, { interval: 1500 }, async (curr) => {
    const known = watched.get(path)
    if (!known) return
    if (curr.mtimeMs !== known.mtimeMs || curr.size !== known.size) {
      known.mtimeMs = curr.mtimeMs
      known.size = curr.size
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

// Order save/clear requests per recovery identity, including in-flight IPC.
const recoveryWrites = new Map<string, Promise<unknown>>()
async function recoveryWrite(key: string, operation: () => Promise<unknown>): Promise<void> {
  const previous = recoveryWrites.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  recoveryWrites.set(key, next)
  try { await next } finally { if (recoveryWrites.get(key) === next) recoveryWrites.delete(key) }
}

type Handler = (args: any[]) => Promise<unknown> | unknown

const handlers: Record<string, Handler> = {
  async 'renderer.ready'() {
    rendererReady = true
    for (const path of pendingOpenPaths.splice(0)) openPathFromOutside(path)
    return true
  },
  async appInfo() {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      home: app.getPath('home'),
      userData: app.getPath('userData')
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
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths
  },
  async 'dialog.openFolder'() {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    const dir = result.filePaths[0]
    await addAssetRoot(dir)
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
    // Test seam: the automated suite cannot drive a native save panel, so with
    // TYPING_TEST=1 it can script the answer through a file it controls
    // (empty or "canceled" = the user cancelled). Inert without the env vars.
    const scripted = await scriptedSaveAs()
    if (scripted !== undefined) return scripted
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: suggested || undefined,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  },
  async 'file.resolve'([path]) {
    return fs.realpath(resolve(String(path))).catch(() => resolve(String(path)))
  },
  async 'file.read'([path]) {
    return readFileForEditor(String(path))
  },
  async 'file.peek'([path]) {
    return readFileForEditor(String(path), false)
  },
  async 'file.release'([path]) {
    unwatchDocument(String(path))
    return true
  },
  async 'file.stat'([path]) {
    return statOrNull(String(path))
  },
  async 'file.exists'([path]) {
    return existsSync(String(path))
  },
  async 'file.save'([payload]) {
    return saveDocument(payload as SaveRequest)
  },
  async 'file.saveAs'([payload]) {
    const p = payload as SaveRequest
    await addAssetRoot(dirname(resolve(p.path)))
    return saveDocument({ ...p, force: true })
  },
  async 'dir.list'([path]) {
    const dir = resolve(String(path))
    await addAssetRoot(dir)
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
    await addAssetRoot(root)
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
        // Relative paths always use forward slashes: they are document-relative
        // names for quick open and for markdown links, not OS paths.
        if (e.isDirectory()) await walk(full, depth + 1)
        else if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(e.name)) out.push(relative(root, full).split(sep).join('/'))
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
  async 'menu.sourceMode'([source]) {
    Menu.setApplicationMenu(buildMenu(sendCommand, { ...getPrefsSnapshot(), sourceMode: Boolean(source) }))
    return true
  },
  async 'window.cancelClose'() {
    quitRequested = false
    return true
  },
  async 'window.setTitle'([title, filePath]) {
    if (!mainWindow) return false
    mainWindow.setTitle(String(title))
    if (isMac) {
      mainWindow.setDocumentEdited(Boolean(title && title.startsWith('•')))
      if (filePath) mainWindow.setRepresentedFilename(String(filePath))
    }
    return true
  },
  async 'window.setRepresentedFile'([filePath]) {
    if (isMac) mainWindow?.setRepresentedFilename(String(filePath))
    return true
  },
  async 'window.close'([force]) {
    if (!mainWindow) return false
    if (!force) return false
    allowClose = true
    mainWindow.close()
    // A quit that was interrupted by the unsaved-changes guard completes here.
    if (quitRequested) setTimeout(() => app.quit(), 50)
    return true
  },
  async 'window.setDocumentEdited'([edited]) {
    // Only macOS has the dot in the close button; the title marker works on all
    // platforms and is set from the renderer.
    if (isMac) mainWindow?.setDocumentEdited(Boolean(edited))
    return true
  },
  async 'assets.saveImage'([payload]) {
    // payload: { docPath, dataUrl, suggestedName }
    const p = payload as { docPath: string | null; dataUrl: string; suggestedName?: string }
    const baseDir = p.docPath ? dirname(p.docPath) : (await getPrefs()).lastFolder
    if (!baseDir) return { ok: false, error: 'Save the document first, then paste images.' }
    const assetsDir = join(baseDir, 'assets')
    await addAssetRoot(baseDir)
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
    const p = payload as { html: string; suggestedPath?: string; path?: string }
    let target = p.path
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: p.suggestedPath,
        filters: [{ name: 'HTML', extensions: ['html'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
      target = result.filePath
    }
    await fs.writeFile(target, p.html, 'utf8')
    return { ok: true, path: target }
  },
  async 'export.pdf'([payload]) {
    const p = payload as { html: string; suggestedPath?: string; title?: string; path?: string }
    let target = p.path
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: p.suggestedPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
      target = result.filePath
    }
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
      await fs.writeFile(target, pdf)
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      win.destroy()
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  },
  async 'recovery.save'([draft]) {
    const d = draft as { key?: string; path: string | null; text: string; savedAt: number; baseMtimeMs: number }
    const key = d.key && /^[0-9a-f]{16}$/.test(d.key) ? d.key : createHash('sha1')
      .update(d.path ?? `untitled-${d.savedAt}`).digest('hex').slice(0, 16)
    await recoveryWrite(key, async () => {
      const target = join(recoveryDir(), `${key}.json`)
      await writeJson(target, { ...d, key, name: d.path ? basename(d.path) : 'Untitled' })
    })
    return key
  },
  async 'recovery.clear'([target]) {
    const raw = String(target ?? '')
    const key = /^[0-9a-f]{16}$/.test(raw)
      ? raw
      : createHash('sha1').update(raw).digest('hex').slice(0, 16)
    await recoveryWrite(key, () => fs.rm(join(recoveryDir(), `${key}.json`), { force: true }))
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
    const items = await clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const payload = await item.getType(type)
      if (payload instanceof Blob) {
        const bytes = Buffer.from(await payload.arrayBuffer())
        return `data:${type};base64,${bytes.toString('base64')}`
      }
    }
    return null
  },
  async 'app.doc'([name]) {
    const allowed = new Set(['README.md', 'USAGE.md', 'THIRD_PARTY.md'])
    const file = String(name)
    if (!allowed.has(file)) return null
    try {
      return await fs.readFile(join(app.getAppPath(), file), 'utf8')
    } catch {
      return null
    }
  },
  async notify([payload]) {
    const p = payload as { title: string; body: string }
    if (!Notification.isSupported()) return false
    new Notification({ title: p.title, body: p.body, silent: true }).show()
    return true
  }
}

async function saveDocument(p: SaveRequest): Promise<unknown> {
  const result = await writeDocument(p)
  if (result.ok) {
    if (result.conflictCopy) watchDocument(result.conflictCopy, result.mtimeMs, result.size)
    else watchDocument(result.path, result.mtimeMs, result.size)
  }
  return result
}

/** See `dialog.saveAs`: scripted answer for the automated suite only. */
async function scriptedSaveAs(): Promise<string | null | undefined> {
  if (process.env.TYPING_TEST !== '1') return undefined
  const file = process.env.TYPING_TEST_SAVE_AS_FILE
  if (!file) return undefined
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  const value = raw.trim()
  return value && value !== 'canceled' ? value : null
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
  rendererReady = false
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Typing',
    // macOS hides the title bar and keeps the traffic lights; Windows and Linux
    // keep the native frame, caption buttons and menu bar the platform expects.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } } : {}),
    autoHideMenuBar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e22' : '#faf9f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (allowClose) return
    // Never lose unsaved work on ⌘W/⌘Q: ask the renderer first.
    event.preventDefault()
    sendCommand('app.close')
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    allowClose = false
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

// macOS delivers Finder double-clicks and Dock drops here. Windows has no such
// event: it passes the file on the command line (`Typing.exe C:\a\b.md`, which is
// what "Open with" and dragging onto the executable produce) and reaches a
// running instance through `second-instance` below.
app.on('open-file', (event, path) => {
  if (!isMac) return
  event.preventDefault()
  if (mainWindow) {
    openPathFromOutside(path)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    pendingOpenPaths.push(path)
  }
})

const pendingOpenPaths: string[] = []

/** A path from the command line, an "open with", a dock drop or a drag. */
function openPathFromOutside(path: string): void {
  if (!rendererReady) { pendingOpenPaths.push(path); return }
  const abs = resolve(path)
  try {
    if (existsSync(path) && statSync(path).isDirectory()) {
      void addAssetRoot(path)
      mainWindow?.webContents.send('typing:event', 'folder:open-request', { path: resolve(path) })
      return
    }
  } catch {
    /* fall through to file handling */
  }
  mainWindow?.webContents.send('typing:event', 'file:open-request', { path: abs })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv)
    if (mainWindow) for (const file of files) openPathFromOutside(file)
    else pendingOpenPaths.push(...files)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Serve only files inside folders the user has opened. No remote loading.
    protocol.handle(ASSET_SCHEME, async (request) => {
      try {
        const raw = pathFromAssetUrl(request.url)
        // Resolve both sides through symlinks: a link inside an opened folder
        // must not become a way to read a file outside it.
        const abs = await fs.realpath(resolve(raw)).catch(() => null)
        if (!abs) return new Response('forbidden', { status: 403 })
        // Containment is case-insensitive on Windows, where `C:\Notes` and
        // `c:\notes` are the same folder.
        const allowed = [...assetRoots].some((root) => isInsidePath(root, abs))
        if (!allowed) return new Response('forbidden', { status: 403 })
        const upstream = await net.fetch(pathToFileURL(abs).toString())
        const headers = new Headers(upstream.headers)
        // The editor page has a file:// origin, so local asset reads need CORS.
        headers.set('Access-Control-Allow-Origin', '*')
        headers.set('Cache-Control', 'no-cache')
        return new Response(upstream.body, { status: upstream.status, headers })
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

    pendingOpenPaths.push(...filesFromArgv(process.argv))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitRequested = true
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

function getPrefsSnapshot(): Prefs {
  return prefsCache ?? DEFAULT_PREFS
}

export { isDev }