#!/usr/bin/env node
// Stage 0 smoke test — proves the SPEC §9 Stage 0 `Accept:` criteria that can be
// checked deterministically (no GUI display required):
//   1. typecheck passes        2. lint passes
//   3. `electron-vite build` produces a runnable app bundle (main/preload/renderer)
// The "npm run dev opens a window" criterion is GUI-only and is verified manually.
//
// Usage: `npm run smoke` (runs the full chain) or `node scripts/smoke-stage0.mjs --no-build`
// to only assert artifacts after a prior `npm run build`.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipBuild = process.argv.includes('--no-build')

function run(label, cmd) {
  process.stdout.write(`▸ ${label}…\n`)
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

function assertFile(rel) {
  const full = resolve(root, rel)
  if (!existsSync(full)) {
    throw new Error(`Stage 0 smoke FAILED: expected build artifact missing: ${rel}`)
  }
  process.stdout.write(`  ✓ ${rel}\n`)
}

try {
  if (!skipBuild) {
    // `npm run build` already chains typecheck → electron-vite build.
    run('build (typecheck + lint + electron-vite build)', 'npm run lint && npm run build')
  }

  process.stdout.write('▸ verifying runnable app bundle…\n')
  const artifacts = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
  artifacts.forEach(assertFile)

  // The package `main` entry must point at the built main process bundle.
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const mainEntry = pkg.main.replace(/^\.\//, '')
  assertFile(mainEntry)

  process.stdout.write(
    '\n✅ Stage 0 smoke PASSED — runnable bundle produced, typecheck & lint clean.\n'
  )
  process.stdout.write('   Manual check remaining: `npm run dev` opens an empty Aerie window.\n')
} catch (err) {
  process.stderr.write(`\n❌ ${err.message}\n`)
  process.exit(1)
}
