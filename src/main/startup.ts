import { existsSync as fsExists } from 'node:fs'
import { collapsePath, isAbsolutePath, joinPath } from '../shared/paths'

/** Switches that Chromium/Electron add and that are never a document path. */
const IGNORED = /^-{1,2}/

export interface ArgvOptions {
  /** Directory relative arguments are resolved against (defaults to cwd). */
  cwd?: string
  /** Injectable existence check, for unit tests. */
  exists?: (path: string) => boolean
}

/**
 * The document or folder a launch asks Typing to open, taken from `argv`.
 *
 * Covers every platform's shape:
 *  - Windows: `Typing.exe "C:\My Notes\a.md"`, forward slashes, UNC paths, and
 *    the extra arguments Chromium adds (`--user-data-dir=…`, `--no-sandbox`);
 *    a path is also accepted relative to the working directory (drag onto the
 *    executable, "Open with" from a shell in that folder).
 *  - macOS: `Typing.app/Contents/MacOS/Typing /Users/me/notes/a.md`
 *  - Linux: `typing /home/me/notes/a.md`
 *
 * The last existing candidate wins: a shell appends the file it was given last.
 */
export function fileFromArgv(argv: readonly string[], opts: ArgvOptions = {}): string | null {
  return filesFromArgv(argv, opts).at(-1) ?? null
}

/** All launch documents, deduplicated in argument order. */
export function filesFromArgv(argv: readonly string[], opts: ArgvOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const exists = opts.exists ?? ((p: string): boolean => fsExists(p))
  const candidates: string[] = []
  for (const rawArg of argv.slice(1)) {
    if (typeof rawArg !== 'string') continue
    // Shells hand over the path with or without quotes depending on the platform;
    // a quoted path also survives a crude `argv.join(' ')` from an installer.
    const arg = rawArg.replace(/^"(.*)"$/s, '$1').trim()
    if (!arg || IGNORED.test(arg)) continue
    // The executable itself, when a launcher forwards the whole command line.
    if (/\.(app|exe)$/i.test(arg)) continue
    candidates.push(arg)
  }
  const files: string[] = []
  for (const candidate of candidates) {
    const absolute = isAbsolutePath(candidate) ? collapsePath(candidate) : collapsePath(joinPath(cwd, candidate))
    try {
      if (exists(absolute) && !files.includes(absolute)) files.push(absolute)
    } catch {
      /* an unreadable argument is simply not a document */
    }
  }
  return files
}