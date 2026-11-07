# Typing

A local-first, WYSIWYG markdown editor for macOS and Windows. Write in a page that
already looks like the finished document, switch to raw markdown with `⌘/`
(`Ctrl+/` on Windows), and keep the file on disk **byte-for-byte** as it was.

Typing was written from scratch as a clean-room project. It contains no code,
styles, themes, icons or strings from any other editor; every dependency comes
from its normal upstream npm package (see [THIRD_PARTY.md](THIRD_PARTY.md)).

- No accounts, no telemetry, no update checks, no network requests.
- Files are plain `.md` files in folders you choose.
- A strict Content Security Policy plus a whitelisted local asset protocol: the
  renderer can read images from folders you opened, and nothing else.
- Rendered HTML is sanitised; document content is never executed.

## Run the built app

### macOS

```
open build/Typing.app          # if you copied the built bundle here
```

or, from a checkout:

```
npm install
npm run package                 # builds + packages release/mac-arm64/Typing.app
open release/mac-arm64/Typing.app
```

The packaged app is unsigned (ad-hoc signed for local use). macOS may ask you to
confirm the first launch of an app downloaded/extracted from elsewhere; a locally
built copy launches normally.

### Windows 10/11 (x64)

From a checkout on any machine — macOS, Linux or Windows:

```
npm install
npm run package:win     # builds, packages and verifies the Windows x64 app
```

That produces:

```
release/win-unpacked/                  the unpacked app directory (Typing.exe inside)
release/Typing-0.1.0-win-x64.zip       the same directory as a zip
```

