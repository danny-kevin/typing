# Third-party software

Typing's own source is original work. The application is assembled from the
following upstream packages, installed from the public npm registry with their
licenses unmodified. No assets (icons, styles, themes, fonts, strings) were taken
from any other editor application.

## Runtime libraries bundled into the app

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| [@codemirror/state](https://github.com/codemirror/state) | 6.7.6 | MIT | editor state, transactions, compartments |
| [@codemirror/view](https://github.com/codemirror/view) | 6.43.15 | MIT | editor view, decorations, widgets |
| [@codemirror/commands](https://github.com/codemirror/commands) | 6.11.1 | MIT | default keymap, history |
| [@codemirror/language](https://github.com/codemirror/language) | 6.13.1 | MIT | syntax highlighting, bracket matching |
| [@codemirror/lang-markdown](https://github.com/codemirror/lang-markdown) | 6.5.2 | MIT | markdown grammar and nested code highlighting |
| [@codemirror/language-data](https://github.com/codemirror/language-data) | 6.5.2 | MIT | language descriptors for fenced code blocks |
| [@codemirror/autocomplete](https://github.com/codemirror/autocomplete) | 6.20.4 | MIT | bracket closing |
| [@codemirror/search](https://github.com/codemirror/search) | 6.7.2 | MIT | selection match highlighting |
| [@lezer/common](https://github.com/lezer-parser/common) | 1.5.5 | MIT | syntax tree primitives |
| [@lezer/highlight](https://github.com/lezer-parser/highlight) | 1.2.5 | MIT | highlight style definitions |
| [katex](https://katex.org) | 0.19.1 | MIT | TeX rendering (maths) |
| [mermaid](https://mermaid.js.org) | 12.3.0 | MIT | diagram rendering |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 15.0.3 | MIT | HTML export |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.4.17 | MPL-2.0 OR Apache-2.0 | sanitising exported HTML |
| [Electron](https://www.electronjs.org) | 45.2.3 | MIT | desktop runtime |

Electron itself bundles Chromium and Node.js; their licenses ship with the app —
`Typing.app/Contents/Resources/` on macOS, and `LICENSE.electron.txt` plus
`LICENSES.chromium.html` next to `Typing.exe` on Windows — and are not reproduced
here.

## Build- and test-time only (not shipped in the app bundle)

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| [electron-vite](https://github.com/alex8088/electron-vite) | 6.0.0 | MIT | build orchestration |
| [vite](https://vite.dev) | 8.3.6 | MIT | bundling |
| [electron-builder](https://www.electron.build) | 26.18.0 | MIT | macOS and Windows app packaging (Windows builds also use its bundled 7-Zip and resource editor; nothing is installed globally) |
| [typescript](https://www.typescriptlang.org) | 7.0.2 | Apache-2.0 | type checking |
| [vitest](https://vitest.dev) | 5.1.0 | MIT | unit tests |
| [playwright](https://playwright.dev) | 1.65.0 | Apache-2.0 | end-to-end tests against the packaged app |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 26.6.6 | MIT | type definitions |
| [@types/katex](https://github.com/DefinitelyTyped/DefinitelyTyped) | 0.16.8 | MIT | type definitions |
| [@types/markdown-it](https://github.com/DefinitelyTyped/DefinitelyTyped) | 14.2.0 | MIT | type definitions |
| [@types/dompurify](https://github.com/DefinitelyTyped/DefinitelyTyped) | 3.0.5 | MIT | type definitions |

## Fonts

Typing ships no font files. The editor uses the operating system's UI fonts:
`-apple-system` / `PingFang SC` on macOS, `Segoe UI` / `Microsoft YaHei` on
Windows, and the system monospace font (`SF Mono` / `Cascadia Mono` / `Consolas`)
on each. KaTeX's bundled web fonts (SIL Open Font License) are shipped inside the
katex package for maths rendering.

## Artwork

`build/icon.icns` (macOS) and `build/icon.ico` (Windows, 16–256 px) are generated
from `scripts/make-icon.mjs`, which draws the icon programmatically (rounded
square, gradient and a "T" mark with a caret) and encodes PNG, ICNS and ICO with
its own encoders — no image library is involved. It is original artwork created
for this project; it is not derived from any other application's icon.