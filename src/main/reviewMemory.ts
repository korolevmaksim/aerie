import type {
  AnnotateFindingParams,
  ImportReviewMemoryParams,
  ImportReviewMemoryResult,
  ReviewMemoryEvent,
  ReviewMemoryAnnotation,
  ReviewMemoryDecision,
  ReviewMemoryExport,
  ReviewMemoryExportEntry,
  ReviewMemoryMatch,
  ReviewMemoryPromptContext,
  ReviewMemoryScopeKind,
  UpdateReviewMemoryAnnotationParams
} from '../shared/types'
import {
  clearReviewMemoryAnnotation,
  getFindingById,
  getRepoById,
  getRun,
  listAllReviewMemoryAnnotationsForRepo,
  listReviewMemoryAnnotationsForContextHashes,
  listReviewMemoryEventsForRepo,
  listReviewMemoryAnnotationsForRepo,
  listReviewMemoryAnnotationsForStableIds,
  stableIdForFindingRow,
  updateReviewMemoryAnnotation,
  upsertReviewMemoryAnnotation
} from './store'
import { redactText } from './redact'

export const REVIEW_MEMORY_DECISIONS: readonly ReviewMemoryDecision[] = [
  'accepted',
  'fixed',
  'false_positive',
  'accepted_risk',
  'duplicate',
  'dismissed',
  'needs_follow_up'
]

const REVIEW_MEMORY_DECISION_SET = new Set<ReviewMemoryDecision>(REVIEW_MEMORY_DECISIONS)

const SUPPRESSING_DECISIONS = new Set<ReviewMemoryDecision>([
  'false_positive',
  'accepted_risk',
  'duplicate',
  'dismissed'
])

const MAX_NOTE_LENGTH = 1000
const MAX_IMPORT_BYTES = 1_000_000
const MAX_IMPORT_ANNOTATIONS = 500
const MAX_ID_LENGTH = 160
const MAX_PROMPT_MEMORY_ENTRIES = 8
const MAX_PROMPT_FIELD_LENGTH = 180

export function isReviewMemoryDecision(value: unknown): value is ReviewMemoryDecision {
  return typeof value === 'string' && REVIEW_MEMORY_DECISION_SET.has(value as ReviewMemoryDecision)
}

export function isReviewMemoryScopeKind(value: unknown): value is ReviewMemoryScopeKind {
  return value === 'repo' || value === 'global'
}

export function shouldSuppressReviewMemoryDecision(decision: ReviewMemoryDecision): boolean {
  return SUPPRESSING_DECISIONS.has(decision)
}

function normalizeNote(note: unknown): string {
  if (typeof note !== 'string') return ''
  return redactText(note.trim()).slice(0, MAX_NOTE_LENGTH)
}

function normalizeIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}.`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > MAX_ID_LENGTH) {
    throw new Error(`Invalid ${field}.`)
  }
  return normalized
}

function normalizeOptionalIdentity(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  return normalizeIdentity(value, field)
}

function normalizeArchivedAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('invalid archived timestamp')
  const normalized = value.trim()
  if (!normalized || Number.isNaN(Date.parse(normalized))) {
    throw new Error('invalid archived timestamp')
  }
  return normalized
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(a|b)\//, '')
    .trim()
}

function truncatePromptField(value: string): string {
  const singleLine = redactText(value).replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_PROMPT_FIELD_LENGTH) return singleLine
  return `${singleLine.slice(0, MAX_PROMPT_FIELD_LENGTH - 1)}…`
}

function shortStableId(stableId: string): string {
  const tail = stableId.split(':').at(-1) ?? stableId
  return tail.length > 12 ? tail.slice(0, 12) : tail
}

function assertNoteIfSuppressing(decision: ReviewMemoryDecision, note: string): void {
  if (shouldSuppressReviewMemoryDecision(decision) && note.length === 0) {
    throw new Error('Suppressing review-memory decisions require a note.')
  }
}

export function annotateFindingMemory(params: AnnotateFindingParams): ReviewMemoryAnnotation {
  if (!Number.isInteger(params.findingId) || params.findingId <= 0) {
    throw new Error('Invalid finding id.')
  }
  if (!isReviewMemoryDecision(params.decision)) {
    throw new Error('Invalid review-memory decision.')
  }
  const scopeKind = params.scopeKind ?? 'repo'
  if (!isReviewMemoryScopeKind(scopeKind)) {
    throw new Error('Invalid review-memory scope.')
  }

  const finding = getFindingById(params.findingId)
  if (!finding) throw new Error('Finding not found.')
  const run = getRun(finding.run_id)
  if (!run) throw new Error('Finding run not found.')
  const note = normalizeNote(params.note)
  assertNoteIfSuppressing(params.decision, note)

  const repoId = scopeKind === 'repo' ? run.repo_id : null
  return upsertReviewMemoryAnnotation({
    scopeKind,
    repoId,
    stableId: stableIdForFindingRow(finding),
    contextHash: finding.context_hash,
    decision: params.decision,
    note,
    sourceFindingId: finding.id,
    sourceRunId: finding.run_id,
    now: new Date().toISOString()
  })
}

export function clearFindingMemory(annotationId: number): boolean {
  if (!Number.isInteger(annotationId) || annotationId <= 0) {
    throw new Error('Invalid review-memory annotation id.')
  }
  return clearReviewMemoryAnnotation(annotationId, new Date().toISOString())
}

export function updateFindingMemoryAnnotation(
  params: UpdateReviewMemoryAnnotationParams
): ReviewMemoryAnnotation {
  if (!Number.isInteger(params.annotationId) || params.annotationId <= 0) {
    throw new Error('Invalid review-memory annotation id.')
  }
  if (!isReviewMemoryDecision(params.decision)) {
    throw new Error('Invalid review-memory decision.')
  }
  const note = normalizeNote(params.note)
  assertNoteIfSuppressing(params.decision, note)
  const annotation = updateReviewMemoryAnnotation({
    annotationId: params.annotationId,
    decision: params.decision,
    note,
    now: new Date().toISOString()
  })
  if (!annotation) throw new Error('Review-memory annotation not found.')
  return annotation
}

export function listRepoReviewMemory(repoId: number): ReviewMemoryAnnotation[] {
  if (!Number.isInteger(repoId) || repoId <= 0) throw new Error('Invalid repository id.')
  return listReviewMemoryAnnotationsForRepo(repoId)
}

export function listRepoReviewMemoryEvents(repoId: number): ReviewMemoryEvent[] {
  if (!Number.isInteger(repoId) || repoId <= 0) throw new Error('Invalid repository id.')
  return listReviewMemoryEventsForRepo(repoId)
}

export function exportRepoReviewMemory(repoId: number): ReviewMemoryExport {
  if (!Number.isInteger(repoId) || repoId <= 0) throw new Error('Invalid repository id.')
  if (!getRepoById(repoId)) throw new Error('Repository not found.')
  const exportedAt = new Date().toISOString()
  return {
    schemaVersion: 1,
    exportedAt,
    repoId,
    annotations: listAllReviewMemoryAnnotationsForRepo(repoId).map(
      (annotation): ReviewMemoryExportEntry => ({
        scopeKind: annotation.scopeKind,
        stableId: annotation.stableId,
        contextHash: annotation.contextHash,
        decision: annotation.decision,
        note: annotation.note,
        archivedAt: annotation.archivedAt,
        updatedAt: annotation.updatedAt
      })
    )
  }
}

export function importRepoReviewMemory(params: ImportReviewMemoryParams): ImportReviewMemoryResult {
  if (!Number.isInteger(params.repoId) || params.repoId <= 0) {
    throw new Error('Invalid repository id.')
  }
  if (!getRepoById(params.repoId)) throw new Error('Repository not found.')
  if (typeof params.payload !== 'string' || params.payload.trim().length === 0) {
    throw new Error('Import payload is empty.')
  }
  if (Buffer.byteLength(params.payload, 'utf8') > MAX_IMPORT_BYTES) {
    throw new Error('Import payload is too large.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(params.payload)
  } catch {
    throw new Error('Import payload is not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Import payload must be a review-memory export object.')
  }
  const payload = parsed as Partial<ReviewMemoryExport>
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.annotations)) {
    throw new Error('Unsupported review-memory export schema.')
  }
  if (payload.annotations.length > MAX_IMPORT_ANNOTATIONS) {
    throw new Error(`Import payload contains more than ${MAX_IMPORT_ANNOTATIONS} annotations.`)
  }

  let imported = 0
  let skipped = 0
  const errors: string[] = []
  const now = new Date().toISOString()
  for (const [index, rawEntry] of payload.annotations.entries()) {
    try {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error('entry is not an object')
      }
      const entry = rawEntry as Partial<ReviewMemoryExportEntry>
      if (!isReviewMemoryScopeKind(entry.scopeKind)) throw new Error('invalid scope')
      if (!isReviewMemoryDecision(entry.decision)) throw new Error('invalid decision')
      const note = normalizeNote(entry.note)
      assertNoteIfSuppressing(entry.decision, note)
      const annotation = upsertReviewMemoryAnnotation({
        scopeKind: entry.scopeKind,
        repoId: entry.scopeKind === 'repo' ? params.repoId : null,
        stableId: normalizeIdentity(entry.stableId, 'stable id'),
        contextHash: normalizeOptionalIdentity(entry.contextHash, 'context hash'),
        decision: entry.decision,
        note,
        sourceFindingId: null,
        sourceRunId: null,
        now
      })
      const archivedAt = normalizeArchivedAt(entry.archivedAt)
      if (archivedAt) clearReviewMemoryAnnotation(annotation.id, archivedAt)
      imported += 1
    } catch (error) {
      skipped += 1
      if (errors.length < 10) {
        errors.push(
          `Annotation ${index + 1}: ${error instanceof Error ? error.message : 'invalid entry'}`
        )
      }
    }
  }

  return { imported, skipped, errors }
}

export function buildReviewMemoryPromptContext(
  repoId: number,
  changedFiles: readonly string[],
  maxEntries = MAX_PROMPT_MEMORY_ENTRIES
): ReviewMemoryPromptContext {
  if (!Number.isInteger(repoId) || repoId <= 0) throw new Error('Invalid repository id.')
  const changed = new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))
  if (changed.size === 0) {
    return { text: '', considered: 0, included: 0, omitted: 0, suppressed: 0, reopened: 0 }
  }

  const annotations = listRepoReviewMemory(repoId)
  const considered = annotations.length
  const sourceCache = new Map<number, ReturnType<typeof getFindingById> | null>()
  const matching: Array<{
    annotation: ReviewMemoryAnnotation
    finding: NonNullable<ReturnType<typeof getFindingById>>
  }> = []
  for (const annotation of annotations) {
    const sourceFindingId = annotation.sourceFindingId
    if (sourceFindingId === null) continue
    let finding = sourceCache.get(sourceFindingId)
    if (finding === undefined) {
      finding = getFindingById(sourceFindingId) ?? null
      sourceCache.set(sourceFindingId, finding)
    }
    if (!finding) continue
    if (changed.has(normalizeRepoPath(finding.file))) matching.push({ annotation, finding })
  }

  const deduped = new Map<string, (typeof matching)[number]>()
  for (const match of matching) {
    const existing = deduped.get(match.annotation.stableId)
    if (
      !existing ||
      (existing.annotation.scopeKind === 'global' && match.annotation.scopeKind === 'repo')
    ) {
      deduped.set(match.annotation.stableId, match)
    }
  }

  const includedMatches = Array.from(deduped.values()).slice(0, maxEntries)
  const omitted = Math.max(0, deduped.size - includedMatches.length)
  const suppressed = includedMatches.filter((match) =>
    shouldSuppressReviewMemoryDecision(match.annotation.decision)
  ).length
  const reopened = includedMatches.filter((match) => match.annotation.decision === 'fixed').length
  if (includedMatches.length === 0) {
    return { text: '', considered, included: 0, omitted: deduped.size, suppressed: 0, reopened: 0 }
  }

  const lines = includedMatches.map(({ annotation, finding }) => {
    const loc = `${normalizeRepoPath(finding.file)}${finding.line !== null ? `:${finding.line}` : ''}`
    const rule = finding.rule_id ? ` rule=${truncatePromptField(finding.rule_id)}` : ''
    const message = truncatePromptField(finding.message)
    const note = annotation.note ? `; note="${truncatePromptField(annotation.note)}"` : ''
    return `- ${annotation.decision} (${annotation.scopeKind}, stable ${shortStableId(annotation.stableId)}) ${loc}${rule}: ${message}${note}`
  })

  const text = [
    '## Local review memory — advisory only',
    `Aerie found ${includedMatches.length} prior decision${includedMatches.length === 1 ? '' : 's'} for files touched by this review${omitted > 0 ? ` (${omitted} omitted by cap)` : ''}.`,
    'Use this to avoid repeating dismissed/false-positive noise, but current source code wins. If current evidence contradicts memory, report the issue and say why.',
    ...lines
  ].join('\n')

  return {
    text,
    considered,
    included: includedMatches.length,
    omitted,
    suppressed,
    reopened
  }
}

function matchFromAnnotation(
  annotation: ReviewMemoryAnnotation,
  matchedBy: ReviewMemoryMatch['matchedBy']
): ReviewMemoryMatch {
  return {
    annotation,
    matchedBy,
    reopened: annotation.decision === 'fixed',
    suppresses: shouldSuppressReviewMemoryDecision(annotation.decision)
  }
}

export function attachReviewMemory<T extends { stableId: string; contextHash?: string | null }>(
  repoId: number,
  findings: readonly T[]
): Array<T & { memory: ReviewMemoryMatch | null }> {
  if (findings.length === 0) return []
  const stableAnnotations = listReviewMemoryAnnotationsForStableIds(
    repoId,
    findings.map((finding) => finding.stableId)
  )
  const byStableId = new Map<string, ReviewMemoryAnnotation>()
  for (const annotation of stableAnnotations) {
    if (!byStableId.has(annotation.stableId)) byStableId.set(annotation.stableId, annotation)
  }
  const contextAnnotations = listReviewMemoryAnnotationsForContextHashes(
    repoId,
    findings.flatMap((finding) => (finding.contextHash ? [finding.contextHash] : []))
  )
  const byContextHash = new Map<string, ReviewMemoryAnnotation>()
  for (const annotation of contextAnnotations) {
    if (annotation.contextHash && !byContextHash.has(annotation.contextHash)) {
      byContextHash.set(annotation.contextHash, annotation)
    }
  }
  return findings.map((finding) => {
    const stableAnnotation = byStableId.get(finding.stableId)
    const contextAnnotation = finding.contextHash
      ? byContextHash.get(finding.contextHash)
      : undefined
    return {
      ...finding,
      memory: stableAnnotation
        ? matchFromAnnotation(stableAnnotation, 'stable_id')
        : contextAnnotation
          ? matchFromAnnotation(contextAnnotation, 'context_hash')
          : null
    }
  })
}

export function filterSuppressedFindings<T extends { memory?: ReviewMemoryMatch | null }>(
  findings: readonly T[]
): T[] {
  return findings.filter((finding) => !finding.memory?.suppresses)
}
