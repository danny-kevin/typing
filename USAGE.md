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
| New document tab | `⌘T` or `⌘N` (`Ctrl+T` or `Ctrl+N`) |
| Open files in tabs | `⌘O` (`Ctrl+O`), supports multiple selection; or drop `.md` files onto the window or Dock icon |
| Open a folder | `⇧⌥⌘O` (`Ctrl+Alt+Shift+O`), or drag a folder onto the Dock icon |
| Quick open (folder) | `⇧⌘O` (`Ctrl+Shift+O`), type part of a filename, `↩` |
| Recent files | File ▸ Recent Files… |
| Save | `⌘S` (`Ctrl+S`) |
| Save as | `⇧⌘S` (`Ctrl+Shift+S`) |
| Revert to saved | File ▸ Revert to Saved |
| Local version history | File ▸ Local History…, `⇧⌘H` (`Ctrl+Shift+H`), or the clock button |
| Open from the command line | `Typing.exe "C:\path\to\note.md"` (also accepts a folder) |

Saving is quiet: if the bytes on disk already match the document, nothing is
written at all (the file's modification time stays put, and a file that mixes
CRLF and LF line endings keeps both). Autosave is on by default and writes
shortly after you stop typing; you can turn it off in Preferences.

New and Open do not discard the current document: they open another tab.
Recent files, quick open, the folder tree, file drops, command-line arguments and
Finder/Dock requests use the same tab opener. An already-open file focuses its
tab, including symlink aliases; an untouched empty Untitled tab is replaced
instead of left behind. Quick open ranks an exact filename before name prefixes
and fuzzy matches. On macOS the application stays running after its last window
closes; New Tab or a Finder/Dock file request opens a fresh window.

Closing a dirty tab asks **Save**, **Don't Save** or **Cancel** for that document.
Save on Untitled asks where to put it first. A failed save, a cancelled Save As
panel or an unresolved conflict aborts the close. Window close and Quit check
every dirty tab in strip order; any Cancel or failed save aborts the whole close.
Earlier Don't Save answers do not discard their text if a later tab cancels
(the tabs stay open; saves already completed are not undone).

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

## Tabs

The tab strip is above the editor. A dot marks unsaved text; `!` marks an
external change or deletion. Click a tab to switch, drag to reorder, use its ×
button or middle-click to close, and use + to create a tab. Many tabs scroll
horizontally (trackpad, scrollbar, or mouse wheel). Each tab retains its own
undo/redo, selection, scroll position and source/live mode. Autosave and external
change detection also run for background tabs; activating a conflicted/deleted
tab shows its own banner. Reload/Revert affects only that document.

