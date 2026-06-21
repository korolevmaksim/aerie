import { useEffect, useState } from 'react'
import type { OpenTarget, SystemInfo } from '@shared/types'
import PresetsSettings from './PresetsSettings'
import PromptsSettings from './PromptsSettings'

function PathRow({
  label,
  value,
  open
}: {
  label: string
  value: string
  open?: OpenTarget
}): React.JSX.Element {
  return (
    <div className="mapping__row">
      <span className="mapping__key">{label}</span>
      <code className="mapping__val">{value}</code>
      {open && (
        <button className="btn btn--ghost" onClick={() => window.aerie.system.openPath(open)}>
          Open
        </button>
      )}
    </div>
  )
}

function SettingsPanel(): React.JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.system.info()
      if (!cancelled && res.ok) setInfo(res.value)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="panel">
      <h2 className="panel__title">Settings</h2>
      {!info ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="mapping">
          <PathRow label="Version" value={`Aerie ${info.version}`} />
          <PathRow label="Data folder" value={info.userDataPath} open="userData" />
          <PathRow label="Database" value={info.dbPath} />
          <PathRow label="Agents config" value={info.agentsPath} open="agents" />
          <PathRow label="Logs" value={info.logsPath} open="logs" />
          <p className="muted">
            Add or edit local agents by editing <code>agents.json</code> — no code change needed.
            Tokens are encrypted at rest and never written to logs.
          </p>
        </div>
      )}
      <PromptsSettings />
      <PresetsSettings />
    </section>
  )
}

export default SettingsPanel
