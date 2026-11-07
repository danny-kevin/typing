import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * Main-process events (`typing:event`) can arrive before the renderer has
 * finished its first `await` and registered a listener — for example the "open
 * this file" event that follows `did-finish-load`. Buffer them until a listener
 * exists, then replay in order, so an initial document is never lost.
 */
const backlog: Array<[string, unknown]> = []
const listeners = new Set<(name: string, payload: unknown) => void>()

ipcRenderer.on('typing:event', (_e, name: string, payload: unknown) => {
  if (listeners.size === 0) {
    backlog.push([name, payload])
    return
  }
  for (const listener of listeners) listener(name, payload)
})

const api = {
  /** Call a main-process method (see ApiMethod in src/shared/types.ts). */
  call: (method: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke('typing:call', method, args),
  /** Ask the main process to rebuild the menu (checkbox state changes). */
  refreshMenu: (): void => ipcRenderer.send('typing:menu'),
  /** Receive main-process events: `on((name, payload) => ...)`; returns an unsubscribe fn. */
  on: (listener: (name: string, payload: any) => void): (() => void) => {
    listeners.add(listener)
    if (backlog.length) {
      const queued = backlog.splice(0, backlog.length)
      for (const [name, payload] of queued) listener(name, payload)
    }
    return () => {
      listeners.delete(listener)
    }
  },
  /** Absolute path of an OS-dropped File object. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform,
  /** Enabled only when the app is launched with TYPING_TEST=1 (test harness). */
  testMode: process.env.TYPING_TEST === '1'
}

contextBridge.exposeInMainWorld('typing', api)

export type TypingApi = typeof api