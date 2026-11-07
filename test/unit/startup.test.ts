import { describe, it, expect } from 'vitest'
import { fileFromArgv, filesFromArgv } from '../../src/main/startup'

/** Pretend exactly these paths exist, whatever platform the test runs on. */
function existsOnly(paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return (p) => set.has(p)
}

describe('opening a file passed on the command line', () => {
  it('collects every existing argument once in launch order', () => {
    expect(filesFromArgv(['typing', '/a.md', '/missing', '/b.md', '/a.md'], { exists: existsOnly(['/a.md', '/b.md']) })).toEqual(['/a.md', '/b.md'])
  })
  it('reads a macOS argv launch', () => {
    const argv = ['/Applications/Typing.app/Contents/MacOS/Typing', '/Users/danny/notes/today.md']
    expect(fileFromArgv(argv, { exists: existsOnly(['/Users/danny/notes/today.md']) })).toBe('/Users/danny/notes/today.md')
  })

  it('reads a Windows argv launch with a drive letter and backslashes', () => {
    const argv = ['C:\\Program Files\\Typing\\Typing.exe', 'C:\\Users\\danny\\My Notes\\today.md']
    const exists = existsOnly(['C:\\Users\\danny\\My Notes\\today.md'])
    expect(fileFromArgv(argv, { exists })).toBe('C:\\Users\\danny\\My Notes\\today.md')
  })

  it('accepts a quoted path and forward slashes', () => {
    const argv = ['C:\\Typing\\Typing.exe', '"C:/Users/danny/notes/a.md"']
    const exists = existsOnly(['C:\\Users\\danny\\notes\\a.md'])
    expect(fileFromArgv(argv, { exists })).toBe('C:\\Users\\danny\\notes\\a.md')
  })

  it('accepts a UNC path', () => {
    const argv = ['C:\\Typing\\Typing.exe', '\\\\server\\share\\notes\\a.md']
    const exists = existsOnly(['\\\\server\\share\\notes\\a.md'])
    expect(fileFromArgv(argv, { exists })).toBe('\\\\server\\share\\notes\\a.md')
  })

  it('resolves a relative path against the working directory', () => {
    const argv = ['C:\\Typing\\Typing.exe', 'notes\\a.md']
    const exists = existsOnly(['C:\\work\\notes\\a.md'])
    expect(fileFromArgv(argv, { cwd: 'C:\\work', exists })).toBe('C:\\work\\notes\\a.md')
  })

  it('ignores Chromium and Electron switches', () => {
    const argv = [
      'C:\\Typing\\Typing.exe',
      '--user-data-dir=C:\\Temp\\profile',
      '--no-sandbox',
      '--allow-file-access-from-files',
      'C:\\Users\\danny\\a.md'
    ]
    const exists = existsOnly(['C:\\Users\\danny\\a.md', 'C:\\Temp\\profile'])
    expect(fileFromArgv(argv, { exists })).toBe('C:\\Users\\danny\\a.md')
  })

  it('skips the executable when a launcher forwards the whole command line', () => {
    const argv = ['C:\\Typing\\Typing.exe', 'C:\\Typing\\Typing.exe', 'C:\\Users\\danny\\a.md']
    const exists = existsOnly(['C:\\Typing\\Typing.exe', 'C:\\Users\\danny\\a.md'])
    expect(fileFromArgv(argv, { exists })).toBe('C:\\Users\\danny\\a.md')
  })

  it('takes the last existing argument, which is the file the shell appended', () => {
    const argv = ['typing', '/Users/danny/a.md', '/Users/danny/b.md']
    const exists = existsOnly(['/Users/danny/a.md', '/Users/danny/b.md'])
    expect(fileFromArgv(argv, { exists })).toBe('/Users/danny/b.md')
  })

  it('ignores arguments that do not exist', () => {
    const argv = ['typing', '/Users/danny/missing.md']
    expect(fileFromArgv(argv, { exists: () => false })).toBe(null)
  })

  it('returns null when nothing was passed', () => {
    expect(fileFromArgv(['typing'], { exists: () => true })).toBe(null)
    expect(fileFromArgv([], { exists: () => true })).toBe(null)
  })

  it('does not throw on an argument that cannot be probed', () => {
    const argv = ['typing', '/Users/danny/a.md']
    expect(
      fileFromArgv(argv, {
        exists: () => {
          throw new Error('EPERM')
        }
      })
    ).toBe(null)
  })

  it('opens a folder passed on the command line', () => {
    const argv = ['typing', '/Users/danny/notes']
    expect(fileFromArgv(argv, { exists: existsOnly(['/Users/danny/notes']) })).toBe('/Users/danny/notes')
  })
})