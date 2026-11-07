import { describe, it, expect } from 'vitest'
import {
  baseName,
  collapsePath,
  dirName,
  extensionOf,
  isAbsolutePath,
  isInsidePath,
  isWindowsPath,
  joinPath,
  prettyPath,
  relativePath,
  sepFor,
  toPosixPath
} from '../../src/shared/paths'

describe('path helpers: POSIX', () => {
  it('splits names and directories', () => {
    expect(baseName('/Users/danny/notes/today.md')).toBe('today.md')
    expect(dirName('/Users/danny/notes/today.md')).toBe('/Users/danny/notes')
    expect(dirName('/today.md')).toBe('/')
    expect(baseName('today.md')).toBe('today.md')
    expect(dirName('today.md')).toBe('')
  })

  it('joins and collapses', () => {
    expect(joinPath('/Users/danny', 'notes', 'a.md')).toBe('/Users/danny/notes/a.md')
    expect(joinPath('/Users/danny/', '/notes/', 'a.md')).toBe('/Users/danny/notes/a.md')
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(collapsePath('/Users/danny/notes/../today.md')).toBe('/Users/danny/today.md')
    expect(collapsePath('/Users//danny/./a.md')).toBe('/Users/danny/a.md')
    expect(collapsePath('/..')).toBe('/')
  })

  it('recognises absolute paths and the separator style', () => {
    expect(isAbsolutePath('/Users/danny')).toBe(true)
    expect(isAbsolutePath('notes/a.md')).toBe(false)
    expect(isWindowsPath('/Users/danny')).toBe(false)
    expect(sepFor('/Users/danny')).toBe('/')
  })
})

describe('path helpers: Windows', () => {
  it('splits drive-letter paths', () => {
    expect(isWindowsPath('C:\\Users\\danny\\notes\\today.md')).toBe(true)
    expect(isWindowsPath('C:/Users/danny/notes/today.md')).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\a.md')).toBe(true)
    expect(isAbsolutePath('C:\\Users')).toBe(true)
    expect(sepFor('C:\\Users')).toBe('\\')
    expect(baseName('C:\\Users\\danny\\today.md')).toBe('today.md')
    expect(dirName('C:\\Users\\danny\\today.md')).toBe('C:\\Users\\danny')
    expect(dirName('C:\\today.md')).toBe('C:\\')
    expect(baseName('C:/Users/danny/today.md')).toBe('today.md')
  })

  it('joins mixed separators into the style of the first part', () => {
    expect(joinPath('C:\\Users\\danny', 'notes\\a.md')).toBe('C:\\Users\\danny\\notes\\a.md')
    expect(joinPath('C:\\Users\\danny', 'notes/a.md')).toBe('C:\\Users\\danny\\notes\\a.md')
    expect(joinPath('C:\\', 'notes', 'a.md')).toBe('C:\\notes\\a.md')
  })

  it('collapses dots and dots-dots without touching the drive', () => {
    expect(collapsePath('C:\\Users\\danny\\notes\\..\\today.md')).toBe('C:\\Users\\danny\\today.md')
    expect(collapsePath('C:/Users/danny/../danny/a.md')).toBe('C:\\Users\\danny\\a.md')
    expect(collapsePath('\\\\server\\share\\notes\\..\\a.md')).toBe('\\\\server\\share\\a.md')
  })

  it('converts to forward slashes for markdown links', () => {
    expect(toPosixPath('C:\\Users\\danny\\assets\\pixel.png')).toBe('C:/Users/danny/assets/pixel.png')
  })

  it('accepts a target inside the root regardless of case', () => {
    expect(isInsidePath('C:\\Users\\danny\\notes', 'C:\\Users\\Danny\\Notes\\a.md')).toBe(true)
    expect(isInsidePath('C:\\Users\\danny\\notes', 'C:\\Users\\danny\\notes')).toBe(true)
    expect(isInsidePath('C:\\Users\\danny\\notes', 'C:\\Users\\danny\\other\\a.md')).toBe(false)
    // Prefix confusion must not pass: `notes2` is not inside `notes`.
    expect(isInsidePath('C:\\Users\\danny\\notes', 'C:\\Users\\danny\\notes2\\a.md')).toBe(false)
    expect(isInsidePath('/Users/danny/notes', '/Users/danny/notes/a.md')).toBe(true)
    expect(isInsidePath('/Users/danny/notes', '/Users/danny/notesx/a.md')).toBe(false)
    expect(isInsidePath('/Users/danny/notes', '/Users/danny/notes/../secret.md')).toBe(false)
  })

  it('builds a forward-slash relative path for images next to the document', () => {
    expect(relativePath('C:\\Users\\danny\\notes', 'C:\\Users\\danny\\notes\\assets\\pixel.png')).toBe('assets/pixel.png')
    expect(relativePath('C:\\Users\\danny\\notes', 'C:\\Users\\danny\\other\\pixel.png')).toBe(null)
    expect(relativePath('/Users/danny/notes', '/Users/danny/notes/assets/pixel.png')).toBe('assets/pixel.png')
    expect(relativePath('/Users/danny/notes', '/Users/danny/notes')).toBe(null)
    expect(relativePath('/Users/danny/notes', '/Volumes/ext/pixel.png')).toBe(null)
  })

  it('shortens the home directory for display', () => {
    expect(prettyPath('/Users/danny/notes/a.md', '/Users/danny')).toBe('~/notes/a.md')
    expect(prettyPath('/Users/danny', '/Users/danny')).toBe('~')
    expect(prettyPath('/Volumes/ext/a.md', '/Users/danny')).toBe('/Volumes/ext/a.md')
    expect(prettyPath('C:\\Users\\danny\\notes\\a.md', 'C:\\Users\\danny')).toBe('~/notes/a.md')
    expect(prettyPath('C:\\Users\\Danny\\notes\\a.md', 'c:\\users\\danny')).toBe('~/notes/a.md')
    expect(prettyPath('D:\\work\\a.md', 'C:\\Users\\danny')).toBe('D:\\work\\a.md')
  })

  it('reads extensions', () => {
    expect(extensionOf('C:\\notes\\a.MD')).toBe('md')
    expect(extensionOf('/notes/archive.tar.gz')).toBe('gz')
    expect(extensionOf('C:\\notes\\no-extension')).toBe('')
    expect(extensionOf('/notes/.hidden')).toBe('')
  })
})