# Typing — usage

Typing opens ordinary markdown files. There is no library, no vault and no
database: a document is the file you opened.

## Opening and saving

| Action | How |
| --- | --- |
| New document | `⌘N` |
| Open a file | `⌘O`, or drag a `.md` file onto the window or the Dock icon |
| Open a folder | `⇧⌥⌘O`, or drag a folder onto the Dock icon |
| Quick open (folder) | `⇧⌘O`, type part of a filename, `↩` |
| Recent files | File ▸ Recent Files… |
| Save | `⌘S` |
| Save as | `⇧⌘S` |
| Revert to saved | File ▸ Revert to Saved |

Saving is quiet: if the bytes on disk already match the document, nothing is
written at all (the file's modification time stays put). Autosave is on by
default and writes shortly after you stop typing; you can turn it off in
Preferences.

If the file is changed by another program while you have unsaved edits, Typing
shows a prompt instead of overwriting anything:

- **Reload from disk** — discard your edits and take the file as it is now.
- **Keep mine as a copy** — your version is written next to the original as
  `name (conflict YYYY-MM-DD HHMMSS).md` and opened in the editor; the other
  program's file is untouched.
- **Ignore** — keep typing; you will be asked again on the next save.

If the file changes while you have *no* unsaved edits, Typing reloads it and
tells you.

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
  location for the image.)

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

The word count, cursor position and save state live in the status bar. The outline
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

`Help ▸ Keyboard Shortcuts` lists everything; the full set:

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