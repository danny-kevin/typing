import { baseName } from './paths'

/** Case-insensitive subsequence score for local quick-open results. */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const name = baseName(t)
  if (name === q) return 3
  if (name.startsWith(q)) return 2
  let qi = 0
  let score = 0
  let streak = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++
      streak++
      score += 1 + streak * 2
      if (i === 0 || t[i - 1] === '/' || t[i - 1] === '-' || t[i - 1] === '_') score += 6
    } else {
      streak = 0
    }
  }
  if (qi < q.length) return -1
  const fuzzy = Math.max(0, score - t.length * 0.05)
  return fuzzy / (1 + fuzzy)
}
