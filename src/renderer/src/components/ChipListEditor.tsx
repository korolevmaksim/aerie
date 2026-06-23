import { useId, useRef, useState } from 'react'

/**
 * A reusable add/remove/set-default chip list for the agent editor's Model and Thinking
 * sub-editors (M12 redesign). The chips form a real ARIA radiogroup: each chip is a
 * `role="radio"` whose checked state is the current default, with roving tabindex and
 * arrow-key movement of the default. A separate ✕ button removes the item.
 *
 * The component is fully controlled — it owns no list state, only the transient add-input
 * text and its inline validation message, so `formToAgent` stays the single source of truth.
 */
export interface ChipListEditorProps {
  /** Stable label for the radiogroup / quick announcements (e.g. "Models", "Reasoning levels"). */
  groupLabel: string
  /** Singular noun used in remove labels + add validation (e.g. "model", "reasoning level"). */
  itemNoun: string
  /** Current items (the chip list). */
  items: string[]
  /** Current default (the checked radio); '' when none. Always a member of `items` when non-empty. */
  value: string
  /** Placeholder for the add input. */
  addPlaceholder: string
  /** aria-label for the add input. */
  addLabel: string
  /** Replace the whole list + default in one update (keeps the parent's invariants in one place). */
  onChange: (next: { items: string[]; value: string }) => void
}

/** Set `value`, dropping it onto the list if somehow missing (defensive — parent keeps it valid). */
function withDefault(items: string[], value: string): { items: string[]; value: string } {
  if (value && !items.includes(value)) return { items: [...items, value], value }
  return { items, value }
}

function ChipListEditor({
  groupLabel,
  itemNoun,
  items,
  value,
  addPlaceholder,
  addLabel,
  onChange
}: ChipListEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()

  const add = (): void => {
    const next = draft.trim()
    if (!next) {
      setAddError(`Enter a ${itemNoun} id.`)
      return
    }
    if (items.includes(next)) {
      setAddError(`"${next}" is already in the list.`)
      return
    }
    const items2 = [...items, next]
    // The first item added becomes the default; later adds leave the default alone.
    onChange({ items: items2, value: value || next })
    setDraft('')
    setAddError(null)
    addInputRef.current?.focus()
  }

  const remove = (id: string): void => {
    const items2 = items.filter((m) => m !== id)
    if (items2.length === 0) {
      onChange({ items: [], value: '' })
      return
    }
    // Removing the current default reassigns it to the first remaining item.
    const value2 = id === value ? items2[0] : value
    onChange(withDefault(items2, value2))
  }

  const setDefault = (id: string): void => onChange(withDefault(items, id))

  // Arrow keys move the default across the radiogroup (roving selection), matching native
  // radio behavior; Home/End jump to the ends.
  const onChipKeyDown = (e: React.KeyboardEvent, index: number): void => {
    let target = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (index + 1) % items.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      target = (index - 1 + items.length) % items.length
    else if (e.key === 'Home') target = 0
    else if (e.key === 'End') target = items.length - 1
    else if (e.key === ' ' || e.key === 'Enter') target = index
    else return
    e.preventDefault()
    setDefault(items[target])
    // Move focus to the newly-selected chip so the roving tabindex follows the default. Target the
    // radiogroup (not the per-chip wrapper, which holds a single radio) so all chips are in scope.
    const group = e.currentTarget.closest('[role="radiogroup"]')
    const chips = group?.querySelectorAll<HTMLElement>('[role="radio"]')
    chips?.[target]?.focus()
  }

  return (
    <div className="agent-editor__chips">
      {items.length > 0 && (
        <div className="agent-editor__chip-list" role="radiogroup" aria-label={groupLabel}>
          {items.map((id, i) => {
            const isDefault = id === value
            return (
              <span
                key={id}
                className={`agent-editor__chip${isDefault ? ' agent-editor__chip--default' : ''}`}
              >
                <span
                  role="radio"
                  aria-checked={isDefault}
                  // Roving tabindex: only the checked chip (or the first, when none) is tabbable.
                  tabIndex={isDefault || (!value && i === 0) ? 0 : -1}
                  className="agent-editor__chip-default"
                  onClick={() => setDefault(id)}
                  onKeyDown={(e) => onChipKeyDown(e, i)}
                >
                  {id}
                  {isDefault && <span className="muted"> · default</span>}
                </span>
                <button
                  type="button"
                  className="agent-editor__chip-remove"
                  aria-label={`Remove ${id}`}
                  onClick={() => remove(id)}
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}
      <div className="agent-editor__add-row">
        <input
          ref={addInputRef}
          className="field"
          aria-label={addLabel}
          aria-invalid={addError ? true : undefined}
          aria-describedby={addError ? errorId : undefined}
          value={draft}
          placeholder={addPlaceholder}
          onChange={(e) => {
            setDraft(e.target.value)
            if (addError) setAddError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn btn--ghost" onClick={add}>
          + Add
        </button>
      </div>
      {addError && (
        <p className="hint" id={errorId} role="alert">
          {addError}
        </p>
      )}
    </div>
  )
}

export default ChipListEditor
