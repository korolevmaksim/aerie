#!/usr/bin/env node
// Smoke: proves a real quality-tool catalog entry (M3) works end-to-end against the
// ACTUAL tool. Runs ESLint with the exact TOOL_CATALOG args (`-f json .`) on a temp
// project containing a lint violation, and asserts:
//   - the tool exits with a code in successExitCodes [0,1] (1 = "found issues" =
//     success-with-findings, which runStatusForExit records as 'done', not 'error');
//   - stdout is machine-readable JSON carrying the expected finding.
// ESLint is a devDependency, so this runs deterministically in CI/dev without
// installing anything. Run: `npm run smoke:tooling`

const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const SUCCESS_EXIT_CODES = [0, 1] // mirrors TOOL_CATALOG eslint entry
const eslintBin = join(__dirname, '..', 'node_modules', '.bin', 'eslint')
const dir = mkdtempSync(join(tmpdir(), 'aerie-tooling-'))

try {
  // Minimal ESLint v9 flat config with a single core rule (no plugins needed).
  writeFileSync(
    join(dir, 'eslint.config.cjs'),
    "module.exports = [{ rules: { 'no-debugger': 'error' } }]\n"
  )
  writeFileSync(
    join(dir, 'bad.js'),
    'function f() {\n  debugger\n  return 1\n}\nmodule.exports = f\n'
  )

  // The exact catalog invocation, run in the worktree (cwd) like Aerie's runner does.
  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync(eslintBin, ['-f', 'json', '.'], { cwd: dir, encoding: 'utf8' })
  } catch (e) {
    status = typeof e.status === 'number' ? e.status : -1
    stdout = (e.stdout || '').toString()
  }

  assert(
    SUCCESS_EXIT_CODES.includes(status),
    `eslint exit ${status} not in successExitCodes ${JSON.stringify(SUCCESS_EXIT_CODES)}`
  )
  assert(status === 1, `expected exit 1 (findings present), got ${status}`)

  const results = JSON.parse(stdout)
  const messages = results.flatMap((r) => r.messages || [])
  assert(
    messages.some((m) => m.ruleId === 'no-debugger'),
    'expected a no-debugger finding in the machine-readable JSON output'
  )

  process.stdout.write(
    '\nTOOLING_OK — real ESLint ran with the catalog args, exited 1 (findings) which ' +
      'successExitCodes treats as done, and emitted parseable JSON findings.\n'
  )
  process.exitCode = 0
} catch (err) {
  process.stderr.write(`\nTOOLING_FAIL — ${err.message}\n`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
