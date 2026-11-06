#!/usr/bin/env node
/**
 * Generates the stress corpus used by the performance check:
 * a ~100 KB everyday document and a ~1 MB stress document.
 *
 *   node test/perf/generate.mjs [output-dir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2] ?? join(here, 'generated')
mkdirSync(outDir, { recursive: true })

const paragraph = (i) =>
  [
    `Paragraph ${i}. Typing keeps the markdown source as the single source of truth, so the file you open is the file you save.`,
    `Chinese text for width and shaping: 这是一段用于性能测试的中文文字，包含标点、数字 ${i} 与英文 words。`,
    `Inline markup: **bold ${i}**, *italic*, \`code ${i}\`, a [link](https://example.com/${i}) and maths $a_${i}^2 + b^2$.`,
    ''
  ].join('\n')

function build(targetBytes) {
  const parts = ['---\ntitle: stress\nstress: true\n---\n\n# Stress document\n\n']
  let size = 0
  let section = 0
  while (size < targetBytes) {
    section++
    const block = [
      `## Section ${section}\n\n`,
      paragraph(section),
      `- list item ${section}\n- another item\n  - nested item\n\n`,
      `1. ordered ${section}\n2. second\n\n`,
      `> A quote in section ${section}.\n\n`,
      section % 5 === 0
        ? `| col a | col b |\n| --- | ---: |\n| ${section} | ${section * 2} |\n\n`
        : '',
      section % 7 === 0
        ? '```ts\nconst value = ' + section + '\nexport default value\n```\n\n'
        : '',
      section % 11 === 0 ? '$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n' : '',
      section % 13 === 0
        ? '```mermaid\nflowchart LR\n  A --> B --> C\n```\n\n'
        : '',
      `- [ ] task ${section}\n- [x] done task\n\n`
    ].join('')
    parts.push(block)
    size += block.length
  }
  return parts.join('')
}

const small = build(100 * 1024)
const big = build(1024 * 1024)
writeFileSync(join(outDir, 'everyday-100kb.md'), small)
writeFileSync(join(outDir, 'stress-1mb.md'), big)
console.log(`wrote ${outDir}/everyday-100kb.md (${(small.length / 1024).toFixed(0)} KB)`)
console.log(`wrote ${outDir}/stress-1mb.md (${(big.length / 1024).toFixed(0)} KB)`)