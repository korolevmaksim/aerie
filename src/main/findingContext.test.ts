import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { findingContextHashOf, type Finding } from './findings'
import { attachFindingContextHashes, findingContextHashFromCheckout } from './findingContext'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    tool: 'eslint',
    ruleId: 'no-debugger',
    severity: 'medium',
    file: 'src/app.ts',
    line: 3,
    message: "Unexpected 'debugger' statement.",
    fingerprint: 'abc12345',
    stableId: 'aerie-finding-v1:abc',
    ...overrides
  }
}

describe('finding context hashes', () => {
  it('hashes a bounded source window from a checked-out file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-context-'))
    try {
      writeFileSync(
        join(root, 'src-app.ts'),
        ['const a = 1', 'function demo() {', '  debugger', '}', 'const b = 2'].join('\n')
      )
      const expected = findingContextHashOf({
        tool: 'eslint',
        ruleId: 'no-debugger',
        snippet: ['const a = 1', 'function demo() {', '  debugger', '}', 'const b = 2'].join('\n')
      })

      const actual = findingContextHashFromCheckout(root, finding({ file: 'src-app.ts', line: 3 }))

      expect(actual).toBe(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses paths outside the checkout and keeps existing hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-context-'))
    const outside = join(tmpdir(), `aerie-outside-${Date.now()}.ts`)
    try {
      writeFileSync(outside, 'debugger\n')
      expect(
        findingContextHashFromCheckout(root, finding({ file: resolve(outside), line: 1 }))
      ).toBeNull()

      const existing = 'aerie-context-v1:00000000000000000000000000000000'
      expect(
        attachFindingContextHashes(root, [finding({ contextHash: existing })])[0].contextHash
      ).toBe(existing)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })
})
