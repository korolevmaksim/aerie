import { createContext, useContext } from 'react'

/**
 * App-wide confirm hook (ROADMAP M11). The context value is supplied by `ConfirmProvider`
 * (see `components/ConfirmDialog.tsx`); `useConfirm()` returns an async
 * `confirm(options) => Promise<boolean>` (true = confirmed, false = cancelled/escaped) that
 * replaces blocking, unthemed, inconsistently announced `window.confirm` calls.
 */
export interface ConfirmOptions {
  title: string
  message: string
  /** Confirm-button label (default "Confirm"). */
  confirmLabel?: string
  /** Cancel-button label (default "Cancel"). */
  cancelLabel?: string
  /** Style the confirm button as destructive (red). */
  danger?: boolean
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFn | null>(null)

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider')
  return ctx
}
