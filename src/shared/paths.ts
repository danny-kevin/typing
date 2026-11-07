/**
 * Small, dependency-free path helpers shared by the renderer, the preload
 * bridge, the main process and the unit tests.
 *
 * The renderer has no Node built-ins (sandboxed, no `node:path`), so anything it
 * needs to do with a path — showing a file name, building a relative image link,
 * resolving an asset URL — goes through here. Every helper understands both
 * POSIX (`/Users/danny/notes`) and Windows (`C:\Users\danny\notes`,
 * `\\server\share\notes`) paths, so one code base serves both platforms.
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const WINDOWS_SEPARATOR = /\\/

/** True for `C:\x`, `C:/x` and `\\server\share`. */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_ABSOLUTE.test(path) || path.startsWith('\\\\')
}

/** The separator a path already uses; the platform default otherwise. */
export function sepFor(path: string): '\\' | '/' {
  return isWindowsPath(path) || WINDOWS_SEPARATOR.test(path) ? '\\' : '/'
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path)
}

/** Everything after the last separator (`C:\a\b.md` → `b.md`). */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Everything before the last separator, keeping the path's own style. */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut === -1) return ''
  if (cut === 0) return path.slice(0, 1)
  // `C:\a` → `C:\` (not `C:`), `C:\` stays as it is.
  if (/^[A-Za-z]:$/.test(path.slice(0, cut))) return path.slice(0, cut + 1)
  return path.slice(0, cut)
}

/** Join path fragments with the separator the first fragment uses. */
export function joinPath(...parts: string[]): string {
  const kept = parts.filter((p) => p !== '' && p !== undefined && p !== null)
  if (!kept.length) return ''
  const sep = sepFor(kept[0])
  let out = kept[0]
  for (const part of kept.slice(1)) {
    const normalized = sep === '\\' ? part.replace(/\//g, '\\') : part.replace(/\\/g, '/')
    const trimmed = normalized.replace(sep === '\\' ? /^\\+/ : /^\//, '').replace(sep === '\\' ? /\\+$/ : /\/$/, '')
    if (!trimmed) continue
    if (!out.endsWith(sep)) out += sep
    out += trimmed
  }
  return out
}

/** The path as markdown links and URLs should carry it: forward slashes only. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Resolve `.` and `..` inside a path without touching the filesystem, keeping
 * the drive letter, UNC prefix and the path's separator style.
 */
export function collapsePath(path: string): string {
  if (!path) return path
  const sep = sepFor(path)
  let prefix = ''
  let rest = path
  if (isWindowsPath(path)) {
    if (path.startsWith('\\\\')) {
      // UNC: keep \\server\share as the root.
      const withoutLead = path.slice(2)
      const bits = withoutLead.split(/[\\/]+/)
      if (bits.length >= 2) {
        prefix = `\\\\${bits[0]}\\${bits[1]}`
        rest = bits.slice(2).join(sep)
      }
    } else {
      prefix = path.slice(0, 2)
      rest = path.slice(2)
    }
  } else if (path.startsWith('/')) {
    prefix = '/'
    rest = path.slice(1)
  }
  const absolute = prefix !== ''
  const absolutePosix = prefix === '/'
  const out: string[] = []
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join(sep)
  if (absolutePosix) return joined ? `/${joined}` : '/'
  if (prefix) return joined ? `${prefix}${sep === '\\' ? '\\' : '/'}${joined}` : `${prefix}${sep === '\\' ? '\\' : ''}`
  return joined
}

/** True when `child` is `parent` or inside it. Windows compares case-insensitively. */
export function isInsidePath(parent: string, child: string, caseInsensitive = isWindowsPath(parent)): boolean {
  if (!parent) return false
  const a = collapsePath(parent)
  const b = collapsePath(child)
  const normalize = (p: string): string => (caseInsensitive ? p.replace(/[\\/]+/g, '\\').toLowerCase() : p)
  const na = normalize(a).replace(/[\\/]+$/, '')
  const nb = normalize(b).replace(/[\\/]+$/, '')
  return nb === na || nb.startsWith(`${na}\\`) || nb.startsWith(`${na}/`)
}

/**
 * A relative path from the directory `fromDir` to `target`, with forward
 * slashes so it can go into a markdown link. Returns `null` for targets outside
 * `fromDir`, which keeps absolute and cross-drive paths out of the document.
 */
export function relativePath(fromDir: string, target: string): string | null {
  if (!fromDir || !target) return null
  if (!isInsidePath(fromDir, target)) return null
  const base = collapsePath(fromDir).replace(/[\\/]+$/, '')
  const full = collapsePath(target)
  const rest = full.slice(base.length).replace(/^[\\/]+/, '')
  if (!rest) return null
  // Windows compares paths case-insensitively, so slicing at the base length is
  // only safe after confirming the prefix; `isInsidePath` did that above.
  return toPosixPath(rest)
}

/**
 * A short, human-friendly form of a path for the status bar and dialogs:
 * `~/notes/a.md` instead of `/Users/danny/notes/a.md`.
 */
export function prettyPath(path: string, home: string | null | undefined): string {
  if (!path) return ''
  if (!home) return path
  const caseInsensitive = isWindowsPath(home)
  const p = collapsePath(path)
  const h = collapsePath(home).replace(/[\\/]+$/, '')
  const matches = caseInsensitive ? p.toLowerCase() === h.toLowerCase() || p.toLowerCase().startsWith(`${h.toLowerCase()}\\`) : p === h || p.startsWith(`${h}/`)
  if (!matches) return path
  const rest = p.slice(h.length).replace(/^[\\/]+/, '')
  return rest ? `~/${toPosixPath(rest)}` : '~'
}

/** The file extension in lower case, without the dot (`''` when there is none). */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}