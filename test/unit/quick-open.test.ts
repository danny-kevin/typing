import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../../src/shared/quick-open'

describe('quick-open filename ranking', () => {
  it('ranks exact case-insensitive filename above prefix above fuzzy, including nested paths', () => {
    const files = ['notesX.md', 'notes.md.backup', 'notes/archive/NOTES.md']
    expect(files.sort((a, b) => fuzzyScore('notes.md', b) - fuzzyScore('notes.md', a))).toEqual([
      'notes/archive/NOTES.md', 'notes.md.backup', 'notesX.md'
    ])
  })
  it('puts document-1.md before document-11.md', () => {
    expect(fuzzyScore('document-1.md', 'document-1.md')).toBeGreaterThan(fuzzyScore('document-1.md', 'document-11.md'))
  })
  it('excludes nonmatches but keeps path subsequences and empty queries', () => {
    expect(fuzzyScore('missing', 'notes.md')).toBe(-1)
    expect(fuzzyScore('ar/n', 'archive/notes.md')).toBeGreaterThanOrEqual(0)
    expect(fuzzyScore('', 'notes.md')).toBe(1)
  })
})
