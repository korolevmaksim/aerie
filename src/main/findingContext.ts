import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { findingContextHashOf, type Finding } from './findings'

const MAX_CONTEXT_FILE_BYTES = 1_000_000
const CONTEXT_RADIUS_LINES = 2

function safeFindingPath(repoRoot: string, file: string): string | null {
  const root = resolve(repoRoot)
  const normalized = file.trim().replace(/\\/g, '/')
  if (!normalized) return null
  const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(root, normalized)
  const rel = relative(root, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return candidate
}

function snippetAroundLine(text: string, line: number | null): string | null {
  if (line == null || !Number.isInteger(line) || line <= 0) return null
  if (text.includes('\u0000')) return null
  const lines = text.split(/\r?\n/)
  const index = line - 1
  if (index < 0 || index >= lines.length) return null
  const start = Math.max(0, index - CONTEXT_RADIUS_LINES)
  const end = Math.min(lines.length, index + CONTEXT_RADIUS_LINES + 1)
  return lines.slice(start, end).join('\n')
}

export function findingContextHashFromCheckout(repoRoot: string, finding: Finding): string | null {
  const path = safeFindingPath(repoRoot, finding.file)
  if (!path || !existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) return null
    const snippet = snippetAroundLine(readFileSync(path, 'utf8'), finding.line)
    if (!snippet) return null
    return findingContextHashOf({
      tool: finding.tool,
      ruleId: finding.ruleId,
      snippet
    })
  } catch {
    return null
  }
}

export function attachFindingContextHashes(repoRoot: string, findings: Finding[]): Finding[] {
  if (findings.length === 0) return findings
  return findings.map((finding) => ({
    ...finding,
    contextHash: finding.contextHash ?? findingContextHashFromCheckout(repoRoot, finding) ?? null
  }))
}
