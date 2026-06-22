import { useEffect, useMemo, useRef, useState } from 'react'
import { filterCommands, type PaletteCommand } from '../lib/palette'
import { useFocusTrap } from '../lib/useFocusTrap'

/**
 * Command palette (ROADMAP M14) — a Cmd/Ctrl-K overlay to switch views, accounts, and
 * jump to repos. Fuzzy-filters the given commands; arrow keys move the selection, Enter
 * runs it, Esc/overlay-click closes. Focus-trapped + role=dialog/listbox for a11y.
 */
function CommandPalette({
  commands,
  onClose
}: {
  commands: PaletteCommand[]
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useFocusTrap(modalRef)

  const results = useMemo(() => filterCommands(commands, query), [commands, query])

  // Keep the highlighted option scrolled into view as the selection moves (no setState).
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const run = (cmd: PaletteCommand): void => {
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = results[active]
      if (cmd) run(cmd)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="field palette__input"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? `palette-opt-${active}` : undefined}
          aria-label="Type a command or repository"
          placeholder="Type a command or repository…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0) // reset the highlight to the top as the result set changes
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <li className="palette__empty">No matches</li>
          ) : (
            results.map((c, i) => (
              <li
                key={c.id}
                id={`palette-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`palette__item ${i === active ? 'palette__item--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="palette__title">{c.title}</span>
                {c.hint && <span className="palette__hint">{c.hint}</span>}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

export default CommandPalette
