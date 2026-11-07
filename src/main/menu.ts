import { app, Menu } from 'electron'
import type { Prefs } from '../shared/types'
import { buildMenuTemplate } from './menu-template'

type Send = (command: string, payload?: unknown) => void

/**
 * The menu bar. Every application command uses the accelerator table from
 * src/shared/commands.ts, which the renderer's shortcut matcher also reads, and
 * the template differs per platform (see menu-template.ts).
 */
export function buildMenu(send: Send, prefs: Prefs): Menu {
  return Menu.buildFromTemplate(
    buildMenuTemplate(send, prefs, { platform: process.platform, isPackaged: app.isPackaged })
  )
}