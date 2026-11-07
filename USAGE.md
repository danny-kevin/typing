# Typing — usage

Typing opens ordinary markdown files. There is no library, no vault and no
database: a document is the file you opened.

Shortcuts below are written for macOS. **On Windows every `⌘` (Command) becomes
`Ctrl` and every `⌥` (Option) becomes `Alt`**; `⇧` is Shift, `↩` is Enter, and
`F8`/`F9` are the same keys on both platforms. So `⇧⌥⌘O` is
`Ctrl+Alt+Shift+O` and `⌥⌘T` is `Ctrl+Alt+T`. `Help ▸ Keyboard Shortcuts` and the
toolbar tooltips always show the shortcuts of the platform you are running on.
The [Windows shortcut table](#windows-shortcuts) at the end lists them all.

## Opening and saving

| Action | How |
| --- | --- |
| New document | `⌘N` (`Ctrl+N`) |
| Open a file | `⌘O` (`Ctrl+O`), or drag a `.md` file onto the window or the Dock icon |
| Open a folder | `⇧⌥⌘O` (`Ctrl+Alt+Shift+O`), or drag a folder onto the Dock icon |
| Quick open (folder) | `⇧⌘O` (`Ctrl+Shift+O`), type part of a filename, `↩` |
| Recent files | File ▸ Recent Files… |
| Save | `⌘S` (`Ctrl+S`) |
| Save as | `⇧⌘S` (`Ctrl+Shift+S`) |
| Revert to saved | File ▸ Revert to Saved |
| Open from the command line | `Typing.exe "C:\path\to\note.md"` (also accepts a folder) |

Saving is quiet: if the bytes on disk already match the document, nothing is
written at all (the file's modification time stays put, and a file that mixes
CRLF and LF line endings keeps both). Autosave is on by default and writes
shortly after you stop typing; you can turn it off in Preferences.

Leaving a document never happens silently. New, open, open recent, quick open,
the folder tree, a file dropped on the window, a file opened from the Finder or
the Dock, closing the window and quitting all ask the same question when there
are unsaved changes: **Save**, **Don't Save** or **Cancel**. On an untitled
draft, Save asks where to put it first. If the save cannot finish — the disk
refuses it, you cancel the Save As panel, or another program has the file open
and changed it — you stay in the document with your text exactly as it was.

A file whose bytes are not valid UTF-8 is opened as text with replacement
characters, and Typing refuses to write it back in place: a banner offers
**Save As…** for a UTF-8 copy, or **Overwrite as UTF-8** if you really mean to
replace those bytes.

If the file is changed by another program while you have unsaved edits, Typing
shows a prompt instead of overwriting anything:

- **Reload from disk** — discard your edits and take the file as it is now.
- **Keep mine as a copy** — your version is written next to the original as
  `name (conflict YYYY-MM-DD HHMMSS).md` and opened in the editor; the other
  program's file is untouched.
- **Ignore** — keep typing; you will be asked again on the next save.

If the file changes while you have *no* unsaved edits, Typing reloads it and
tells you. If the file is deleted while it is open, Typing says so and keeps your
text; saving writes the file again. A change is detected by comparing the file's
content, not its timestamp, so a same-second write by another program is caught
too.

## Writing

The editor shows the document as it will read: headings are set in larger type,
emphasis is emphasised, maths is typeset, diagrams are drawn, tables are tables.
Put the caret on a line and its markdown markers appear so you can change them;
move away and they fade.

- Lists continue when you press `↩`, and an empty item ends the list.
- Task list checkboxes can be clicked; the marker in the file changes.
- `Tab` / `⇧Tab` indent and outdent a list item.
- Brackets, quotes, backticks, `*`, `_`, `~` and `$` pair automatically, and
  typing a closing character steps over an existing one.
- Pasting rich HTML (a web page, a table from a browser) converts it to markdown.
  Pasting a URL over a selection turns the selection into a link.
- Pasting or dropping an image saves it to an `assets/` folder next to your
  document and inserts a relative link. (Save the document first — Typing needs a
  location for the image.) Links inside the document are always written with
  forward slashes, so the same file renders on macOS and Windows.
- On Windows, `Ctrl+Alt+…` combinations and the plain-`Ctrl` shortcuts work the
  same way; if a shortcut collides with your IME (some Chinese input methods use
  `Ctrl+Space`/`Ctrl+,`), the IME wins while it is composing and the editor does
  not touch the keystroke.

## Tables

Insert one with `⌥⌘T`. Click the rendered table to drop into its markdown source.

| Action | Shortcut |
| --- | --- |
| Add a row below | `⌘↩` (also at the end of a row) |
| Add a column right | `⇧⌘↩` |
| Add row above / column left, delete row/column, align | Table menu |

## Maths and diagrams

- Inline maths: `$a^2+b^2=c^2$`; display maths:

  ```
  $$
  \int_0^1 x^2\,dx = \frac{1}{3}
  $$
  ```

- Diagrams: a fenced block with the language `mermaid`.

Both render in place and switch back to source when you put the caret in them.

## Modes and panels

| Action | Shortcut |
| --- | --- |
| Source code mode | `⌘/` |
| Outline | `⇧⌘1` |
| File sidebar | `⇧⌘2` |
| Focus mode (dim everything but the current block) | `F8` |
| Typewriter mode (keep the caret centred) | `F9` |

The word count, cursor position and save state live in the status bar (the file
path is shown with `~` for your home folder on both platforms). The outline
follows the cursor and jumps when clicked.

## Find and replace

`⌘F` opens find, `⌥⌘F` adds the replace field, `⌘G` / `⇧⌘G` walk through matches,
`esc` closes. Options: case-sensitive, whole word, regular expression.

## Export

- **HTML** (`⇧⌘E`) writes a single self-contained file: maths rendered by KaTeX,
  diagrams inlined as SVG, and images embedded as data URLs. It opens anywhere,
  offline.
- **PDF** (`⌥⌘P`) prints the same rendering through the system print engine (A4,
  light theme).

## Preferences (`⌘,`)

Theme (follow system / light / dark), editor font family and size, editor width,
line height, autosave, auto-pairing, smart paste, spell check.

## Recovery

Unsaved work is mirrored to a draft every second or so. If the app is killed or
crashes, the next launch offers to restore the draft. Restored text is not saved
to the file until you press `⌘S`.

## Keyboard shortcuts, in one place

`Help ▸ Keyboard Shortcuts` lists everything; the full set on macOS:

```
New ⌘N · Open ⌘O · Open folder ⇧⌥⌘O · Quick open ⇧⌘O · Save ⌘S · Save as ⇧⌘S
Source mode ⌘/ · Outline ⇧⌘1 · Sidebar ⇧⌘2 · Focus F8 · Typewriter F9
Find ⌘F · Replace ⌥⌘F · Next ⌘G · Previous ⇧⌘G
Bold ⌘B · Italic ⌘I · Strikethrough ⇧⌘X · Inline code ⌘E · Link ⌘K · Image ⇧⌘I
Code block ⌥⌘C · Quote ⌥⌘Q · Table ⌥⌘T · Maths ⌥⌘M
Headings ⌘1…⌘6 · Paragraph ⌘0
Bullet list ⌥⌘U · Ordered list ⌥⌘O · Task list ⌥⌘X · Indent ⌘] · Outdent ⌘[
Table row ⌘↩ · Table column ⇧⌘↩
Export HTML ⇧⌘E · Export PDF ⌥⌘P · Preferences ⌘,
```

## Windows shortcuts

The same commands on Windows 10/11, as the menu bar and `Help ▸ Keyboard
Shortcuts` show them:

```
New Ctrl+N · Open Ctrl+O · Open folder Ctrl+Alt+Shift+O · Quick open Ctrl+Shift+O
Save Ctrl+S · Save as Ctrl+Shift+S · Close window Ctrl+W
Source mode Ctrl+/ · Outline Ctrl+Shift+1 · Sidebar Ctrl+Shift+2 · Focus F8 · Typewriter F9
Find Ctrl+F · Replace Ctrl+Alt+F · Next Ctrl+G · Previous Ctrl+Shift+G
Bold Ctrl+B · Italic Ctrl+I · Strikethrough Ctrl+Shift+X · Inline code Ctrl+E
Link Ctrl+K · Image Ctrl+Shift+I
Code block Ctrl+Alt+C · Quote Ctrl+Alt+Q · Table Ctrl+Alt+T · Maths Ctrl+Alt+M
Headings Ctrl+1…Ctrl+6 · Paragraph Ctrl+0
Bullet list Ctrl+Alt+U · Ordered list Ctrl+Alt+O · Task list Ctrl+Alt+X
Indent Ctrl+] · Outdent Ctrl+[
Table row Ctrl+Enter · Table column Ctrl+Shift+Enter
Export HTML Ctrl+Shift+E · Export PDF Ctrl+Alt+P · Preferences Ctrl+,
Full screen F11 · View ▸ Zoom In / Zoom Out · Reset zoom Ctrl+Alt+0
```

Notes for Windows:

- The menu bar is the native one: `Alt` reaches File, Edit, View, Format, Table and
  Help, and each item has its own underlined letter. Preferences live in
  `File ▸ Preferences…` (there is no macOS-style application menu) and About
  lives in Help.
- `File ▸ Exit`, the window's ✕ button, `Alt+F4` and `Ctrl+W` all ask before
  closing a document with unsaved changes.
- Undo/redo are `Ctrl+Z` / `Ctrl+Shift+Z`; `Ctrl+Y` is not bound.
- On keyboard layouts where AltGr is reported as `Ctrl+Alt` (German, Polish,
  French, …), a `Ctrl+Alt+…` shortcut can be swallowed by the layout instead of
  reaching the app. The same commands are in the menus, so nothing is unfixable;
  tell me if you want a different binding for your layout.
- Everything else — autosave, recovery, external-change prompts, export, the
  `assets/` folder for pasted images, recent files — behaves exactly as described
  above; the settings and recovery drafts live in `%APPDATA%\Typing`.