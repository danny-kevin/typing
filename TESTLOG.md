# Test log

All results below were produced by running the commands in this file, against the
packaged `release/mac-arm64/Typing.app` built from this branch. Nothing here is an
estimate; rerun the commands to reproduce.

Environment: macOS (arm64), Electron 45.2.3, Node 26.4.0, 2026-11-06.

## 1. Unit tests — `npm test` (vitest)

```
Test Files  5 passed (5)
Tests       123 passed (123)
```

| Suite | What it covers |
| --- | --- |
| `test/unit/fidelity.test.ts` | decode→encode is byte-identical for the whole corpus (nested lists, tables, links, front matter, HTML blocks, maths, mermaid, Chinese, unknown syntax, code fences), plus UTF-8 BOM preservation, CRLF preservation, no-trailing-newline, empty file, BOM-only file, lone `\r`, invalid UTF-8 flagging, trailing whitespace/tabs, and "edit one line ⇒ only that line differs". Also the mixed-ending cases: `one\r\ntwo\r\nthree\n`, LF-dominant with a CRLF line, CRLF+LF+lone CR, an all-lone-CR file, each with and without a BOM; and `remapLineEndings` (unchanged lines keep their ending, new lines take the dominant one, deletion, no-trailing-newline, empty original) |
| `test/unit/save-safety.test.ts` | the write path against a real temp directory: no-edit saves leave bytes *and* mtime alone (mixed, BOM, lone-CR, plain); an edit keeps each existing ending and gives new lines the dominant one; a BOM survives exactly once; a non-UTF-8 file is refused in place, reported unchanged when untouched, and written only with explicit consent; a same-millisecond external write is caught by content hash; a write landing after the temporary file exists is caught before the rename; the other writer's bytes and our copy both survive; a file deleted before or during the save is recreated and reported; `onConflict: 'report'` writes nothing; no temporary files are left behind |
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

## 4. Pointer/caret alignment — `npm run smoke:caret`

Regression suite for the "the caret is much lower than the mouse pointer" bug.
It launches the packaged app seven times (fresh document, collapsed front
matter, source mode, a long scrolled document, outline/focus/typewriter modes, a
folder launch with the sidebar, two window sizes, devicePixelRatio 2) and, in
each one, measures two things:

1. **geometry** — no vertical space inside `.cm-content` that sits outside the
   boxes CodeMirror measures (`contentHeight − padding − Σ line border boxes`);
2. **behaviour** — a real mouse click (`webContents.sendInputEvent`) must place
   the caret on the line under the pointer, and a real pointer drag
   (`page.mouse`, which is what extends a selection; a synthesised
   `sendInputEvent` mouse move has no button state and does not drag) must end
   its selection head on the line under the pointer.

Same suite, same packaged bundle, before and after the fix (macOS arm64):