`npm run package:win` runs `npm run verify:win` at the end, which inspects the
artefact (see [Verifying the Windows package](#verifying-the-windows-package)).
Building the Windows package needs **no Windows machine, no wine, no signing
certificate and no global installs**: electron-builder downloads the official
Electron Windows runtime and edits `Typing.exe`'s icon and version resource
itself.

To run it on Windows: unzip `Typing-0.1.0-win-x64.zip` (keeping the folder
structure — `Typing.exe` needs the DLLs and `resources/` next to it), then start
`Typing.exe`. There is no installer, so the first launch shows the usual
SmartScreen warning for an unsigned program: choose **More info → Run anyway**.
Nothing is written outside the app folder and `%APPDATA%\Typing`.

The zip build does not register file associations by itself (that needs an
installer that writes registry entries). Preferences are in `File ▸ Preferences…`
on Windows, and About is in Help. To open `.md` files with Typing, use
**Open with → Choose another app → More apps → Look for another app on this PC**
and pick `Typing.exe`, or drag a file onto the window, or pass it on the command
line: `Typing.exe "C:\Users\me\notes\today.md"`.

Where Windows keeps your data (same layout as macOS, under the user-data folder
Electron reports, `%APPDATA%\Typing` by default):

| File | Purpose |
| --- | --- |
| `preferences.json` | theme, fonts, autosave and view settings |
| `recent-files.json` | File ▸ Recent Files |
| `recovery\*.json` | crash-recovery drafts of unsaved work |

### Development

```
npm install
npm run dev        # electron-vite dev server with hot reload
npm test           # unit tests (vitest)
npm run smoke      # packaged-app end-to-end test (macOS; Windows: see below)
npm run smoke:features
npm run smoke:caret      # pointer/caret alignment on the packaged app
npm run smoke:datasafety # unsaved-work guard, conflicts, CSP, asset protocol
npm run build      # compile main, preload and renderer into out/
npm run verify:win # inspect release/win-unpacked and the zip
```

The four end-to-end suites launch the packaged app. They choose the binary from
the platform (`release/mac-arm64/Typing.app/Contents/MacOS/Typing` on macOS,
`release/win-unpacked/Typing.exe` on Windows) and use `ControlOrMeta` shortcuts,
so `npm run smoke`, `npm run smoke:features`, `npm run smoke:caret` and
`npm run smoke:datasafety` can be run on Windows after `npm run package:win`.
Override the target with
`TYPING_APP=<directory>` if the build lives somewhere else.

Node 26 is what this repository was built with; any current LTS Node works. The
project does not modify the system Node or install global packages.

## Verifying the Windows package

`npm run verify:win` (`scripts/check-win-package.mjs`) does not start the app — it
inspects the artefact, because the build machine may not be able to run Windows
binaries:

- `Typing.exe` is a PE32+ (64-bit) executable with the x64 machine type and the
  Windows GUI subsystem, and it carries the version resource and every icon size
  from `build/icon.ico`;
- the package holds the Windows Electron runtime (`resources.pak`, `icudtl.dat`,
  `snapshot_blob.bin`, `ffmpeg.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`,
  `locales/en-US.pak`, the Chromium licences) and no macOS or Linux binaries;
- `resources/app.asar` contains `out/main/index.js`, `out/preload/index.js`,
  `out/renderer/index.html` and the renderer assets, with no `node_modules` and
  no macOS-only files;
- the zip has a readable central directory, forward-slash paths, `Typing.exe` at
  the root, and every entry extracts with a matching CRC32 (also cross-checked
  with `unzip -t` when it is installed).

What this cannot prove is that the app *runs* on Windows. See
[TESTLOG.md](TESTLOG.md) for exactly which behaviours are unverified and for the
manual checklist to run on a Windows machine.

## Why CodeMirror live preview instead of a rich-text (ProseMirror/Milkdown) core

The hard requirement for this editor is source fidelity: opening and saving a
file without editing must not change a single byte, and syntax the editor does
not model (front matter, HTML blocks, MDX-ish markup, malformed tables, unknown
directives) must survive editing round trips.

A structured rich-text model (Milkdown/ProseMirror, Tiptap, and every other
schema-based editor) stores a *normalised* document and serialises it back. That
rewrites list markers, escapes characters, drops unknown blocks, and cannot
preserve bytes it never modelled. Making it byte-faithful is not a matter of
configuration: the document model itself has to change.

So Typing uses the opposite architecture, which is also how the behaviour we are
inspired by actually feels in use:

- The document model **is** the markdown text (a CodeMirror 6 buffer).
- The "preview" is a set of decorations over that text: headings are larger,
  markers fade out when the caret is elsewhere and reappear on the line you are
  editing, maths/diagrams/tables/images are replaced by live widgets, and the
  source bytes are never touched.
- Source mode is the same buffer with the decorations removed — not a second
  document, not a serialisation step.

This gives, by construction: no re-serialisation, no lossy round trip, instant
mode switching with caret/undo intact, and a document that stays a text file.
Milkdown was evaluated first and rejected for exactly this reason; the trade-off
is that we implement markdown-aware decorations, widgets and keyboard behaviour
ourselves, which this repository does in `src/shared/` and
`src/renderer/src/editor/`.

## Layout

```
src/main/           Electron main process: windows, menus, file IO, exports,
                    asset protocol, preferences, recovery, external-change watch
src/preload/        contextBridge API (no Node in the renderer)
src/renderer/src/   editor core, live-preview decorations, widgets, UI panels
src/shared/         pure modules: byte-faithful encode/decode, markdown scanning
                    and text transforms, command/accelerator table, cross-platform
                    path helpers, asset URL resolution
test/unit/          vitest suites (fidelity, markdown, inline scanner, commands,
                    paths, asset URLs, menu shape, argv startup)
test/smoke/         Playwright end-to-end tests against the packaged app
test/perf/          stress-document generator and benchmark
samples/            a document that exercises every supported construct
build/icon.icns     macOS icon, generated (not hand-drawn binaries)
build/icon.ico      Windows icon, generated from the same artwork
scripts/make-icon.mjs         generates the original app icon (PNG, ICNS, ICO)
scripts/check-win-package.mjs inspects the Windows package and the zip
```

## The fidelity model

`src/shared/doc.ts` records the things a JavaScript string cannot hold: a UTF-8
BOM and the ending of **every** line. Decoding normalises CRLF, LF and lone CR to
LF for editing, and encoding restores each line's original ending, so a file that
mixes them comes back unchanged; lines you add take the file's dominant ending.
Saving compares the editor's text with what is on disk and **does not write at
all** when they match, so an untouched file keeps its bytes *and* its
modification time. `src/main/save-doc.ts` owns the write: a file that changed
since it was opened (compared by content hash, not by mtime) is never replaced —
the version you were editing is written next to it as a conflict copy instead —
and bytes that are not valid UTF-8 are never overwritten without an explicit
choice.

The unit tests cover CRLF files, UTF-8 BOM (with or without CRLF), mixed-ending
files, files with no trailing newline, lone `\r` characters that are not line
endings, invalid UTF-8, and edits inside a mixed file that must leave the other
endings alone.


Unsupported syntax is never parsed into a structure and then rebuilt: it is text,
so it survives. Edits are plain text splices, so a table edit rewrites the table
block and nothing else.

## Safety

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- CSP: `default-src 'none'`; scripts only from the bundle; images/fonts only from
  the app, `data:` and the `typing-asset:` protocol; `connect-src` allows the app
  and nothing else in a packaged build (the dev server's localhost origins are
  added only by `electron-vite dev`); no frames, no objects.
- `typing-asset://` serves files only from folders the user explicitly opened,
  after resolving both the folder and the requested path with `realpath`, so a
  symlink inside an opened folder cannot reach a file outside it.
- Every way of leaving a document goes through one unsaved-work guard
  (`guardUnsavedWork`), and a switch also drops the previous document's undo
  history, search results and pending autosave.
- HTML in documents is shown as text and never injected into the DOM. Export
  sanitises with DOMPurify, and remote resources are never fetched.
- Mermaid renders with `securityLevel: 'strict'`; KaTeX runs with `trust: false`.

## Known limitations

- Live preview decorates a window around the viewport (≈120 lines above, ≈220
  below). Scrolling a very long code block that started far above the viewport
  shows its body as plain styled text until that fence line gets near the screen.
- GFM tables only (no merged cells); alignment and row/column editing are
  supported, complex nested tables are not.
- Mermaid layout of large diagrams can take a moment; diagrams render lazily, one
  at a time, only when visible.
- Platforms: macOS (arm64) and Windows 10/11 (x64). Linux is not built or tested.
- The Windows build is unsigned and ships as a zip, not an installer, so the file
  type association has to be made by hand (see above) and SmartScreen warns on the
  first launch. There is no auto-updater.
- The app has been built and inspected for Windows but not launched on a Windows
  machine in this repository's own testing; TESTLOG.md lists what that leaves
  unverified and how to check it.
- No sync, collaboration, plugins, AI features or code signing with a developer
  certificate.

See [USAGE.md](USAGE.md) for how to use the app, and [TESTLOG.md](TESTLOG.md) for
the real test results.