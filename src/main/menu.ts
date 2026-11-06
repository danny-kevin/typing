import { app, Menu, MenuItemConstructorOptions } from 'electron'
import { ACCELERATORS } from '../shared/commands'
import type { Prefs } from '../shared/types'

type Send = (command: string, payload?: unknown) => void

/**
 * The menu bar. Every application command uses the accelerator table from
 * src/shared/commands.ts, which the renderer's shortcut matcher also reads.
 */
export function buildMenu(send: Send, prefs: Prefs): Menu {
  const cmd = (
    label: string,
    command: string,
    extra: Partial<MenuItemConstructorOptions> = {}
  ): MenuItemConstructorOptions => ({
    label,
    accelerator: ACCELERATORS[command],
    click: () => send(command),
    ...extra
  })

  const template: MenuItemConstructorOptions[] = [
    {
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
    },
    {
      label: 'File',
      submenu: [
        cmd('New', 'doc.new'),
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
        cmd('Close Window', 'app.close')
      ]
    },
    {
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
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
      ]
    },
    {
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
    },
    {
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
    },
    {
      label: 'View',
      submenu: [
        cmd('Source Code Mode', 'view.source', { type: 'checkbox', checked: prefs.sourceMode }),
        { type: 'separator' },
        cmd('Outline', 'view.outline', { type: 'checkbox', checked: prefs.showOutline }),
        cmd('File Sidebar', 'view.sidebar'),
        cmd('Focus Mode', 'view.focus', { type: 'checkbox', checked: prefs.focusMode }),
        cmd('Typewriter Mode', 'view.typewriter', { type: 'checkbox', checked: prefs.typewriterMode }),
        { type: 'separator' },
        { role: 'resetZoom', accelerator: 'Cmd+Alt+0' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    },
    {
      label: 'Help',
      submenu: [
        cmd('Keyboard Shortcuts', 'app.shortcuts'),
        { label: 'Usage Guide', click: () => send('app.usage') },
        { type: 'separator' },
        { label: 'Reveal Third-Party Notices', click: () => send('app.thirdparty') }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}