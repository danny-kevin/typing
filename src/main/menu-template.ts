import type { MenuItemConstructorOptions } from 'electron'
import { acceleratorFor, isMacPlatform } from '../shared/commands'
import type { Prefs } from '../shared/types'

/**
 * The menu bar, as a plain template so the shape can be unit tested without
 * launching Electron.
 *
 * macOS gets the platform's shape: an application menu with services/hide, and a
 * Window menu. Windows and Linux get the shape those platforms expect: File,
 * Edit, View, Format, Table and Help, Alt mnemonics on every top-level item,
 * "Exit" in the File menu, "About" in Help, and no macOS-only roles.
 */

type Send = (command: string, payload?: unknown) => void

export interface MenuBuildOptions {
  /** A Node `process.platform` value. */
  platform: string
  /** `app.isPackaged`: developer-only items are hidden in a packaged build. */
  isPackaged: boolean
}

/** Words that never provide a mnemonic (`Find &and Replace` reads badly). */
const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'for'])

/**
 * Add `&`-mnemonics so Alt reaches every menu, one unique letter per submenu.
 * Prefers the first letter of a meaningful word; `interiorFallback` lets a
 * top-level label take a later letter (`F&ormat`) when its initial is taken.
 */
function withMnemonics(items: MenuItemConstructorOptions[], interiorFallback = false): MenuItemConstructorOptions[] {
  const used = new Set<string>()
  const pick = (label: string): string => {
    const clean = label.replace(/…$/, '')
    for (const word of clean.split(/\s+/)) {
      if (!word || STOP_WORDS.has(word.toLowerCase())) continue
      const ch = word[0]
      if (!/[A-Za-z0-9]/.test(ch)) continue
      if (!used.has(ch.toLowerCase())) {
        used.add(ch.toLowerCase())
        return ch
      }
    }
    if (!interiorFallback) return ''
    for (const ch of clean) {
      if (!/[A-Za-z0-9]/.test(ch)) continue
      if (!used.has(ch.toLowerCase())) {
        used.add(ch.toLowerCase())
        return ch
      }
    }
    return ''
  }
  return items.map((item) => {
    if (!item.label || item.label.includes('&')) return item
    const ch = pick(item.label)
    if (!ch) return item
    const index = item.label.indexOf(ch)
    if (index < 0) return item
    return { ...item, label: `${item.label.slice(0, index)}&${item.label.slice(index)}` }
  })
}

