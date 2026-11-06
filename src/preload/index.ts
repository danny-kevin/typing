import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  /** Call a main-process method (see ApiMethod in src/shared/types.ts). */
  call: (method: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke('typing:call', method, args),
  /** Ask the main process to rebuild the menu (checkbox state changes). */
  refreshMenu: (): void => ipcRenderer.send('typing:menu'),
  /** Receive main-process events: `on((name, payload) => ...)`; returns an unsubscribe fn. */
  on: (listener: (name: string, payload: any) => void): (() => void) => {
    const bridge = (_e: unknown, name: string, payload: any): void => listener(name, payload)
    ipcRenderer.on('typing:event', bridge)
    return () => ipcRenderer.removeListener('typing:event', bridge)
  },
  /** Absolute path of an OS-dropped File object. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform,
  /** Enabled only when the app is launched with TYPING_TEST=1 (test harness). */
  testMode: process.env.TYPING_TEST === '1'
}

contextBridge.exposeInMainWorld('typing', api)

export type TypingApi = typeof api