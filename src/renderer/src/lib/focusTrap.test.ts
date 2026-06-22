import { describe, expect, it } from 'vitest'
import { FOCUSABLE_SELECTOR, nextFocusIndex } from './focusTrap'

describe('nextFocusIndex', () => {
  it('advances forward and wraps past the last to the first', () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1)
    expect(nextFocusIndex(1, 3, false)).toBe(2)
    expect(nextFocusIndex(2, 3, false)).toBe(0) // wrap
  })

  it('goes backward (Shift) and wraps past the first to the last', () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1)
    expect(nextFocusIndex(1, 3, true)).toBe(0)
    expect(nextFocusIndex(0, 3, true)).toBe(2) // wrap
  })

  it('starts at the first (or last on Shift) when the active element is not in the list', () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0)
    expect(nextFocusIndex(-1, 3, true)).toBe(2)
  })

  it('returns -1 when there is nothing to focus', () => {
    expect(nextFocusIndex(0, 0, false)).toBe(-1)
    expect(nextFocusIndex(-1, 0, true)).toBe(-1)
  })

  it('handles a single trappable element (stays on it)', () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0)
    expect(nextFocusIndex(0, 1, true)).toBe(0)
  })
})

describe('FOCUSABLE_SELECTOR', () => {
  it('excludes disabled controls and tabindex=-1', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])')
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])')
  })
})
