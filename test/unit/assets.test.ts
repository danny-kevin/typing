import { describe, it, expect } from 'vitest'
import { pathFromAssetUrl, resolveAssetTarget } from '../../src/shared/assets'

/** Decode the absolute path a produced asset URL carries. */
function pathOf(url: string | null): string | null {
  if (!url) return null
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))
}

describe('asset URLs: POSIX document folders', () => {
  it('resolves a relative image link against the document folder', () => {
    const url = resolveAssetTarget('assets/pixel.png', '/Users/danny/notes')
    expect(url).toBe('typing-asset://asset/%2FUsers%2Fdanny%2Fnotes%2Fassets%2Fpixel.png')
    expect(pathOf(url)).toBe('/Users/danny/notes/assets/pixel.png')
  })

  it('resolves an absolute path', () => {
    expect(pathOf(resolveAssetTarget('/Users/danny/b.png', '/Users/danny/notes'))).toBe('/Users/danny/b.png')
  })

  it('removes . and .. segments', () => {
    expect(pathOf(resolveAssetTarget('../shared/b.png', '/Users/danny/notes/sub'))).toBe('/Users/danny/notes/shared/b.png')
    expect(pathOf(resolveAssetTarget('./a.png', '/Users/danny/notes'))).toBe('/Users/danny/notes/a.png')
  })

  it('keeps spaces and non-ASCII folder names intact', () => {
    const url = resolveAssetTarget('assets/图片 one.png', '/Users/danny/My Notes 笔记')
    expect(pathOf(url)).toBe('/Users/danny/My Notes 笔记/assets/图片 one.png')
  })

  it('passes data: images through', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    expect(resolveAssetTarget(dataUrl, '/Users/danny/notes')).toBe(dataUrl)
  })

  it('refuses anything remote', () => {
    expect(resolveAssetTarget('https://example.com/a.png', '/Users/danny/notes')).toBe(null)
    expect(resolveAssetTarget('http://example.com/a.png', '/Users/danny/notes')).toBe(null)
    expect(resolveAssetTarget('//example.com/a.png', '/Users/danny/notes')).toBe(null)
    expect(resolveAssetTarget('#heading', '/Users/danny/notes')).toBe(null)
    expect(resolveAssetTarget('', '/Users/danny/notes')).toBe(null)
    expect(resolveAssetTarget('a.png', '')).toBe(null)
  })
})

describe('asset URLs: Windows document folders', () => {
  it('resolves a relative link next to a document on a drive', () => {
    const url = resolveAssetTarget('assets/pixel.png', 'C:\\Users\\danny\\My Notes')
    expect(pathOf(url)).toBe('C:\\Users\\danny\\My Notes\\assets\\pixel.png')
  })

  it('accepts forward and back slashes in the link', () => {
    expect(pathOf(resolveAssetTarget('assets\\pixel.png', 'C:\\Users\\danny\\notes'))).toBe(
      'C:\\Users\\danny\\notes\\assets\\pixel.png'
    )
    expect(pathOf(resolveAssetTarget('assets/pixel.png', 'C:/Users/danny/notes'))).toBe(
      'C:\\Users\\danny\\notes\\assets\\pixel.png'
    )
  })

  it('resolves an absolute Windows path from the document', () => {
    expect(pathOf(resolveAssetTarget('D:\\pictures\\a b.png', 'C:\\Users\\danny\\notes'))).toBe('D:\\pictures\\a b.png')
  })

  it('keeps UNC paths together', () => {
    expect(pathOf(resolveAssetTarget('\\\\server\\share\\pics\\a.png', 'C:\\Users\\danny\\notes'))).toBe(
      '\\\\server\\share\\pics\\a.png'
    )
  })

  it('does not mistake a drive letter for a URL scheme', () => {
    // `c:` looks like a scheme to a naive parser; it is a drive here.
    expect(pathOf(resolveAssetTarget('C:\\notes\\a.png', ''))).toBe('C:\\notes\\a.png')
    // …while a real scheme is still refused.
    expect(resolveAssetTarget('javascript:alert(1)', 'C:\\notes')).toBe(null)
    expect(resolveAssetTarget('ms-word:ofe|u|C:\\a.docx', 'C:\\notes')).toBe(null)
  })

  it('walks up out of a subfolder', () => {
    expect(pathOf(resolveAssetTarget('..\\img\\a.png', 'C:\\Users\\danny\\notes\\sub'))).toBe(
      'C:\\Users\\danny\\notes\\img\\a.png'
    )
  })

  it('handles CJK folder and file names', () => {
    const url = resolveAssetTarget('assets/图 1.png', 'C:\\用户\\文档\\笔记')
    expect(pathOf(url)).toBe('C:\\用户\\文档\\笔记\\assets\\图 1.png')
    expect(new URL(url!).protocol).toBe('typing-asset:')
  })
})

describe('reading the path back out of an asset URL', () => {
  it('round-trips POSIX paths', () => {
    const url = resolveAssetTarget('assets/a.png', '/Users/danny/notes')!
    expect(pathFromAssetUrl(url)).toBe('/Users/danny/notes/assets/a.png')
  })

  it('round-trips Windows paths', () => {
    const url = resolveAssetTarget('assets/a b.png', 'C:\\Users\\danny\\My Notes')!
    expect(pathFromAssetUrl(url)).toBe('C:\\Users\\danny\\My Notes\\assets\\a b.png')
  })
})