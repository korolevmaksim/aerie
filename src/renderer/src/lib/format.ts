/** Compact relative time like "3h ago" / "5d ago". Falls back to "—" for null. */
export function formatRelativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const sec = Math.round((now - then) / 1000)
  if (sec < 60) return 'just now'
  const mins = Math.round(sec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}
