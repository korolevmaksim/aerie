import { useCallback, useEffect, useState } from 'react'
import type { AccountSummary, RateLimitInfo } from '@shared/types'
import { useConfirm } from '../lib/useConfirm'

function RateLimit({
  rate,
  loading
}: {
  rate?: RateLimitInfo
  loading?: boolean
}): React.JSX.Element {
  if (!rate) {
    return loading ? (
      <span className="rate rate--loading">rate: …</span>
    ) : (
      <span className="rate rate--unknown">rate: —</span>
    )
  }
  const pct = rate.limit > 0 ? Math.round((rate.remaining / rate.limit) * 100) : 0
  const tone = pct < 10 ? 'low' : pct < 35 ? 'mid' : 'ok'
  return (
    <span className={`rate rate--${tone}`}>
      {rate.remaining.toLocaleString()} / {rate.limit.toLocaleString()} req
    </span>
  )
}

function AccountsPanel({
  onAccountsChanged
}: {
  onAccountsChanged?: () => void
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [reauthId, setReauthId] = useState<number | null>(null)
  const [reauthToken, setReauthToken] = useState('')
  const [ratesLoading, setRatesLoading] = useState(true)
  const confirm = useConfirm()

  // Load accounts on mount, then auto-load each account's live rate limit. State
  // is set only after the async call resolves (never synchronously in the effect
  // body), with a cancel guard for unmount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.aerie.accounts.list()
        if (cancelled) return
        setAccounts(list)

        // `accounts.list()` returns no rate limit (it's only known after a live
        // read), so the panel would otherwise open showing "rate: —". Auto-load
        // each one via the quota-free `rateLimit` path (no identity check, ~0
        // core quota) in parallel: merge each result as it arrives, keep the
        // action buttons enabled (no pendingId), and stay silent on a single
        // account's failure so one bad token can't blank the panel — its
        // Refresh button stays available to surface the real error.
        await Promise.all(
          list.map(async (account) => {
            try {
              const result = await window.aerie.accounts.rateLimit(account.id)
              if (cancelled || !result.ok) return
              setAccounts((prev) => prev.map((a) => (a.id === account.id ? result.value : a)))
            } catch {
              // Leave this account showing "rate: —"; manual Refresh remains.
            }
          })
        )
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setRatesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onAdd = useCallback(
    async (event: React.FormEvent): Promise<void> => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      try {
        const result = await window.aerie.accounts.add({ label, token })
        if (!result.ok) {
          setError(result.error)
          return
        }
        // Clear the token from renderer state as soon as it is stored.
        setLabel('')
        setToken('')
        setAccounts((prev) => [...prev, result.value])
        onAccountsChanged?.()
      } finally {
        setBusy(false)
      }
    },
    [label, token, onAccountsChanged]
  )

  const onRefresh = useCallback(async (id: number): Promise<void> => {
    setPendingId(id)
    setError(null)
    try {
      const result = await window.aerie.accounts.refresh(id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setAccounts((prev) => prev.map((a) => (a.id === id ? result.value : a)))
    } finally {
      setPendingId(null)
    }
  }, [])

  const onRemove = useCallback(
    async (account: AccountSummary): Promise<void> => {
      const ok = await confirm({
        title: 'Remove account',
        message: `Remove account "${account.login}"? Its stored token will be deleted.`,
        confirmLabel: 'Remove',
        danger: true
      })
      if (!ok) return
      setPendingId(account.id)
      setError(null)
      try {
        const result = await window.aerie.accounts.remove(account.id)
        if (!result.ok) {
          setError(result.error)
          return
        }
        setAccounts((prev) => prev.filter((a) => a.id !== account.id))
        onAccountsChanged?.()
      } finally {
        setPendingId(null)
      }
    },
    [onAccountsChanged, confirm]
  )

  const onSaveReauth = useCallback(
    async (id: number): Promise<void> => {
      setPendingId(id)
      setError(null)
      try {
        const result = await window.aerie.accounts.updateToken(id, reauthToken)
        if (!result.ok) {
          setError(result.error)
          return
        }
        setAccounts((prev) => prev.map((a) => (a.id === id ? result.value : a)))
        setReauthId(null)
        setReauthToken('')
      } finally {
        setPendingId(null)
      }
    },
    [reauthToken]
  )

  return (
    <section className="panel">
      <h2 className="panel__title">Accounts</h2>

      <form className="add-form" onSubmit={onAdd}>
        <input
          className="field"
          type="text"
          placeholder="Label (e.g. work)"
          aria-label="Account label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
          autoComplete="off"
        />
        <input
          className="field field--grow"
          type="password"
          placeholder="GitHub Personal Access Token"
          aria-label="GitHub Personal Access Token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={busy}
          autoComplete="off"
        />
        <button className="btn btn--primary" type="submit" disabled={busy || !label || !token}>
          {busy ? 'Validating…' : 'Add account'}
        </button>
      </form>

      {error && <p className="alert">{error}</p>}

      {accounts.length === 0 ? (
        <div className="empty onboarding">
          <p>
            Welcome to Aerie. Add a GitHub <strong>Personal Access Token</strong> above to get
            started — a classic token with the <code>repo</code> scope (and <code>read:org</code>{' '}
            for org repos) lets Aerie browse your repos, commits, and PRs.
          </p>
          <p className="hint">
            Create one at{' '}
            <a
              className="link"
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer"
            >
              github.com/settings/tokens
            </a>
            . Tokens are encrypted at rest and never leave this machine except to call GitHub.
          </p>
        </div>
      ) : (
        <ul className="accounts">
          {accounts.map((account) => (
            <li key={account.id} className="account">
              <div className="account__main">
                <span className="account__login">{account.login}</span>
                <span className="account__label">{account.label}</span>
                <span className={`badge badge--${account.kind}`}>{account.kind}</span>
              </div>
              <div className="account__meta">
                <RateLimit rate={account.rateLimit} loading={ratesLoading} />
                <button
                  className="btn btn--ghost"
                  onClick={() => onRefresh(account.id)}
                  disabled={pendingId === account.id}
                >
                  Refresh
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setReauthId(reauthId === account.id ? null : account.id)
                    setReauthToken('')
                  }}
                  disabled={pendingId === account.id}
                >
                  Re-auth
                </button>
                <button
                  className="btn btn--danger"
                  onClick={() => onRemove(account)}
                  disabled={pendingId === account.id}
                >
                  Remove
                </button>
              </div>
              {reauthId === account.id && (
                <form
                  className="reauth"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void onSaveReauth(account.id)
                  }}
                >
                  <input
                    className="field field--grow"
                    type="password"
                    placeholder={`New token for ${account.login}`}
                    aria-label={`New token for ${account.login}`}
                    value={reauthToken}
                    onChange={(e) => setReauthToken(e.target.value)}
                    autoComplete="off"
                    disabled={pendingId === account.id}
                  />
                  <button
                    className="btn btn--primary"
                    type="submit"
                    disabled={pendingId === account.id || !reauthToken}
                  >
                    Save
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default AccountsPanel
