// Pure focus-trap math (UI/UX a11y, ROADMAP M11). The DOM wiring lives in the
// `useFocusTrap` hook; the wrap-around index logic is split out here so it's
// unit-testable without a DOM.

/** CSS selector for tabbable elements within a container (disabled ones excluded). */
export const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function firstSummary(details: HTMLElement): HTMLElement | null {
  for (const child of Array.from(details.children)) {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'summary') return child
  }
  return null
}

/** Whether `element` is a real tab stop inside this trap right now. */
export function isFocusableInTrap(element: HTMLElement, container: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  let node: HTMLElement | null = element
  while (node && node !== container) {
    if (node.inert || node.hidden || node.getAttribute('aria-hidden') === 'true') return false
    if (node.tagName.toLowerCase() === 'details' && !node.hasAttribute('open')) {
      const summary = firstSummary(node)
      return summary !== null && (summary === element || summary.contains(element))
    }
    node = node.parentElement
  }
  return true
}

/**
 * The index to focus next inside a focus trap, given the currently-focused element's
 * index, the number of trappable elements, and whether Shift was held. Wraps around the
 * ends (Tab past the last → first; Shift+Tab past the first → last). If the active
 * element isn't in the list (`current < 0`), starts at the first (or last on Shift).
 * Returns -1 when there is nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return (current + (shift ? -1 : 1) + count) % count
}