export function buildMenuTemplate(send: Send, prefs: Prefs, opts: MenuBuildOptions): MenuItemConstructorOptions[] {
  const mac = isMacPlatform(opts.platform)

  const cmd = (label: string, command: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    // `id` names the command, so a command that appears twice (Table > Insert
    // Table and Format > Table) is still one command and the tests can see it.
    id: command,
    label,
    accelerator: acceleratorFor(command, opts.platform),
    click: () => send(command),
    ...extra
  })

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      cmd('New Document Tab', 'doc.new'),
      cmd('New Tab', 'tab.new'),
      cmd('Open…', 'doc.open'),
      cmd('Open Folder…', 'doc.openFolder'),
      cmd('Quick Open…', 'nav.quickOpen'),
      cmd('Recent Files…', 'doc.recent'),
      { type: 'separator' },
      cmd('Save', 'doc.save'),
      cmd('Save As…', 'doc.saveAs'),
      cmd('Revert to Saved', 'doc.revert'),
      { type: 'separator' },
      {
        label: 'Export',
        submenu: [cmd('HTML…', 'export.html'), cmd('PDF…', 'export.pdf')]
      },
      { type: 'separator' },
      // Windows and Linux have no application menu, so Preferences lives in File
      // (the menu users look in) right above Exit.
      ...(mac ? [] : ([cmd('Preferences…', 'app.prefs'), { type: 'separator' }] as MenuItemConstructorOptions[])),
      cmd('Close Tab', 'tab.close'),
      cmd('Close Window', 'app.close'),
      ...(mac
        ? []
        : ([{ type: 'separator' }, { role: 'quit', label: 'Exit' }] as MenuItemConstructorOptions[]))
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      cmd('Undo', 'edit.undo'),
      cmd('Redo', 'edit.redo'),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      cmd('Find…', 'find.open'),
      cmd('Find Next', 'find.next'),
      cmd('Find Previous', 'find.prev'),
      cmd('Find and Replace…', 'find.replace'),
      { type: 'separator' },
      cmd('Smart Paste', 'edit.smartPaste'),
      ...(mac ? ([{ type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] as MenuItemConstructorOptions[]) : [])
    ]
  }

  const formatMenu: MenuItemConstructorOptions = {
    label: 'Format',
    submenu: [
      cmd('Bold', 'format.bold'),
      cmd('Italic', 'format.italic'),
      cmd('Strikethrough', 'format.strike'),
      cmd('Inline Code', 'format.code'),
      cmd('Link…', 'format.link'),
      cmd('Image…', 'format.image'),
      { type: 'separator' },
      cmd('Code Block', 'format.codeBlock'),
      cmd('Blockquote', 'format.quote'),
      cmd('Table', 'format.table'),
      cmd('Math Block', 'format.math'),
      cmd('Horizontal Rule', 'format.hr'),
      cmd('Footnote', 'format.footnote'),
      { type: 'separator' },
      {
        label: 'Heading',
        submenu: [
          cmd('Heading 1', 'format.h1'),
          cmd('Heading 2', 'format.h2'),
          cmd('Heading 3', 'format.h3'),
          cmd('Heading 4', 'format.h4'),
          cmd('Heading 5', 'format.h5'),
          cmd('Heading 6', 'format.h6'),
          cmd('Paragraph', 'format.p')
        ]
      },
      {
        label: 'Lists',
        submenu: [
          cmd('Unordered List', 'format.ul'),
          cmd('Ordered List', 'format.ol'),
          cmd('Task List', 'format.task'),
          cmd('Increase Indent', 'format.indent'),
          cmd('Decrease Indent', 'format.outdent')
        ]
      },
      { type: 'separator' },
      cmd('Clear Formatting', 'format.clear')
    ]
  }

  const tableMenu: MenuItemConstructorOptions = {
    label: 'Table',
    submenu: [
      cmd('Insert Table', 'format.table'),
      { type: 'separator' },
      cmd('Add Row Below', 'table.addRowBelow'),
      { label: 'Add Row Above', click: () => send('table.addRowAbove') },
      cmd('Add Column Right', 'table.addColRight'),
      { label: 'Add Column Left', click: () => send('table.addColLeft') },
      { label: 'Delete Row', click: () => send('table.deleteRow') },
      { label: 'Delete Column', click: () => send('table.deleteCol') },
      { type: 'separator' },
      {
        label: 'Align Column',
        submenu: [
          { label: 'Left', click: () => send('table.align.left') },
          { label: 'Center', click: () => send('table.align.center') },
          { label: 'Right', click: () => send('table.align.right') }
        ]
      }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      cmd('Next Tab', 'tab.next'),
      cmd('Previous Tab', 'tab.previous'),
      cmd('Next Tab (Alternate)', 'tab.nextAlt'),
      cmd('Previous Tab (Alternate)', 'tab.previousAlt'),
      { label: 'Go to Tab', submenu: Array.from({ length: 9 }, (_, i) => cmd(i === 8 ? 'Last Tab' : `Tab ${i + 1}`, `tab.jump${i + 1}`)) },
      { type: 'separator' },
      cmd('Source Code Mode', 'view.source', { type: 'checkbox', checked: prefs.sourceMode }),
      { type: 'separator' },
      cmd('Outline', 'view.outline', { type: 'checkbox', checked: prefs.showOutline }),
      cmd('File Sidebar', 'view.sidebar'),
      cmd('Focus Mode', 'view.focus', { type: 'checkbox', checked: prefs.focusMode }),
      cmd('Typewriter Mode', 'view.typewriter', { type: 'checkbox', checked: prefs.typewriterMode }),
      { type: 'separator' },
      // Ctrl/⌥+0 resets the zoom on both platforms, so it never collides with
      // the paragraph (`Cmd+0`) or heading (`Cmd+1…6`) shortcuts.
      { role: 'resetZoom', accelerator: 'CmdOrCtrl+Alt+0' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      mac ? { role: 'togglefullscreen' } : { role: 'togglefullscreen', accelerator: 'F11' },
      ...(opts.isPackaged
        ? []
        : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      cmd('Keyboard Shortcuts', 'app.shortcuts'),
      { label: 'Usage Guide', click: () => send('app.usage') },
      { type: 'separator' },
      { label: 'Reveal Third-Party Notices', click: () => send('app.thirdparty') },
      ...(mac
        ? []
        : ([
            { type: 'separator' },
            cmd('About Typing', 'app.about')
          ] as MenuItemConstructorOptions[]))
    ]
  }

  if (mac) {
    const appMenu: MenuItemConstructorOptions = {
      label: 'Typing',
      submenu: [
        cmd('About Typing', 'app.about'),
        { type: 'separator' },
        cmd('Preferences…', 'app.prefs'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Typing' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Typing' }
      ]
    }
    const windowMenu: MenuItemConstructorOptions = {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
    return [
      appMenu,
      fileMenu,
      editMenu,
      formatMenu,
      tableMenu,
      viewMenu,
      windowMenu,
      helpMenu
    ]
  }

  // Windows/Linux: Preferences lives in View-style application menus rather than
  // an application menu; File carries Exit and Help carries About Typing.
  return applyMnemonics([fileMenu, editMenu, viewMenu, formatMenu, tableMenu, helpMenu])
}

/** Attach mnemonics to nested submenus too (recursive, per-submenu letters). */
export function applyMnemonics(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return withMnemonics(
    items.map((item) => {
      if (!item.submenu) return item
      const submenu = Array.isArray(item.submenu) ? item.submenu : []
      return { ...item, submenu: applyMnemonics(submenu) }
    }),
    true
  )
}