| Build | Result | Unmeasured vertical space | Worst click→caret miss |
| --- | --- | --- | --- |
| before (previous `Typing.app`) | 12/27 checks | 126.5 px on the headings document, 101.3 px with a collapsed front-matter chip, 93 px on the mixed document | 317 px, 1/18 clicks correct on the headings document |
| after (this branch) | **27/27 checks** | 0 px in every scenario | ≤ 11 px (the caret's own leading, constant) |

Failures before the fix were systematic, not random: 0–5 of 18 clicks landed on
the clicked line, the drift grew with every heading above the click point, and a
drag selection from a paragraph to a heading ended up to 234 px below the
pointer. Source mode (no heading/chip decorations) passed 23/23 clicks before the
fix as well, which is what identified the decorated lines as the trigger.

Cause: CodeMirror 6 builds its height map from `getBoundingClientRect().height`
of each line, which is the border box — a vertical **margin** on a line is space
the editor cannot see. `style.css` gave h1–h3 their leading with `margin-top` and
the collapsed front-matter chip `margin: 6px 24px 12px`, so the document grew by
exactly the sum of those margins (126.5 px on the headings document) while the
height map stayed short; every click mapped that many pixels too far down the
document and the caret was drawn below the pointer. The fix moves that spacing
into `padding-top` on the line (`.cm-line.cm-h1/h2/h3`, and a
`.cm-frontmatter-chip` line class from `live-preview.ts`), which is inside the
measured box. The rendering is unchanged to the pixel: with the same document,
every line's glyph top and glyph height is identical to the previous build, and
`.cm-content` keeps exactly the same height (verified by comparing the shipped
bundle against the new build).

Full suites re-run on the packaged bundle copied to
`/Users/danny/Projects/typing-build/Typing.app` (macOS arm64, Electron 45.2.3,
Node 26.4.0, 2026-11-07):

| Suite | Result (final branch, after the data-safety change) |
| --- | --- |
| `npm test` | 123/123 tests, 5 files |
| `npm run smoke` | 14/14 checks |
| `npm run smoke:features` | 28/28 checks |
| `npm run smoke:caret` | 27/27 checks |
| `npm run smoke:datasafety` | 63/63 checks (section 5) |

## 5. Data safety — `npm run smoke:datasafety`

New suite for the two reproduced defects and the risks that were verified with a
real reproduction. It launches the packaged app in six fresh instances (each with
its own `--user-data-dir`, so Electron's single-instance lock can never answer for
a run) and drives the real UI:

```
63/63 checks passed
```

| Group | Checks |
| --- | --- |
| Unsaved-work guard | `⌘N` on an untitled draft asks `Save / Don't Save / Cancel`; Cancel keeps the draft; a cancelled Save As keeps the draft *and* aborts the switch; Save on an untitled draft goes through Save As, writes the file and only then switches; a named dirty document asks too, Cancel writes nothing, Don't Save discards, Save writes first; quick open asks before replacing unsaved work; a file delivered over the `open-file` event (the path the Finder and the Dock use) asks first too; `⌘W` asks through the same guard; a pending autosave is dropped when the document is left |
| Undo / in-flight saves | `⌘Z` after switching documents does not restore the previous file; a save started for one file writes that file and never the one opened next; the editor shows the document opened last |
| Mixed line endings | `one\r\ntwo\r\nthree\n` keeps its exact bytes on open + save *and* its mtime; an edit keeps CRLF/LF and gives the new line the dominant CRLF; a BOM + mixed-ending file is unchanged on open + save, and after an edit keeps one BOM and every original ending |
| Non-UTF-8 files | opening warns; `⌘S` leaves the bytes alone and offers Save As; `file.save` refuses with `code: invalid-utf8`; explicit consent writes valid UTF-8 |
| Concurrent writers | a same-millisecond external write (mtime restored) is caught by content hash: the other program's file is untouched and our text lands in a conflict copy; deleting the open file is reported and the next save recreates it |
| Asset protocol | an image inside an opened folder is served (200); a symlink inside that folder pointing outside it is refused (403); a path outside every opened folder is refused (403) |
| Spell check / CSP | the packaged main process enables the spell checker engine, the preference toggles `spellcheck` in the editor DOM; the packaged CSP has no localhost origin and a page script cannot reach a local HTTP server (0 requests arrive) |

What the same cases did on the pre-fix bundle
(`/Users/danny/Projects/typing-build/Typing.app` as it was before this branch —
probes kept outside the worktree):

| Case | Pre-fix result | After |
| --- | --- | --- |
| `⌘N` with an untitled draft | no dialog, editor emptied, `⌘Z` could not bring it back | dialog, Cancel/Don't Save/Save |
| `⌘N` with a **named** dirty document | no dialog; the edit never reached disk and the editor was emptied | dialog; Save writes first, Cancel keeps everything |
| `one\r\ntwo\r\nthree\n` + `⌘S` | became `one\r\ntwo\r\nthree\r\n` | bytes and mtime unchanged |
| non-UTF-8 file + `⌘S` | `0xFF 0xFE` replaced by two U+FFFD, no warning | refused, banner, original bytes untouched |
| external write within the same millisecond | silently overwritten, no conflict copy | detected by hash, conflict copy, original kept |
| symlink inside the opened folder | served the file outside it (`TOP SECRET`) | 403 |
| packaged CSP | `connect-src 'self' typing-asset: ws://localhost:* http://localhost:*` | `connect-src 'self' typing-asset:` |
| spell-check preference | `webPreferences.spellcheck: false` while the preference claimed on | engine enabled, preference drives the editor attribute |

Two notes on honesty:

- The guard checks cannot run against the pre-fix bundle directly: it lacks the
  `__typingTest.state/newDocument` hooks they use. The pre-fix rows above come
  from separate probes that drive the same UI paths (`⌘N`, keyboard typing, `⌘S`,
  `fetch` of a `typing-asset://` URL) without those hooks.
- Spell check is verified at the setting level, not by eye: no dictionary
  service is available in this automation environment, so right-clicking a
  misspelled word produced no `misspelledWord` in either build and the red
  underline could not be observed. The engine switch and the preference-to-DOM
  wiring are both checked; the visible squiggle in a real session is not.

The suite also uncovered and pinned one pre-existing bug it depends on: a table
operation left a selection running past the rewritten table, which made the lines
after the table render as raw source (the task-list checkboxes disappeared). The
selection is now collapsed at the end of the rewritten block, with a unit test in
`test/unit/markdown.test.ts`.

## 6. Performance — `npm run perf`

Generated documents: `everyday-100kb.md` (100 KB) and `stress-1mb.md` (1 MB, with
tables, code fences, display maths and mermaid diagrams every few sections).
Latency is measured in the renderer as keydown → next animation frame; scrolling
moves one screen per step.

| Document | Launch | Typing median | Typing p95 | Scroll median | Scroll p95 |
| --- | --- | --- | --- | --- | --- |
| 100 KB | 1927 ms | 4.6 ms | 7.3 ms | 14.3 ms | 67.3 ms |
| 1 MB | 1077 ms | 11.5 ms | 16.8 ms | 21.5 ms | 96.8 ms |

The numbers above are the last run of this branch, on a machine that three
worktrees were sharing, so treat them as a sanity check rather than a benchmark:
earlier recorded runs on the same code were 2126/1389 ms launch, 4.8/11.5 ms
typing median and 14.1/20.1 ms scroll median, and the older log above (517/564 ms
launch) was measured on an idle machine. Raw numbers are in
`test/perf/last-run.json`.

**The bench no longer hardcodes `/tmp` or kills by process name.** Each run takes
its own `mkdtemp` directory (removed afterwards), signals only the Electron
processes it launched and their descendants (resolved from `ps` by pid, never by
name), and has two ceilings: 150 s per document and a 300 s watchdog; both kill
only those processes and exit non-zero. It was run twice on this branch and
finished normally both times (`exit 0`), and left no `typing-perf-*` directory
and no `Typing` process behind.

Notes: the 1 MB scroll p95 excursions happen when large block widgets (tables,
diagrams) enter the viewport for the first time; diagrams render lazily and one at
a time, so they never block typing. Only the visible window (±120/220 lines) is
decorated; a scroll that stays inside the decorated window costs nothing. Raw
numbers are in `test/perf/last-run.json`.

## 7. Manual / one-off checks (not part of the automated suites)

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

## 8. Manual checks performed (screenshots taken locally, not committed)

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
- Spell check is verified at the setting level only: no dictionary service was
  available in the automation environment, so the red underline of a misspelled
  word could not be observed in either build.
- One `npm run smoke` run of the copied bundle reported
  `title clears the dirty flag after save` as a failure under heavy machine load
  and passed on the immediate rerun (14/14). That check now waits for the title
  instead of assuming a fixed delay after `⌘S`.
- The mixed line-ending guarantees are tested for UTF-8 files (edit, no-edit,
  BOM, lone CR, LF/CRLF mixes). Files that are not valid UTF-8 are refused in
  place, so their internal endings were not round-tripped by design.