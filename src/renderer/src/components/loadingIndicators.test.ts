import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MissionControlPanel from './MissionControlPanel'
import AccountsPanel from './AccountsPanel'
import RunPanel from './RunPanel'
import { ConfirmContext } from '../lib/useConfirm'

describe('first-load loading indicators', () => {
  it('renders cockpit loading placeholders instead of ready metrics before account data loads', () => {
    const html = renderToStaticMarkup(
      React.createElement(MissionControlPanel, {
        accountId: 1,
        onNavigate: () => {},
        onOpenRepo: () => {},
        onOpenRun: () => {}
      })
    )

    expect(html).toContain('Loading cockpit metrics…')
    expect(html).toContain('Loading agent readiness…')
    expect(html).toContain('Loading automation status…')
    expect(html).not.toContain('>0</span><span class="cockpit-metric__label">running')
  })

  it('does not flash onboarding before accounts finish loading', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ConfirmContext.Provider,
        { value: async () => true },
        React.createElement(AccountsPanel)
      )
    )

    expect(html).toContain('Loading accounts…')
    expect(html).not.toContain('Welcome to Aerie.')
  })

  it('shows review option preparation before agents and prompts load', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunPanel, {
        accountId: 1,
        repoId: 1,
        sha: 'abcdef1234567890',
        refType: 'commit',
        refId: 'abcdef1234567890',
        authorLogin: 'octocat'
      })
    )

    expect(html).toContain('Preparing review options…')
    expect(html).not.toContain('0/0 agents ready')
  })
})
