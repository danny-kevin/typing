/**
 * Turning an image or link target written in a markdown document into a URL the
 * renderer may load.
 *
 * The rules are the same on every platform, and the Windows cases (drive
 * letters, backslashes, UNC shares, spaces and non-ASCII folder names) are the
 * reason this lives in `src/shared` with unit tests instead of inline in the
 * renderer.
 *
 * Nothing remote is ever loaded: only `data:` images and files inside a folder
 * the user opened, which the main process serves through `typing-asset:`.
 */

import { collapsePath, isAbsolutePath, joinPath } from './paths'

export const ASSET_SCHEME = 'typing-asset'

/** True for a Windows drive path (`C:\x`, `C:/x`) rather than a URL scheme. */
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/

/**
 * Resolve `target` (what the document says) against `docDir` (the folder the
 * document lives in). Returns a URL to load, or `null` when the target must not
 * be loaded at all.
 */
export function resolveAssetTarget(target: string, docDir: string): string | null {
  const u = target.trim()
  if (!u) return null
  if (/^data:image\//i.test(u)) return u
  if (/^https?:/i.test(u)) return null // no remote loading, by design
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !DRIVE_LETTER.test(u) && !/^file:/i.test(u)) return null
  if (u.startsWith('#')) return null
  // A protocol-relative target (`//host/a.png`) is a remote URL in disguise.
  if (u.startsWith('//')) return null
  let abs: string
  if (/^file:\/\//i.test(u)) abs = decodeURI(u.replace(/^file:\/\//i, ''))
  else if (isAbsolutePath(u)) abs = collapsePath(u)
  else if (docDir) abs = collapsePath(joinPath(docDir, u))
  else return null
  // The whole absolute path travels inside the URL, so a drive letter, a UNC
  // share, spaces and non-ASCII names all arrive intact in the main process.
  return `${ASSET_SCHEME}://asset/${encodeURIComponent(abs)}`
}

/** Decode the path a `typing-asset:` request carries (used by the main process). */
export function pathFromAssetUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  return decodeURIComponent(url.pathname.replace(/^\/+/, ''))
}