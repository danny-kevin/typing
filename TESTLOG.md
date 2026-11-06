# Test log

All results below were produced by running the commands in this file, against the
packaged `release/mac-arm64/Typing.app` built from this branch. Nothing here is an
estimate; rerun the commands to reproduce.

Environment: macOS (arm64), Electron 45.2.3, Node 26.4.0, 2026-11-06.

## 1. Unit tests — `npm test` (vitest)

```
Test Files  4 passed (4)
Tests       80 passed (80)
```

| Suite | What it covers |
| --- | --- |
| `test/unit/fidelity.test.ts` | decode→encode is byte-identical for the whole corpus (nested lists, tables, links, front matter, HTML blocks, maths, mermaid, Chinese, unknown syntax, code fences), plus UTF-8 BOM preservation, CRLF preservation, no-trailing-newline, empty file, BOM-only file, lone `\r`, invalid UTF-8 flagging, trailing whitespace/tabs, and "edit one line ⇒ only that line differs" |
| `test/unit/markdown.test.ts` | outline extraction (fences/front matter/setext), GFM table parse/serialise stability, row/column/alignment edits, table edit locality (neighbours untouched), maths scanning outside code, statistics (CJK + latin), inline wrap/unwrap, line prefixes, heading levels, list continuation, task toggling |
| `test/unit/inline.test.ts` | inline scanner (strong/em/code/strike/highlight/link/image/reference links), no false positives on `2 * 3`, `snake_case`, Chinese prose; block scanner classification |
| `test/unit/commands.test.ts` | every accelerator parses, no duplicate bindings, `⌘S` vs `⇧⌘S`, Option-modified keys, digit headings, punctuation keys |

## 2. Packaged-app smoke test — `npm run smoke`

Launches the real `.app` binary, opens a markdown file through the same path a
double-click uses, types with the keyboard, saves with `⌘S`, and checks the file.

```
14/14 checks passed
```

Checks include: window appears, sample file opens, content is in the editor, live
preview styles headings, the title shows the dirty marker, `⌘S` writes the edit,
front matter bytes are preserved, unrelated content (Chinese paragraph) is
preserved, the dirty flag clears after save, `⌘/` toggles source mode, `⌘F` opens
the find bar and reports `1 / 1`, **saving an unmodified document does not rewrite
the file** (same bytes *and* same mtime), and no renderer errors are logged.

## 3. Feature suite — `npm run smoke:features`

One app instance, driven through the real UI and IPC surface, with `TYPING_TEST=1`
(a test-only hook in the preload bridge) and an isolated `--user-data-dir`:

```
28/28 checks passed
```

Covered: folder sidebar from a folder launch, quick open (`⇧⌘O`) finding and opening
a file, GFM table widget, clicking a table to reveal markdown, adding a table row
through the menu command and verifying the markdown, task-list checkboxes and
clicking one to rewrite `[ ]`→`[x]`, **Chinese IME composition** (`Input.imeSetComposition`
then commit) landing as `你好，世界。`, image paste saving `assets/pixel….png` and
inserting a relative link, autosave writing without `⌘S`, external file change
raising a non-destructive prompt, keeping local edits producing a
`(conflict …).md` copy while the original keeps the other program's text, HTML
export (KaTeX rendered, no remote resources), PDF export (`%PDF-`, 50 kB),
**open + save is byte-identical for all 10 corpus files** (and their mtimes are
untouched), a CRLF file keeps CRLF after editing, a UTF-8 BOM survives exactly
once, `⌘W` on a dirty document asks before closing, cancelling keeps the
document, and no renderer errors.

## 4. Performance — `npm run perf`

Generated documents: `everyday-100kb.md` (100 KB) and `stress-1mb.md` (1 MB, with
tables, code fences, display maths and mermaid diagrams every few sections).
Latency is measured in the renderer as keydown → next animation frame; scrolling
moves one screen per step.

| Document | Launch | Typing median | Typing p95 | Scroll median | Scroll p95 |
| --- | --- | --- | --- | --- | --- |
| 100 KB | 517 ms | 3.5 ms | 7.3 ms | 13.9 ms | 43.2 ms |
| 1 MB | 564 ms | 5.7 ms | 7.5 ms | 14.5 ms | 121.7 ms |

A shorter, bounded re-measurement on the final build (30 keystrokes, 8 scroll
steps, 1 MB document) gave: launch 0.87 s, typing median 9.9 ms, p95 16.8 ms,
scroll frames 12–28 ms. The spread between runs is JIT warm-up and widget layout
on first entry; both sets are inside one 60 Hz frame for typing.

**`npm run perf` can hang.** It was run successfully several times (the table
above), but one run never returned and left two `Typing` processes behind on a
loaded machine; the run had to be killed. The script now has a 240-second
watchdog that kills its Electron processes and exits non-zero, and it force-kills
the app if `close()` does not finish in five seconds. Treat the numbers above as
the recorded result and do not run the bench in a foreground shell without a
timeout.

Notes: the 1 MB scroll p95 excursions happen when large block widgets (tables,
diagrams) enter the viewport for the first time; diagrams render lazily and one at
a time, so they never block typing. Only the visible window (±120/220 lines) is
decorated; a scroll that stays inside the decorated window costs nothing. Raw
numbers are in `test/perf/last-run.json`.

## 5. Manual / one-off checks (not part of the automated suites)

**Crash recovery.** With autosave disabled, typed into a file, waited for the
draft, `kill -9` the app, relaunched with the same data directory: the
"Recover unsaved work" dialog appeared, Restore restored the unsaved text, and
the file on disk still held the pre-crash content.

**System clipboard image.** Put a PNG on the macOS clipboard with
`osascript -e 'set the clipboard to (read (POSIX file "icon.png") as «class PNGf»)'`,
pressed `⌘V` in the editor: the image was written to `assets/` and
`![image](assets/image-….png)` was inserted. (This clobbers the clipboard, which
is why it is not in the automated suite.)

**Save-and-quit.** `⌘W` on a dirty document → "Unsaved changes" → Save wrote the
file and closed the window.

**Layout.** Window probes at 1180×820 and 700×480: no horizontal overflow, the
status bar sits flush at the bottom, the outline and sidebar collapse correctly.

## 6. Manual checks performed (screenshots taken locally, not committed)

- Light and dark theme rendering; theme follows the system setting live.
- Front matter collapsed to a chip when the caret is away, raw when on it.
- Mermaid and KaTeX widgets render on screen; clicking a table or diagram puts the
  caret back into its source.
- Source mode shows plain markdown with syntax colouring and the same caret.
- File sidebar tree, outline follow-the-cursor, word count, save chip.

## Known gaps in this run

- No automated test for the macOS "open with" dialog or the Dock drop (the code
  path `app.on('open-file')` is the same one exercised by the argv launch, which is
  tested).
- PDF export is verified to produce a valid PDF and by eye, not by pixel diffing.
- No CI; everything runs locally.
- `npm run perf` hung once on a loaded machine (see above); it now has a watchdog
  but was not re-run afterwards, so the newest perf numbers are the bounded
  30-keystroke measurement, not a fresh `npm run perf` run.