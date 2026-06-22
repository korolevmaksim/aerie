import { describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent } from 'react'
import { clickableRow, isActivationKey } from './a11y'

describe('isActivationKey', () => {
  it('is true for Enter and Space', () => {
    expect(isActivationKey('Enter')).toBe(true)
    expect(isActivationKey(' ')).toBe(true)
    expect(isActivationKey('Spacebar')).toBe(true)
  })
  it('is false for other keys', () => {
    expect(isActivationKey('a')).toBe(false)
    expect(isActivationKey('Tab')).toBe(false)
    expect(isActivationKey('Escape')).toBe(false)
  })
})

describe('clickableRow', () => {
  it('exposes a button role and is focusable', () => {
    const p = clickableRow(() => {})
    expect(p.role).toBe('button')
    expect(p.tabIndex).toBe(0)
  })

  it('activates onClick for Enter/Space and preventDefaults', () => {
    const onClick = vi.fn()
    const { onKeyDown } = clickableRow(onClick)
    const preventDefault = vi.fn()
    onKeyDown({ key: 'Enter', preventDefault } as unknown as KeyboardEvent)
    onKeyDown({ key: ' ', preventDefault } as unknown as KeyboardEvent)
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('ignores non-activation keys', () => {
    const onClick = vi.fn()
    const { onKeyDown } = clickableRow(onClick)
    const preventDefault = vi.fn()
    onKeyDown({ key: 'a', preventDefault } as unknown as KeyboardEvent)
    expect(onClick).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
