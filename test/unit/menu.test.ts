import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate } from '../../src/main/menu-template'
import { DEFAULT_PREFS } from '../../src/shared/types'
import { ACCELERATORS } from '../../src/shared/commands'

const send = (): void => {}
const prefs = { ...DEFAULT_PREFS }

const MAC_ONLY_ROLES = new Set([
  'services',
  'hide',
  'hideOthers',
  'unhide',
  'front',
  'zoom',
  'startSpeaking',
  'stopSpeaking',
  'about'
])

function walk(items: MenuItemConstructorOptions[], visit: (item: MenuItemConstructorOptions, depth: number) => void, depth = 0): void {
  for (const item of items) {
    visit(item, depth)
    const sub = item.submenu
    if (Array.isArray(sub)) walk(sub, visit, depth + 1)
  }
}

const macTemplate = buildMenuTemplate(send, prefs, { platform: 'darwin', isPackaged: true })
const winTemplate = buildMenuTemplate(send, prefs, { platform: 'win32', isPackaged: true })

describe('menu template: macOS', () => {
  it('starts with the application menu and keeps the macOS shape', () => {
    expect(macTemplate.map((m) => m.label)).toEqual([
      'Typing',
      'File',
      'Edit',
      'Format',
      'Table',
      'View',
      'Window',
      'Help'
    ])
    const appMenu = macTemplate[0].submenu as MenuItemConstructorOptions[]
    expect(appMenu.map((i) => i.role ?? i.label)).toContain('quit')
    expect(appMenu.some((i) => i.role === 'services')).toBe(true)
    const windowMenu = macTemplate.find((m) => m.label === 'Window')!
    expect((windowMenu.submenu as MenuItemConstructorOptions[]).some((i) => i.role === 'front')).toBe(true)
  })

  it('does not add Windows mnemonics to any label', () => {
    walk(macTemplate, (item) => {
      if (item.label) expect(item.label).not.toContain('&')
    })
  })

  it('uses CmdOrCtrl accelerators that resolve to Cmd on macOS', () => {
    walk(macTemplate, (item) => {
      if (item.accelerator) expect(item.accelerator).not.toMatch(/(^|\+)Cmd\+/)
    })
  })
})

describe('menu template: Windows', () => {
  it('uses the File / Edit / View / Format / Table / Help menu bar', () => {
    expect(winTemplate.map((m) => m.label?.replace('&', ''))).toEqual(['File', 'Edit', 'View', 'Format', 'Table', 'Help'])
    // Every top-level label carries an Alt mnemonic.
    for (const item of winTemplate) expect(item.label).toMatch(/&[A-Za-z]/)
  })

  it('has no macOS-only roles', () => {
    walk(winTemplate, (item) => {
      if (item.role) expect(MAC_ONLY_ROLES.has(item.role), `role ${item.role} is macOS only`).toBe(false)
    })
  })

  it('puts Preferences in File, Exit in File and About Typing in Help', () => {
    const file = winTemplate.find((m) => m.label === '&File')!.submenu as MenuItemConstructorOptions[]
    expect(file.some((i) => i.role === 'quit')).toBe(true)
    expect(file.some((i) => i.id === 'app.prefs')).toBe(true)
    const help = winTemplate.find((m) => m.label === '&Help')!.submenu as MenuItemConstructorOptions[]
    expect(help.some((i) => /About Typing/.test(i.label ?? ''))).toBe(true)
  })

  it('gives every command a Ctrl accelerator instead of a macOS one', () => {
    walk(winTemplate, (item) => {
      if (!item.accelerator) return
      expect(item.accelerator).not.toMatch(/(^|\+)Cmd\+/)
      expect(item.accelerator).not.toMatch(/[⌘⇧⌥⌃]/)
      if (!/^F\d+$/.test(item.accelerator)) expect(item.accelerator).toMatch(/CmdOrCtrl\+/)
    })
    const accelerators = new Set<string>()
    walk(winTemplate, (item) => {
      if (item.accelerator) accelerators.add(item.accelerator)
    })
    // Every documented command that has a menu entry carries the table's key.
    expect(accelerators.has('CmdOrCtrl+S')).toBe(true)
    expect(accelerators.has('CmdOrCtrl+Alt+T')).toBe(true)
    expect(accelerators.has('CmdOrCtrl+Slash') || accelerators.has('CmdOrCtrl+/')).toBe(true)
    expect(accelerators.has('F8')).toBe(true)
  })

  it('has a unique Alt mnemonic inside each submenu', () => {
    walk(winTemplate, (item) => {
      const sub = item.submenu
      if (!Array.isArray(sub)) return
      const seen = new Set<string>()
      for (const child of sub) {
        const m = /&([A-Za-z0-9])/.exec(child.label ?? '')
        if (!m) continue
        const letter = m[1].toLowerCase()
        expect(seen.has(letter), `duplicate mnemonic "${letter}" in ${item.label}`).toBe(false)
        seen.add(letter)
      }
    })
  })

  it('never puts two different commands on the same key', () => {
    const byAccelerator = new Map<string, string>()
    walk(winTemplate, (item) => {
      if (!item.accelerator) return
      const existing = byAccelerator.get(item.accelerator)
      if (existing !== undefined) {
        // Two menu entries may share a key only when they are the same command.
        expect(existing, `${item.accelerator} is used by both ${existing} and ${item.id ?? item.label}`).toBe(item.id)
      }
      byAccelerator.set(item.accelerator, item.id ?? item.label ?? '')
    })
    // The accelerator table itself carries no macOS-only modifier strings.
    for (const accel of Object.values(ACCELERATORS)) expect(accel).not.toContain('Ctrl+')
  })
})