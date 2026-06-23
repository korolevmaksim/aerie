import { describe, expect, it } from 'vitest'
import { runOutputToMarkdown, runRefLabel } from './runConsole'

describe('runRefLabel', () => {
  it('labels a PR / commit / working-tree / project target', () => {
    expect(runRefLabel({ refType: 'pr', refId: '42', headSha: 'abcdef1234' })).toBe('PR #42')
    expect(runRefLabel({ refType: 'commit', refId: 'main', headSha: 'abcdef1234567' })).toBe(
      'commit abcdef12'
    )
    expect(runRefLabel({ refType: 'working-tree', refId: 'wt', headSha: 'abcdef1234567' })).toBe(
      'working tree abcdef12'
    )
    expect(runRefLabel({ refType: 'project', refId: 'main', headSha: 'abcdef1234567' })).toBe(
      'project main'
    )
  })
})

describe('runOutputToMarkdown', () => {
  const meta = { agentId: 'codex', refLabel: 'PR #42', status: 'done' }

  it('wraps the body with a header (target + agent + status)', () => {
    const md = runOutputToMarkdown(meta, 'The review **body**.')
    expect(md).toContain('### Aerie review — PR #42')
    expect(md).toContain('agent `codex`')
    expect(md).toContain('done')
    expect(md).toContain('The review **body**.')
  })

  it('passes the body through verbatim (trimmed) and adds nothing token/path-like', () => {
    const body = '# Findings\n- bug at line 3\n'
    const md = runOutputToMarkdown(meta, body)
    expect(md).toContain('# Findings')
    expect(md).toContain('- bug at line 3')
    // The wrapper contributes only the known meta fields — no secret/path injected.
    expect(md).not.toMatch(/ghp_|token|\/Users\/|Application Support/)
  })

  it('trims surrounding whitespace in the body but preserves internal newlines', () => {
    const md = runOutputToMarkdown(meta, '\n\n  line1\nline2  \n\n')
    expect(md).toContain('line1\nline2')
    expect(md.endsWith('\n')).toBe(true)
    expect(md).not.toContain('\n\n\nline1')
  })
})
