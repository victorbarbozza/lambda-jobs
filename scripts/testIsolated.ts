#!/usr/bin/env bun
/**
 * Runs each test file in its own process.
 *
 * Bun's `mock.module` is global and lives until the process ends: a file that replaces a
 * module breaks the double of another file that runs later, and the suite passes or fails
 * depending on the order the files were discovered. Isolating by process is what makes
 * the result deterministic.
 *
 * Usage: `bun scripts/testIsolated.ts __tests__`.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const dirs = roots.length > 0 ? roots : ['.']

const collect = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const files = dirs.flatMap(collect).sort()
if (files.length === 0) {
  console.log('no test files found')
  process.exit(0)
}

const failed: string[] = []
for (const file of files) {
  const { status } = spawnSync('bun', ['test', `./${file}`], { stdio: 'inherit' })
  if (status !== 0) failed.push(file)
}

console.log(`\n${files.length - failed.length}/${files.length} files passed`)
for (const f of failed) console.log(`  failed: ${f}`)
process.exit(failed.length === 0 ? 0 : 1)
