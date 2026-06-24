import { useEffect, type RefObject } from 'react'
import { FOCUSABLE_SELECTOR, isFocusableInTrap, nextFocusIndex } from './focusTrap'

/**
 * Traps Tab focus within `ref` (a modal/dialog) and restores focus to the element that
 * was focused before the trap mounted when it unmounts — so a keyboard user can't tab
 * out of a confirm dialog and lands back where they were on close. Pair with
 * role="dialog" + aria-modal on the same container. The initial focus is left to the
 * dialog's own autoFocus.
 *
 * LIMITATION: the trap treats every FOCUSABLE_SELECTOR match as its own tab stop, so it
 * does NOT honor composite-widget semantics (radio groups, listboxes, grids — which use a
 * single tab stop + arrow keys). It's correct for simple dialogs (inputs/buttons/textarea);
 * add roving-tabindex handling here before putting such a widget inside a trapped dialog.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = ref.current
    if (!container) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => isFocusableInTrap(el, container))
      if (focusables.length === 0) return
      const current = focusables.indexOf(document.activeElement as HTMLElement)
      const next = nextFocusIndex(current, focusables.length, e.shiftKey)
      if (next >= 0) {
        e.preventDefault()
        focusables[next].focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore focus to the opener (e.g. the "Post" button) on close — but only if it's
      // still in the DOM, so we don't fight a re-render that replaced it.
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [ref])
}
