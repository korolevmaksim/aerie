// Small accessibility helpers (UI/UX, ROADMAP M11). Keep the key-matching pure so it's
// unit-testable; `clickableRow` is a thin props factory built on it.

import type { KeyboardEvent } from 'react'

/** True for the keys that should "activate" a custom (non-<button>) clickable element. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar'
}

export interface ClickableRowProps {
  role: 'button'
  tabIndex: 0
  onClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
}

/**
 * Makes a non-<button> element (e.g. a list `<li>`) keyboard-operable: spread the
 * returned props so it's focusable, exposes a button role, and activates on Enter/Space
 * (Space's default page-scroll is suppressed). Only use on elements whose content is NOT
 * itself interactive (no nested buttons/links — that would be an invalid nested control).
 */
export function clickableRow(onClick: () => void): ClickableRowProps {
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent): void => {
      if (isActivationKey(e.key)) {
        e.preventDefault()
        onClick()
      }
    }
  }
}
