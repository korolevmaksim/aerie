import { useEffect, useState } from 'react'
import type { OpenTarget, SettingKey, SystemInfo } from '@shared/types'
import PresetsSettings from './PresetsSettings'
import PromptsSettings from './PromptsSettings'

/** A labelled boolean toggle backed by a main-process UI setting. */
function SettingToggle({
  settingKey,
  label,
  hint
}: {
  settingKey: SettingKey
  label: string
  hint: string
}): React.JSX.Element {
  const [value, setValue] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.settings.get(settingKey)
      if (!cancelled && res.ok) setValue(res.value)
    })()
    return () => {
      cancelled = true
    }
  }, [settingKey])

  const onToggle = async (next: boolean): Promise<void> => {
    setValue(next) // optimistic
    const res = await window.aerie.settings.set(settingKey, next)
    if (!res.ok) setValue(!next) // revert on failure
  }

  return (
    <div className="mapping__row">
      <label className="mapping__toggle">
        <input
          type="checkbox"
          checked={value ?? false}
          disabled={value === null}
          onChange={(e) => void onToggle(e.target.checked)}
        />
        {label}
      </label>
      <span className="muted">{hint}</span>
    </div>
  )
}

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

      <h3 className="subhead">Background &amp; notifications</h3>
      <div className="mapping">
        <SettingToggle
          settingKey="ui.closeToTray"
          label="Keep running in the menu bar"
          hint="Closing the window hides Aerie to the tray instead of quitting, so reviews keep running."
        />
        <SettingToggle
          settingKey="ui.notifyOnFinish"
          label="Notify when a review finishes"
          hint="Desktop notification with the repo, commit, and result when an agent run completes."
        />
      </div>

      <h3 className="subhead">Reviews</h3>
      <div className="mapping">
        <SettingToggle
          settingKey="ui.groundReviews"
          label="Ground reviews with local tools"
          hint="Before an AI review, run your installed linters/scanners on the change and give the agent their findings to verify. Turn off when reviewing untrusted repos — it executes the repo's own tool configs."
        />
      </div>

      <PromptsSettings />
      <PresetsSettings />
    </section>
  )
}

export default SettingsPanel
