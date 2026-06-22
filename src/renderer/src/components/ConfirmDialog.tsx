import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from '../lib/useConfirm'

/**
 * App-wide confirm dialog (ROADMAP M11). Renders one accessible, focus-trapped
 * `role="alertdialog"` (matching the app's modal styling) and provides the async
 * `confirm(options) => Promise<boolean>` consumed via `useConfirm()` (see `lib/useConfirm`).
 * Replaces blocking, unthemed, inconsistently announced `window.confirm` calls.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  // The pending promise's resolver is held in a ref (not state) so `close` stays referentially
  // stable and never resolves inside a setState updater (StrictMode-safe).
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
        setOptions(opts)
      }),
    []
  )

  const close = useCallback((ok: boolean): void => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setOptions(null)
  }, [])

  // If the provider unmounts with a confirm still pending, resolve it as cancelled so the
  // awaiting caller never hangs (defensive — the provider currently wraps the whole app).
  useEffect(() => () => resolveRef.current?.(false), [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && <ConfirmDialog options={options} onResolve={close} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({
  options,
  onResolve
}: {
  options: ConfirmOptions
  onResolve: (ok: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)

  // Escape cancels; the overlay click cancels too. (Cancel is the autofocused default, so a
  // bare Enter never fires a destructive confirm.) NOTE: a modal that opens a confirm OVER
  // itself and also has its own window Escape-to-close must guard that handler while the confirm
  // is pending — `stopPropagation` can't help here because both listeners sit on `window` (the
  // same node), where it doesn't stop sibling listeners. See PipelineEditor's `confirming` guard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onResolve(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false
  } = options
  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div
        className="modal modal--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title" id="confirm-title">
          {title}
        </h3>
        <p className="modal__target" id="confirm-message">
          {message}
        </p>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={() => onResolve(false)} autoFocus>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
