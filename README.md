# Typing

A local-first, WYSIWYG markdown editor for macOS. Write in a page that already
looks like the finished document, switch to raw markdown with `⌘/`, and keep the
file on disk **byte-for-byte** as it was.

Typing was written from scratch as a clean-room project. It contains no code,
styles, themes, icons or strings from any other editor; every dependency comes
from its normal upstream npm package (see [THIRD_PARTY.md](THIRD_PARTY.md)).

- No accounts, no telemetry, no update checks, no network requests.
- Files are plain `.md` files in folders you choose.
- A strict Content Security Policy plus a whitelisted local asset protocol: the
  renderer can read images from folders you opened, and nothing else.
- Rendered HTML is sanitised; document content is never executed.

## Run the built app

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

### Development

```
npm install
npm run dev        # electron-vite dev server with hot reload
npm test           # unit tests (vitest)
npm run smoke      # packaged-app end-to-end test
npm run smoke:features
npm run build      # compile main, preload and renderer into out/
```

Node 26 is what this repository was built with; any current LTS Node works. The
project does not modify the system Node or install global packages.

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
                    and text transforms, command/accelerator table
test/unit/          vitest suites (fidelity, markdown, inline scanner, commands)
test/smoke/         Playwright end-to-end tests against the packaged app
test/perf/          stress-document generator and benchmark
samples/            a document that exercises every supported construct
scripts/make-icon.mjs  generates the original app icon (no image dependencies)
```

## The fidelity model

`src/shared/doc.ts` records the two things a JavaScript string cannot hold: a
UTF-8 BOM and the file's newline convention. Decoding only normalises CRLF to LF
for editing, and encoding restores exactly what was there. Saving compares the
encoded bytes with what is on disk and **does not write at all** when they match,
so an untouched file keeps its bytes *and* its modification time.

Unsupported syntax is never parsed into a structure and then rebuilt: it is text,
so it survives. Edits are plain text splices, so a table edit rewrites the table
block and nothing else.

## Safety

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- CSP: `default-src 'none'`; scripts only from the bundle; images/fonts only from
  the app, `data:` and the `typing-asset:` protocol; no `connect-src` to anything
  but the app and the dev server; no frames, no objects.
- `typing-asset://` serves files only from folders the user explicitly opened,
  after resolving the path and checking it stays inside that folder.
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
- macOS only (arm64 build). Windows/Linux are out of scope for this version.
- No sync, collaboration, plugins, AI features or code signing with a developer
  certificate.

See [USAGE.md](USAGE.md) for how to use the app, and [TESTLOG.md](TESTLOG.md) for
the real test results.