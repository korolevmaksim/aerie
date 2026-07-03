import type { ReviewMemoryDecision, ReviewMemoryEvent } from '@shared/types'
import { formatRelativeTime } from '../lib/format'

function decisionLabel(decision: ReviewMemoryDecision | null): string {
  if (!decision) return 'none'
  if (decision === 'false_positive') return 'false positive'
  if (decision === 'accepted_risk') return 'accepted risk'
  if (decision === 'needs_follow_up') return 'needs follow-up'
  return decision
}

function eventLabel(kind: ReviewMemoryEvent['eventKind']): string {
  if (kind === 'created') return 'created'
  if (kind === 'updated') return 'updated'
  return 'archived'
}

function stableShort(stableId: string): string {
  const parts = stableId.split(':')
  const tail = parts.at(-1) ?? stableId
  return tail.length > 12 ? tail.slice(0, 12) : tail
}

function ReviewMemoryEvents({ events }: { events: ReviewMemoryEvent[] }): React.JSX.Element {
  return (
    <details className="review-memory__events">
      <summary>Audit events ({events.length})</summary>
      {events.length === 0 ? (
        <p className="empty">No review-memory events for this repository yet.</p>
      ) : (
        <ol className="review-memory__event-list">
          {events.map((event) => (
            <li key={event.id} className="review-memory__event">
              <span className="chip">{eventLabel(event.eventKind)}</span>
              <span>{decisionLabel(event.decision)}</span>
              <code title={event.stableId}>stable {stableShort(event.stableId)}</code>
              {event.contextHash && (
                <code title={event.contextHash}>context {stableShort(event.contextHash)}</code>
              )}
              <span className="muted">{formatRelativeTime(event.createdAt)}</span>
              {event.note && <span className="review-memory__event-note">{event.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}

export default ReviewMemoryEvents