| Action | macOS | Windows |
| --- | --- | --- |
| New tab | `⌘T` or `⌘N` | `Ctrl+T` or `Ctrl+N` |
| Close tab (last tab closes window) | `⌘W` | `Ctrl+W` |
| Close whole window | `⇧⌘W` | `Ctrl+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Next / previous, alternate | `⇧⌘]` / `⇧⌘[` | `Ctrl+PageDown` / `Ctrl+PageUp` |
| Jump to tab 1–8 | `⌥⌘1` … `⌥⌘8` | `Ctrl+Alt+1` … `Ctrl+Alt+8` |
| Last tab | `⌥⌘9` | `Ctrl+Alt+9` |

Existing heading shortcuts `⌘1…6` / `Ctrl+1…6` are unchanged. With keyboard focus
on a tab, Left/Right, Home/End navigate; Delete closes; Alt+Shift+Left/Right
reorders it. File and View menus expose the tab commands too.

## Local version history

Open **File ▸ Local History…**, press **⇧⌘H** (**Ctrl+Shift+H** on Windows), or
click the clock button. The sheet belongs to the active document tab. The list
is newest first and shows relative time, absolute local time and byte size; its
hover text includes UTC and exact byte size. Select with the mouse or the arrow
keys, Tab between controls, and use Escape or Close to return to writing.

- **Preview** is read-only source, not executed/rendered Markdown.
- **Line diff** compares the selected snapshot with the current editor, including
  unsaved edits: `−` means removed from the snapshot, `+` added in the editor.
  Large unrelated changes use a non-minimal replacement instead of expensive
  quadratic comparison. Display is limited to 1,000 changed/context lines total,
  and 200,000 characters per block; preview and restored text are complete.
- **Restore** replaces this tab's text as one undoable edit, taking a pre-restore
  snapshot first. Undo/Redo carries BOM and line endings along with the text.
  Restore does not write directly to disk: normal autosave/manual Save applies.
  If autosave is enabled it may save the restored text shortly afterward.
- **Copy snapshot to a new tab** leaves the original alone and creates an Untitled
  copy. Save As chooses its destination.

Restore is blocked if the original has an external change, has been deleted, or
is not valid UTF-8, or if the snapshot itself contains invalid UTF-8. The sheet
explains the block and offers Copy instead (invalid UTF-8 can only be copied as
decoded replacement text). Typing rechecks disk hashes before applying Restore;
normal conflict-copy and invalid-UTF-8 save protections still apply. Typing while
a restore is reading cancels that stale restore rather than overwriting new input.

### What is captured

History is **on by default**, for saved paths only. A successful save (including
autosave or an unchanged Save) is eligible to snapshot its exact saved bytes.
Identical newest content is skipped. Different ordinary saves are limited to
**one snapshot per document per 60 seconds**; rapid saves are skipped, not held
in a timer or deferred. The next eligible save after that minute creates the
next version. History is not a record of every keystroke or every autosave.

Immediately before an external-change reload, Revert, or Restore replaces the
editor text, that text is also eligible for a snapshot, bypassing the minute
throttle (identical newest bytes still deduplicate). These are the only history
captures of unsaved in-memory text. Crash-recovery drafts remain a separate
mechanism and are **not** disabled when version history is switched off.

### Limits and switches

Open **Preferences ▸ Local history settings…** (on Windows, **File ▸
Preferences…**), or expand **Storage, privacy and limits** in the history sheet.

| Default | Rule |
| --- | --- |
| 100 snapshots per document | oldest removed first |
| 90 days | older versions removed, except the newest |
| 200 MiB overall | compressed chunk bytes plus the manifest; oldest eligible versions removed first |
| 5 MiB maximum file | larger saved/encoded content is excluded automatically |

The newest snapshot of **every** document is always retained, even if older than
90 days or if the combined newest snapshots exceed the global cap. The sheet
reports that protected over-budget state. Apply limits prunes immediately; normal
captures and history listing also enforce age/count/storage retention. Shared,
compressed 64 KiB chunks avoid repeatedly storing unchanged parts of long files.

Use **Enable local history** for the global switch and **History for this
document** for the current canonical path. Switching off stops new snapshots but
does not delete old ones. **Clear history for this document** and **Clear all
history** both ask for confirmation. Clearing deletes snapshots and unreferenced
content chunks, not the document files, recovery drafts, limits or document
opt-outs. It is not secure disk erasure and does not remove OS backups.

### Location and privacy

Everything stays inside the app's local **user-data/history** directory. There
are no history files beside your Markdown files, no account, upload or network
service. The sheet shows the exact directory; defaults are:

- macOS: `~/Library/Application Support/Typing/history`
- Windows: `%APPDATA%\Typing\history` (normally
  `C:\Users\<you>\AppData\Roaming\Typing\history`, on a local disk)

`index.json` holds timestamps, original paths, settings and snapshot references;
`blobs/` contains gzip-compressed, content-addressed bytes. These are **unencrypted
private copies of your writing**, protected only by your local account/filesystem.
The UI cannot relocate the store. Do not relocate Electron's user-data directory
into a synced or network folder. Known cloud roots, symlinked history directories
and detected network filesystems are refused; macOS history requires normal local
APFS/HFS storage. Custom sync tools/backups outside Typing's control cannot be
detected universally. If history storage is unavailable, it is logged and the
sheet reports it; **document saves still succeed**.

Identity is the canonical path (case-insensitive on Windows). Symlink aliases
share a history. Renaming/moving a file, or Save As to a different path, starts
separate history; no content-hash fallback attaches another file's private
history. Old-path history remains retained until its limits/clear action remove
it, and is available if a document is reopened at that old path. The latest entry
of even an old path is protected by the newest-per-document rule; Clear all
history removes these orphaned-path snapshots too.

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
line height, autosave, auto-pairing, smart paste, spell check, and Local history
settings (privacy, global/document switches, retention limits and clear actions).

## Recovery

Each dirty tab has one stable local recovery draft, updated after about 300 ms
of idle time. If the app is killed or crashes, the next launch offers **every**
unsaved tab, including multiple Untitled drafts. Restore opens each in its own
dirty tab with its original base hash and byte-format metadata; changed-on-disk
files are never silently overwritten. Untitled requires Save As; normal autosave
settings apply to restored named UTF-8 files. The last few keystrokes before a
crash may precede the latest draft write.

There is no previous-session reopening preference: clean tabs are deliberately
not restored on launch. Only unsaved crash-recovery drafts are offered.

## Keyboard shortcuts, in one place

`Help ▸ Keyboard Shortcuts` lists everything; the full set on macOS:

```
New tab ⌘T / ⌘N · Close tab ⌘W · Close window ⇧⌘W
Next/previous tab Ctrl+Tab / Ctrl+Shift+Tab or ⇧⌘] / ⇧⌘[
Tab 1–8 ⌥⌘1…8 · Last tab ⌥⌘9
Open ⌘O · Open folder ⇧⌥⌘O · Quick open ⇧⌘O · Save ⌘S · Save as ⇧⌘S
Local History ⇧⌘H
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
New tab Ctrl+T / Ctrl+N · Close tab Ctrl+W · Close window Ctrl+Shift+W
Next/previous tab Ctrl+Tab / Ctrl+Shift+Tab or Ctrl+PageDown / Ctrl+PageUp
Tab 1–8 Ctrl+Alt+1…8 · Last tab Ctrl+Alt+9
Open Ctrl+O · Open folder Ctrl+Alt+Shift+O · Quick open Ctrl+Shift+O
Save Ctrl+S · Save as Ctrl+Shift+S · Local History Ctrl+Shift+H
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
- `File ▸ Exit`, the window's ✕ button and `Alt+F4` check every dirty tab before
  closing the window. `Ctrl+W` checks and closes just the active tab.
- Undo/redo are `Ctrl+Z` / `Ctrl+Shift+Z`; `Ctrl+Y` is not bound.
- On keyboard layouts where AltGr is reported as `Ctrl+Alt` (German, Polish,
  French, …), a `Ctrl+Alt+…` shortcut can be swallowed by the layout instead of
  reaching the app. The same commands are in the menus, so nothing is unfixable;
  tell me if you want a different binding for your layout.
- Everything else — autosave, recovery, external-change prompts, export, the
  `assets/` folder for pasted images, recent files — behaves exactly as described
  above; the settings and recovery drafts live in `%APPDATA%\Typing`.