#!/usr/bin/env bun
/**
 * Packs the lib, installs the tarball in an empty project and imports it with Node.
 *
 * Catches what the tests don't: relative import without `.js`, which Node doesn't
 * resolve, and a runtime dependency missing from `dependencies`, which the dev install
 * hides. Needs `dist/` built.
 *
 * Usage: `bun scripts/testPackage.ts`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const dir = mkdtempSync(path.join(tmpdir(), 'lambda-jobs-pack-'))

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

const expectedExports = ['createJobScheduler', 'jobWrapper', 'jobWatchdog', 'formatAlert']

try {
  const tarball = path.join(dir, `${pkg.name}-${pkg.version}.tgz`)
  run('bun', ['pm', 'pack', '--quiet', '--destination', dir], root)

  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'pack-check', private: true, type: 'module' })
  )

  const peers = Object.entries(pkg.peerDependencies as Record<string, string>).map(
    ([name, range]) => `${name}@${range}`
  )
  run('bun', ['add', tarball, ...peers], dir)

  const exports = run(
    'node',
    [
      '--input-type=module',
      '-e',
      `const lib = await import('${pkg.name}'); console.log(Object.keys(lib).join(','))`,
    ],
    dir
  )
    .trim()
    .split(',')

  const missing = expectedExports.filter((name) => !exports.includes(name))
  if (missing.length > 0) throw new Error(`missing exports: ${missing.join(', ')}`)

  console.log(`${pkg.name}@${pkg.version} imported in Node ${run('node', ['--version'], dir).trim()}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
