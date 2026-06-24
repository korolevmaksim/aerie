import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOCUSABLE_SELECTOR, isFocusableInTrap, nextFocusIndex } from './focusTrap'

class FakeElement {
  tagName: string
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  hidden = false
  inert = false
  private attrs = new Map<string, string>()

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase()
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value)
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  contains(other: FakeElement): boolean {
    if (this === other) return true
    return this.children.some((child) => child.contains(other))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('isFocusableInTrap', () => {
  it('excludes controls inside closed details while keeping its summary tabbable', () => {
    vi.stubGlobal('HTMLElement', FakeElement)
    const container = new FakeElement('div')
    const details = new FakeElement('details')
    const summary = new FakeElement('summary')
    const input = new FakeElement('input')
    details.append(summary, input)
    container.append(details)

    expect(
      isFocusableInTrap(summary as unknown as HTMLElement, container as unknown as HTMLElement)
    ).toBe(true)
    expect(
      isFocusableInTrap(input as unknown as HTMLElement, container as unknown as HTMLElement)
    ).toBe(false)
  })

  it('allows controls inside open details', () => {
    vi.stubGlobal('HTMLElement', FakeElement)
    const container = new FakeElement('div')
    const details = new FakeElement('details', { open: '' })
    const input = new FakeElement('input')
    details.append(input)
    container.append(details)

    expect(
      isFocusableInTrap(input as unknown as HTMLElement, container as unknown as HTMLElement)
    ).toBe(true)
  })
})
