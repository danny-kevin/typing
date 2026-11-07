export interface DiffChunk { type: 'equal' | 'add' | 'remove'; text: string }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Line LCS on the changed middle only. Large unrelated middles use an exact,
 * non-minimal replacement instead of quadratic time/memory. No dependencies. */
export function lineDiff(before: string, after: string): { chunks: DiffChunk[]; coarse: boolean } {
  if (before === after) return { chunks: before ? [{ type: 'equal', text: before }] : [], coarse: false }
  const a = lines(before), b = lines(after)
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix)
  const chunks: DiffChunk[] = []
  const add = (type: DiffChunk['type'], text: string): void => {
    if (!text) return
    const last = chunks.at(-1)
    if (last?.type === type) last.text += text
    else chunks.push({ type, text })
  }
  add('equal', a.slice(0, prefix).join(''))
  const width = right.length + 1
  const coarse = (left.length + 1) * width > 250_000
  if (coarse || !left.length || !right.length) {
    add('remove', left.join('')); add('add', right.join(''))
  } else {
    const table = new Uint32Array((left.length + 1) * width)
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { add('equal', left[i++]); j++ }
      else if (j === right.length || (i < left.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) add('remove', left[i++])
      else add('add', right[j++])
    }
  }
  add('equal', a.slice(a.length - suffix).join(''))
  return { chunks, coarse }
}
