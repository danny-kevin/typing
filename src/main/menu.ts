import { app, Menu, MenuItemConstructorOptions, shell } from 'electron'
import type { Prefs } from '../shared/types'

type Send = (command: string, payload?: unknown) => void

/**
 * One command table drives the menu bar, the command palette and the in-app
 * shortcuts, so every action has a single name everywhere.
 */
export function buildMenu(send: Send, prefs: Prefs): Menu {
  const cmd = (label: string, command: string, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command),
    ...extra
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Typing',
      submenu: [
        cmd('About Typing', 'app.about'),
        { type: 'separator' },
        cmd('Preferences…', 'app.prefs', 'Cmd+,'),
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
        cmd('New', 'doc.new', 'Cmd+N'),
        cmd('Open…', 'doc.open', 'Cmd+O'),
        cmd('Open Folder…', 'doc.openFolder', 'Cmd+Shift+Alt+O'),
        cmd('Quick Open…', 'nav.quickOpen', 'Cmd+Shift+O'),
        cmd('Recent Files…', 'doc.recent'),
        { type: 'separator' },
        cmd('Save', 'doc.save', 'Cmd+S'),
        cmd('Save As…', 'doc.saveAs', 'Cmd+Shift+S'),
        cmd('Revert to Saved', 'doc.revert'),
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            cmd('HTML…', 'export.html', 'Cmd+Shift+E'),
            cmd('PDF…', 'export.pdf', 'Cmd+Alt+P')
          ]
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', 'edit.undo', 'Cmd+Z'),
        cmd('Redo', 'edit.redo', 'Cmd+Shift+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        cmd('Find…', 'find.open', 'Cmd+F'),
        cmd('Find Next', 'find.next', 'Cmd+G'),
        cmd('Find Previous', 'find.prev', 'Cmd+Shift+G'),
        cmd('Find and Replace…', 'find.replace', 'Cmd+Alt+F'),
        { type: 'separator' },
        cmd('Smart Paste (clean up formatting)', 'edit.smartPaste'),
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
        }
      ]
    },
    {
      label: 'Format',
      submenu: [
        cmd('Bold', 'format.bold', 'Cmd+B'),
        cmd('Italic', 'format.italic', 'Cmd+I'),
        cmd('Strikethrough', 'format.strike', 'Cmd+Shift+X'),
        cmd('Inline Code', 'format.code', 'Cmd+E'),
        cmd('Link…', 'format.link', 'Cmd+K'),
        cmd('Image…', 'format.image', 'Cmd+Shift+I'),
        { type: 'separator' },
        cmd('Code Block', 'format.codeBlock', 'Cmd+Alt+C'),
        cmd('Blockquote', 'format.quote', 'Cmd+Alt+Q'),
        cmd('Table', 'format.table', 'Cmd+Alt+T'),
        cmd('Math Block', 'format.math', 'Cmd+Alt+M'),
        cmd('Horizontal Rule', 'format.hr'),
        cmd('Footnote', 'format.footnote'),
        { type: 'separator' },
        {
          label: 'Heading',
          submenu: [
            cmd('Heading 1', 'format.h1', 'Cmd+1'),
            cmd('Heading 2', 'format.h2', 'Cmd+2'),
            cmd('Heading 3', 'format.h3', 'Cmd+3'),
            cmd('Heading 4', 'format.h4', 'Cmd+4'),
            cmd('Heading 5', 'format.h5', 'Cmd+5'),
            cmd('Heading 6', 'format.h6', 'Cmd+6'),
            cmd('Paragraph', 'format.p', 'Cmd+0')
          ]
        },
        {
          label: 'Lists',
          submenu: [
            cmd('Unordered List', 'format.ul', 'Cmd+Alt+U'),
            cmd('Ordered List', 'format.ol', 'Cmd+Alt+O'),
            cmd('Task List', 'format.task', 'Cmd+Alt+X'),
            cmd('Increase Indent', 'format.indent', 'Cmd+]'),
            cmd('Decrease Indent', 'format.outdent', 'Cmd+[')
          ]
        },
        { type: 'separator' },
        cmd('Clear Formatting', 'format.clear')
      ]
    },
    {
      label: 'Table',
      submenu: [
        cmd('Insert Table', 'format.table', 'Cmd+Alt+T'),
        { type: 'separator' },
        cmd('Add Row Below', 'table.addRowBelow', 'Cmd+Return'),
        cmd('Add Row Above', 'table.addRowAbove'),
        cmd('Add Column Right', 'table.addColRight', 'Cmd+Shift+Return'),
        cmd('Add Column Left', 'table.addColLeft'),
        cmd('Delete Row', 'table.deleteRow'),
        cmd('Delete Column', 'table.deleteCol'),
        { type: 'separator' },
        {
          label: 'Align Column',
          submenu: [
            cmd('Left', 'table.align.left'),
            cmd('Center', 'table.align.center'),
            cmd('Right', 'table.align.right')
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Source Code Mode', 'view.source', 'Cmd+/', { type: 'checkbox', checked: prefs.sourceMode }),
        { type: 'separator' },
        cmd('Outline', 'view.outline', 'Cmd+Shift+1', { type: 'checkbox', checked: prefs.showOutline }),
        cmd('File Sidebar', 'view.sidebar', 'Cmd+Shift+2'),
        cmd('Focus Mode', 'view.focus', 'F8', { type: 'checkbox', checked: prefs.focusMode }),
        cmd('Typewriter Mode', 'view.typewriter', 'F9', { type: 'checkbox', checked: prefs.typewriterMode }),
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
        cmd('Usage Guide', 'app.usage'),
        { type: 'separator' },
        {
          label: 'Third-Party Licenses',
          click: () => {
            void shell.openPath(app.getAppPath())
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}