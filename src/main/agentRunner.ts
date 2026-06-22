import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type {
  AgentInfo,
  ConsensusParams,
  ConsensusResult,
  RunFinding,
  RunHistoryItem,
  RunRecord,
  RunStatus,
  StartBatchParams,
  StartBatchResult,
  StartRunParams
} from '../shared/types'
import { assessReviewQuality } from '../shared/quality'
import { AGENT_CATALOG } from './agentCatalog'
import { discoverAllModels, overlayModels } from './agentDiscovery'
import { aggregateFindings } from './aggregate'
import { planBatch } from './batch'
import { agentNeedsConsent, agentSignature } from './execConsent'
import { cloneToUserAgent, deleteUserAgent, upsertUserAgent } from './userAgents'
import {
  buildPrompt,
  DEFAULT_AGENTS,
  isAgent,
  mergeAgents,
  RETIRED_AGENT_IDS,
  runStatusForExit,
  substitute,
  type Agent
} from './agentConfig'
import { decryptToken } from './auth'
import {
  extractSecrets,
  parseAgentFindings,
  parseChangedLineRanges,
  parseToolOutput,
  redactFinding,
  scopeToChanges,
  type Finding
} from './findings'
import { getPullRequestBaseSha } from './github'
import {
  cleanupCheckout,
  prepareCheckout,
  prepareWorkingTree,
  type PreparedCheckout
} from './gitEngine'
import { gatherGroundTruth } from './grounding'
import { log } from './logger'
import { whichOnPath } from './pathLookup'
import { redactText } from './redact'
import { activeCount, noteOutput, noteStatus, registerRun } from './runEvents'
import { createSemaphore } from './semaphore'
import { TOOL_CATALOG } from './toolCatalog'
import {
  getAccount,
  getPrompt,
  getRepoById,
  deleteSetting,
  getSetting,
  hasActiveRun,
  insertFindings,
  insertRun,
  listAllRuns,
  listFindingsForRun,
  listRunsForRepo,
  setSetting,
  updateRunStatus,
  type RepoRow,
  type RunRow
} from './store'

/**
 * Agent runner (SPEC §5/§7 — THE WEDGE). Loads the editable agent registry
 * (agents.json in userData), prepares context (worktree checkout + prompt file +
 * diff file), spawns the configured CLI in the worktree, streams stdout/stderr
 * live to the renderer, captures the result, and persists a `runs` row.
 *
 * The app knows nothing hard-coded about any specific agent — adding one is a
 * config edit, never a code change. The GitHub token is NEVER passed to the
 * agent's environment.
 */

function agentsPath(): string {
  return join(app.getPath('userData'), 'agents.json')
}

// Canonical exec signature per AUTHOR-SHIPPED id (default templates + catalog + tools).
const CANONICAL_SIGNATURES: ReadonlyMap<string, string> = new Map(
  [...DEFAULT_AGENTS, ...AGENT_CATALOG, ...TOOL_CATALOG].map((a) => [a.id, agentSignature(a)])
)

/**
 * Trusted to spawn WITHOUT consent only when the id is author-shipped AND the agent's full
 * descriptor STILL MATCHES the canonical shipped one. Keyed on PROVENANCE, not just id:
 * only DEFAULT ids are authoritative in mergeAgents, so a user agent that claims a CATALOG
 * or TOOL id (e.g. 'eslint', 'qwen') but carries a different command/args/env/discovery
 * does not match the canonical signature → it is untrusted and must be explicitly approved.
 */
function isTrustedAgent(agent: Agent): boolean {
  return CANONICAL_SIGNATURES.get(agent.id) === agentSignature(agent)
}

/** True when a user-authored/edited agent still lacks matching exec consent. */
function agentBlocked(agent: Agent): boolean {
  return agentNeedsConsent(
    agent,
    isTrustedAgent(agent),
    getSetting(`agent.execConsent:${agent.id}`)
  )
}

/**
 * Loads the agent registry. The shipped default templates are authoritative for
 * their ids (so fixes like codex's clean -o output apply on upgrade); any
 * user-ADDED agents (ids not among the defaults) are preserved. The merged set
 * is written back so the editable file always reflects the current defaults.
 * Per-agent model choices live in settings (not the file), so this never clobbers
 * them.
 */
export function loadAgents(): Agent[] {
  const path = agentsPath()
  let userAgents: Agent[] = []
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      userAgents = (Array.isArray(parsed) ? parsed : []).filter(isAgent)
    } catch (e) {
      log.warn('agents.json could not be parsed — using defaults', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  // Persist defaults + user-added agents; ALSO surface catalog entries whose CLI is
  // detected on PATH (runtime-only, never written back to agents.json).
  const { persist, runtime } = mergeAgents({
    defaults: DEFAULT_AGENTS,
    userAgents,
    catalog: [...AGENT_CATALOG, ...TOOL_CATALOG],
    retired: RETIRED_AGENT_IDS,
    isDetected: (a) => whichOnPath(a.detect ?? a.command) !== null
  })
  try {
    writeFileSync(path, JSON.stringify(persist, null, 2), 'utf8')
  } catch {
    /* registry is best-effort to persist */
  }
  return runtime
}

/** The currently selected model for an agent (settings override → template default). */
function resolveModel(agent: Agent): string {
  return getSetting(`agent.model:${agent.id}`) ?? agent.model ?? ''
}

/** The currently selected reasoning level for an agent (settings override → template default). */
function resolveReasoning(agent: Agent): string {
  return getSetting(`agent.reasoning:${agent.id}`) ?? agent.reasoning ?? ''
}

/**
 * The model list to show for an agent: the live-discovered list (M2) if one was
 * cached by a prior `discoverAgentModels()`, else the static seed — keeping the
 * selected model present either way. A SYNCHRONOUS settings read; the pure overlay
 * logic lives in `overlayModels` (discovery's spawn never runs here).
 */
function resolveModels(agent: Agent): { models: string[]; source: 'static' | 'discovered' } {
  return overlayModels(
    agent.models ?? [],
    getSetting(`agent.discoveredModels:${agent.id}`),
    resolveModel(agent)
  )
}

/** Persists a per-agent model choice. */
export function setAgentModel(id: string, model: string): void {
  setSetting(`agent.model:${id}`, model)
}

/** Persists a per-agent reasoning-level choice. */
export function setAgentReasoning(id: string, reasoning: string): void {
  setSetting(`agent.reasoning:${id}`, reasoning)
}

/** Renderer-facing agent list with resolved model/reasoning + availability + path. */
export function listAgentInfos(): AgentInfo[] {
  const userIds = new Set(readPersistedUserAgents().map((a) => a.id))
  return loadAgents().map((a) => {
    const path = whichOnPath(a.detect ?? a.command)
    const { models, source } = resolveModels(a)
    return {
      id: a.id,
      label: a.label,
      model: resolveModel(a),
      models,
      modelsSource: source,
      reasoning: resolveReasoning(a),
      reasoningLevels: a.reasoningLevels ?? [],
      available: path !== null,
      path,
      // User-authored agents must be approved before they can run (M12); shipped never.
      needsConsent: agentBlocked(a),
      editable: userIds.has(a.id)
    }
  })
}

/** The full descriptor for an agent id (for the editor to edit/clone). Null if unknown. */
export function getAgentById(id: string): Agent | null {
  return loadAgents().find((a) => a.id === id) ?? null
}

/**
 * Records the user's explicit approval to run a NON-shipped agent's exact current command
 * (M12 exec-consent). Stores the signature so a later edit to the command/args re-requires
 * approval. No-op for a shipped id (those are implicitly trusted) or an unknown id.
 */
export function approveAgentExec(id: string): AgentInfo[] {
  const agent = loadAgents().find((a) => a.id === id)
  if (agent && !isTrustedAgent(agent)) {
    setSetting(`agent.execConsent:${id}`, agentSignature(agent))
  }
  return listAgentInfos()
}

// ----- In-app agent registry editor (M12) -------------------------------------------
// Saves operate ONLY on the user slice of agents.json (ids that aren't shipped defaults);
// the whole file is rewritten as [...DEFAULT_AGENTS, ...userSlice], so a default can never
// be shadowed or clobbered. The exec-consent gate still applies to anything saved here.

const SHIPPED_IDS: ReadonlySet<string> = new Set(CANONICAL_SIGNATURES.keys())

export type EditorResult = { ok: true; agents: AgentInfo[] } | { ok: false; error: string }

/** The persisted user-authored agents (file entries whose id isn't a shipped default). */
function readPersistedUserAgents(): Agent[] {
  const path = agentsPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const defaultIds = new Set(DEFAULT_AGENTS.map((a) => a.id))
    // The user slice = valid agents that aren't a shipped default and aren't retired —
    // the SAME notion mergeAgents uses, so the two readers never diverge.
    return (Array.isArray(parsed) ? parsed : [])
      .filter(isAgent)
      .filter((a: Agent) => !defaultIds.has(a.id) && !RETIRED_AGENT_IDS.has(a.id))
  } catch {
    return []
  }
}

function writeUserAgents(userAgents: Agent[]): void {
  writeFileSync(agentsPath(), JSON.stringify([...DEFAULT_AGENTS, ...userAgents], null, 2), 'utf8')
}

function clearAgentSettings(id: string): void {
  deleteSetting(`agent.execConsent:${id}`)
  deleteSetting(`agent.discoveredModels:${id}`)
  deleteSetting(`agent.model:${id}`)
  deleteSetting(`agent.reasoning:${id}`)
}

/**
 * Add or edit a user agent. Validates the payload + id (pure `upsertUserAgent`), then
 * rewrites the user slice. A renamed id's orphaned per-id settings are cleared. Editing a
 * command re-keys its exec signature, so prior consent self-invalidates (no manual clear).
 */
export function saveUserAgent(agent: unknown, editingId?: string): EditorResult {
  const res = upsertUserAgent({
    userAgents: readPersistedUserAgents(),
    agent,
    shippedIds: SHIPPED_IDS,
    editingId
  })
  if (!res.ok) return res
  const newId = (agent as Agent).id
  if (editingId && editingId !== newId) clearAgentSettings(editingId)
  writeUserAgents(res.agents)
  return { ok: true, agents: listAgentInfos() }
}

/** Remove a user agent (no-op for a shipped/absent id) and clean up its per-id settings. */
export function deleteUserAgentById(id: string): AgentInfo[] {
  const userAgents = readPersistedUserAgents()
  // Only touch settings if the id is ACTUALLY a user agent — never clear a default's
  // model/reasoning preference if a (compromised) renderer passes a shipped id.
  const wasUserAgent = userAgents.some((a) => a.id === id)
  writeUserAgents(deleteUserAgent(userAgents, id))
  if (wasUserAgent) clearAgentSettings(id)
  return listAgentInfos()
}

/** Clone any agent (shipped or user) into a fresh USER agent under a new id. */
export function cloneAgentToUser(sourceId: string, newId: string): EditorResult {
  const source = loadAgents().find((a) => a.id === sourceId)
  if (!source) return { ok: false, error: 'Source agent not found.' }
  return saveUserAgent(cloneToUserAgent(source, newId))
}

/**
 * Live model discovery (M2): runs each AUTHOR-SHIPPED model-list probe (e.g.
 * `opencode models`) for installed agents, caches the result to settings, and returns
 * the refreshed agent list. Async + spawn-based (never on the sync `listAgentInfos`
 * path). Only shipped template/catalog ids are probed — a user-added agent's descriptor
 * is not executed (exec-consent is M12).
 */
export async function discoverAgentModels(): Promise<AgentInfo[]> {
  const agents = loadAgents()
  const cwd = app.getPath('userData')
  // Only AUTHOR-SHIPPED (provenance-matched) descriptors are probed — a user-authored
  // model-discovery argv is arbitrary local exec and must never run without consent.
  const discovered = await discoverAllModels(agents, isTrustedAgent, cwd)
  const found = new Set(discovered.map((d) => d.agentId))
  for (const d of discovered) {
    setSetting(`agent.discoveredModels:${d.agentId}`, JSON.stringify(d.models))
  }
  // Clear a stale cache for any trusted agent we PROBED but that returned nothing now
  // (e.g. the CLI was uninstalled since the last discovery), so the picker falls back to
  // the seed instead of showing an outdated "live" list.
  for (const a of agents) {
    if (a.modelDiscovery?.kind === 'command' && isTrustedAgent(a) && !found.has(a.id)) {
      deleteSetting(`agent.discoveredModels:${a.id}`)
    }
  }
  return listAgentInfos()
}

const running = new Map<number, ChildProcess>()

// Cap concurrent agent processes so a burst — or, later, an automation pipeline
// (ROADMAP M9) — can't exhaust memory/disk by cloning + spawning unbounded runs.
// A run waits here (staying 'queued') until a slot frees. A small constant is the
// safe default; a per-pipeline override comes with the automation engine.
const MAX_CONCURRENT_RUNS = 3
const runSlots = createSemaphore(MAX_CONCURRENT_RUNS)

// Live full-console transcript per in-flight run (dropped once persisted to .log).
const MAX_TRANSCRIPT = 256 * 1024
const liveTranscripts = new Map<number, string>()

function rowToRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    refType: row.ref_type,
    refId: row.ref_id,
    headSha: row.head_sha,
    agentId: row.agent_id,
    status: row.status,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outputPath: row.output_path,
    postedUrl: row.posted_url,
    authorLogin: row.author_login
  }
}

/**
 * Starts a run: inserts the `runs` row and kicks off the async prepare+spawn.
 * Returns the queued record immediately; progress is broadcast through the
 * central run-events hub (`runEvents`), which both the tray and the renderer
 * fan-out subscribe to.
 */
export function startRun(params: StartRunParams): RunRecord {
  const agents = loadAgents()
  const agent = agents.find((a) => a.id === params.agentId)
  if (!agent) throw new Error(`Unknown agent "${params.agentId}".`)
  const repo = getRepoById(params.repoId)
  if (!repo) throw new Error('Repository not found.')
  if (!repo.remote_url) throw new Error('Repository has no remote URL.')
  const account = getAccount(params.accountId)
  if (!account) throw new Error('Account not found.')

  const run = insertRun({
    repoId: params.repoId,
    refType: params.refType,
    refId: params.refId,
    headSha: params.sha,
    agentId: params.agentId,
    startedAt: new Date().toISOString(),
    authorLogin: params.authorLogin ?? null
  })

  // Register the queued run in the hub up front so the tray reflects it (and the
  // quit drain treats it as active) even before the agent process is spawned.
  registerRun({
    runId: run.id,
    repoFullName: repo.full_name,
    shortSha: params.sha.slice(0, 7),
    agentId: params.agentId,
    refType: params.refType,
    refId: params.refId,
    status: 'queued',
    startedAt: run.started_at
  })

  // Defer one tick so the caller receives the runId (and the renderer wires its
  // output listener) before the first status/output events are emitted.
  setImmediate(() => void execute(run.id, params, agent, repo, account.token_blob, agents))
  return rowToRecord(run)
}

/**
 * Multi-agent fan-out (ROADMAP M8/M9 — first slice): start one review across SEVERAL
 * agents on the same ref. Each eligible agent becomes its own correlated run (shared
 * repo+sha+ref, differing agent), reusing `startRun`; concurrency stays bounded by the
 * run semaphore. Not-installed / unknown / over-cap agents are reported, not started.
 * The caller (IPC) has already validated the ref + resolved any working-tree sha.
 */
export function startBatch(params: StartBatchParams): StartBatchResult {
  const installed = new Set(
    loadAgents()
      .filter((a) => whichOnPath(a.detect ?? a.command) !== null)
      .map((a) => a.id)
  )
  const plan = planBatch(params.agentIds, installed)
  const runs: RunRecord[] = []
  const skipped: StartBatchResult['skipped'] = [...plan.skipped]
  for (const agentId of plan.run) {
    // Skip an agent already running for this exact ref (mirrors the single-run guard) —
    // and report it, so the UI explains why no RunView appeared for that agent.
    if (
      hasActiveRun(
        params.repoId,
        params.sha,
        agentId,
        params.refType === 'working-tree' ? params.refId : undefined
      )
    ) {
      skipped.push({ id: agentId, reason: 'already-running' })
      continue
    }
    runs.push(
      startRun({
        accountId: params.accountId,
        repoId: params.repoId,
        sha: params.sha,
        refType: params.refType,
        refId: params.refId,
        agentId,
        promptId: params.promptId,
        authorLogin: params.authorLogin
      })
    )
  }
  return { runs, skipped }
}

// Cap the in-memory capture so a runaway agent can't bloat the main process or
// produce an unpostable body.
const MAX_CAPTURE = 4 * 1024 * 1024

/**
 * Signals the agent's whole process GROUP (it is spawned detached, so its pid is
 * the group leader). This reaches grandchildren — e.g. the MCP-server workers a
 * real Codex run spawns — which a bare child.kill() would orphan.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
  }
}

async function execute(
  runId: number,
  params: StartRunParams,
  agent: Agent,
  repo: RepoRow,
  tokenBlob: Buffer,
  agents: Agent[]
): Promise<void> {
  // The concurrency slot acquired below (before any heavy work) is released exactly
  // once on every terminal path via this guard. `slotAcquired` guards against an early
  // terminal path (e.g. the exec-consent refusal) releasing a slot it never took.
  let slotReleased = false
  let slotAcquired = false
  const releaseSlot = (): void => {
    if (slotReleased || !slotAcquired) return
    slotReleased = true
    runSlots.release()
  }

  // The full console transcript (stdout+stderr+system) is buffered live so a
  // re-opened panel (or the History view) can show progress for a RUNNING run;
  // on finish it is persisted to <id>.log. The clean review goes to <id>.out.
  const emit = (stream: 'stdout' | 'stderr' | 'system', chunk: string): void => {
    const prev = liveTranscripts.get(runId) ?? ''
    const next = prev + chunk
    liveTranscripts.set(runId, next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next)
    noteOutput({ runId, stream, chunk })
  }
  const finish = (status: RunStatus, exitCode: number | null, outputPath: string | null): void => {
    updateRunStatus(runId, { status, exitCode, finishedAt: new Date().toISOString(), outputPath })
    noteStatus(runId, status, { exitCode, outputPath })
  }

  const runsDir = join(app.getPath('userData'), 'runs')
  let prepared: PreparedCheckout | null = null
  let promptFile: string | null = null
  // True once the agent process is actually spawned, so the reliability gate (M-Q)
  // assesses only real review ATTEMPTS — not the deliberate "nothing to review"
  // short-circuit (empty working tree), which never spawns an agent.
  let agentSpawned = false

  // Free the run's worktree + diff + prompt once it has terminated (the durable
  // review stays in runs/<id>.out). Runs after the process tree is dead, so file
  // handles are released. Fire-and-forget; cleanup must never throw.
  const cleanup = (): void => {
    const p = prepared
    const pf = promptFile
    prepared = null
    promptFile = null
    if (p) void cleanupCheckout(p)
    try {
      if (pf) rmSync(pf, { force: true })
      // the agent's {{outFile}} (e.g. codex -o) is redundant once captured to .out
      rmSync(join(runsDir, `${runId}.agentout`), { force: true })
    } catch {
      /* ignore */
    }
  }

  // Always reach a terminal state: persist output (best-effort) then finish+clean.
  const finalize = (status: RunStatus, exitCode: number | null, output: string): void => {
    // For an LLM agent run, split the prose review from its machine-readable findings
    // block (M8/M9): the clean prose becomes the .out (and the posted comment), the
    // findings are persisted. Tool runs keep their raw machine output as-is.
    let reviewBody = output
    let agentFindings: Finding[] = []
    if (agent.kind !== 'tool') {
      const parsed = parseAgentFindings(agent.id, output)
      reviewBody = parsed.prose
      agentFindings = parsed.findings
    }

    // Scrub secrets before anything is written to disk: GitHub tokens always, plus the
    // matched secret values a gitleaks tool run surfaced. (Findings below are parsed
    // from the RAW output; the gitleaks parser already drops secrets.)
    const extraSecrets = agent.kind === 'tool' ? extractSecrets(agent.id, output) : []
    const scrub = (text: string): string => redactText(text, extraSecrets)

    let outputPath: string | null = null
    try {
      mkdirSync(runsDir, { recursive: true })
      outputPath = join(runsDir, `${runId}.out`)
      writeFileSync(outputPath, scrub(reviewBody), 'utf8')
    } catch (e) {
      outputPath = null
      const message = e instanceof Error ? e.message : String(e)
      log.error('failed to save run output', { runId, error: message })
      emit('system', `\n[aerie] could not save output: ${message}\n`)
      status = 'error'
    }
    // Persist the full console transcript for later viewing (History / re-open).
    try {
      const transcript = liveTranscripts.get(runId)
      if (transcript !== undefined)
        writeFileSync(join(runsDir, `${runId}.log`), scrub(transcript), 'utf8')
    } catch {
      /* transcript is best-effort */
    }
    // Persist structured findings. A deterministic TOOL run is parsed from its machine
    // output and scoped to the changed lines (it scans the whole tree); an LLM AGENT
    // run uses the findings it emitted in its block (already about the reviewed change,
    // so not re-scoped). Best-effort — must never break the run.
    try {
      let findings: Finding[]
      if (agent.kind === 'tool') {
        findings = parseToolOutput(agent.id, output)
        const diffPath = prepared?.diffPath
        if (diffPath && existsSync(diffPath)) {
          const ranges = parseChangedLineRanges(readFileSync(diffPath, 'utf8'))
          if (ranges.size > 0) findings = scopeToChanges(findings, ranges)
        }
      } else {
        // Agent findings are free text — scrub any echoed secret (and re-fingerprint)
        // before persisting, mirroring the prose path; tool parsers already drop secrets.
        findings = agentFindings.map((f) => redactFinding(f, scrub))
      }
      insertFindings(runId, findings)
    } catch (e) {
      log.warn('could not persist findings', {
        runId,
        error: e instanceof Error ? e.message : String(e)
      })
    }
    // Reliability gate (M-Q): an LLM review that exits 0 can still be empty, truncated,
    // or a leaked transcript. Flag it in the transcript so the user sees it isn't a real
    // review (and so the future auto-post path, M9, can refuse to publish it). Assessed
    // on the PROSE (block stripped). The exit status is unchanged — advisory, not a fail.
    if (agentSpawned && agent.kind !== 'tool' && status === 'done') {
      const quality = assessReviewQuality(reviewBody, { kind: 'agent' })
      // A block-only response (real findings, terse/empty prose) isn't low-quality.
      if (quality.level === 'low' && agentFindings.length === 0) {
        emit('system', `\n[aerie] ⚠ low-quality review: ${quality.reasons.join(' ')}\n`)
      }
    }
    liveTranscripts.delete(runId)
    finish(status, exitCode, outputPath)
    cleanup()
    releaseSlot()
  }

  // Exec-consent gate (M12 — the core trust boundary): a user-authored/edited agent's
  // command is arbitrary local code and must be explicitly approved before it is EVER
  // spawned. Author-shipped templates/catalog are implicitly trusted. Enforced HERE, in
  // main, at the spawn boundary — never relying on the renderer. Refuse (don't queue or
  // spawn) when consent is missing or no longer matches the current command.
  if (agentBlocked(agent)) {
    emit(
      'system',
      `[aerie] "${agent.id}" is not approved to run. Approve its command in the Tools tab before Aerie will spawn it.\n`
    )
    finalize(
      'error',
      null,
      `[aerie] "${agent.id}" needs approval before it can run. Approve its command in the Tools tab, then re-run.`
    )
    return
  }

  // Wait for a concurrency slot before any heavy work (clone/fetch/spawn). The run
  // stays 'queued' until one frees; announce a real wait so it isn't read as a stall.
  if (runSlots.active() >= MAX_CONCURRENT_RUNS) {
    emit('system', '[aerie] waiting for a free run slot…\n')
  }
  await runSlots.acquire()
  slotAcquired = true

  try {
    updateRunStatus(runId, { status: 'running' })
    noteStatus(runId, 'running')

    // For a PR, diff the WHOLE PR (merge-base..head), not just its head commit.
    // The base SHA is resolved authoritatively from GitHub, never renderer-supplied.
    let prBaseSha: string | undefined
    if (params.refType === 'working-tree') {
      // Review the user's UNCOMMITTED changes in their mapped clone — no checkout, no
      // worktree, no GitHub call, never mutating the working copy. Hard-requires a
      // mapped local path (the changes exist only there).
      if (!repo.user_local_path) {
        throw new Error('Map a local clone for this repository to review its working tree.')
      }
      emit('system', '[aerie] preparing working-tree diff (read-only, no checkout)…\n')
      prepared = await prepareWorkingTree({
        fullName: repo.full_name,
        userLocalPath: repo.user_local_path,
        runTag: String(runId),
        staged: params.refId === 'staged'
      })
    } else {
      emit('system', '[aerie] preparing local checkout…\n')
      if (params.refType === 'pr') {
        const prNumber = Number(params.refId)
        if (Number.isInteger(prNumber) && prNumber > 0) {
          try {
            prBaseSha = await getPullRequestBaseSha(params.accountId, repo.full_name, prNumber)
          } catch (e) {
            emit(
              'system',
              `[aerie] could not resolve PR base — diffing the head commit only: ${
                e instanceof Error ? e.message : String(e)
              }\n`
            )
          }
        }
      }

      prepared = await prepareCheckout({
        fullName: repo.full_name,
        sha: params.sha,
        remoteUrl: repo.remote_url!,
        runTag: String(runId),
        token: decryptToken(tokenBlob),
        userLocalPath: repo.user_local_path,
        useLocalWorktree: repo.use_local_worktree === 1,
        baseSha: prBaseSha
      })
    }

    // The diff content (read once) drives both {{changedFiles}} and pre-run grounding.
    let diffContent = ''
    try {
      if (existsSync(prepared.diffPath)) diffContent = readFileSync(prepared.diffPath, 'utf8')
    } catch {
      /* best-effort */
    }
    const changedFiles = [...parseChangedLineRanges(diffContent).keys()]

    // A working-tree review with a clean tree has nothing to review — don't burn an
    // agent invocation on an empty diff. (Commit/PR refs always have a non-empty diff.)
    if (params.refType === 'working-tree' && diffContent.trim() === '') {
      const which = params.refId === 'staged' ? 'staged' : 'uncommitted'
      emit('system', `[aerie] no ${which} changes to review — nothing to do.\n`)
      finalize('done', 0, `[aerie] No ${which} changes in the working tree to review.`)
      return
    }

    // Ground an LLM review on deterministic local-tool findings (best-effort): run the
    // installed, repo-relevant quality tools on the change and give the agent their
    // findings to confirm/refute/merge instead of hallucinating. Never blocks the run;
    // tools never get the GitHub token; gitleaks findings carry no secret value.
    // Opt-out (default ON): a user reviewing untrusted PRs can disable pre-run tool
    // execution without disabling the LLM review (Settings → "Ground reviews…").
    let groundTruth = ''
    if (agent.kind !== 'tool' && getSetting('ui.groundReviews') !== '0') {
      try {
        emit('system', '[aerie] grounding: running local quality tools…\n')
        const g = await gatherGroundTruth({
          agents,
          cwd: prepared.worktreePath,
          diff: diffContent,
          diffFile: prepared.diffPath,
          changedFiles,
          // Exec-consent (M12): never auto-run a user-authored kind:'tool' agent that
          // hasn't been approved — the same boundary the direct-run path enforces.
          isAllowed: (a) => !agentBlocked(a)
        })
        groundTruth = g.groundTruth
        emit(
          'system',
          `[aerie] grounding: ${g.findingsCount} finding(s) from ${g.toolsRun} tool(s)${
            g.rawCount > g.findingsCount ? ` (${g.rawCount - g.findingsCount} filtered)` : ''
          }${g.toolsSkipped > 0 ? ` (${g.toolsSkipped} relevant tool(s) skipped by cap)` : ''}.\n`
        )
      } catch (e) {
        emit('system', `[aerie] grounding skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      }
    }

    // A selected prompt supplies the review INSTRUCTIONS; the machine context
    // (repo/sha/paths) is always prepended by buildPrompt. Falls back to the
    // built-in default when no prompt is chosen or the id no longer exists.
    const instructions = params.promptId != null ? getPrompt(params.promptId)?.body : undefined
    const promptText = buildPrompt(
      {
        fullName: repo.full_name,
        refType: params.refType,
        refId: params.refId,
        sha: params.sha,
        repoPath: prepared.worktreePath,
        diffFile: prepared.diffPath,
        changedFiles,
        groundTruth
      },
      instructions
    )

    mkdirSync(runsDir, { recursive: true })
    promptFile = join(runsDir, `${runId}.prompt.txt`)
    // Scrub the prompt file like the other on-disk artifacts (the grounding block is
    // already secret-free since parsers drop secret values; this also catches any
    // token in the instructions and keeps the invariant consistent).
    writeFileSync(promptFile, redactText(promptText), 'utf8')

    const vars: Record<string, string> = {
      repoPath: prepared.worktreePath,
      promptFile,
      diffFile: prepared.diffPath,
      outFile: join(runsDir, `${runId}.agentout`),
      model: resolveModel(agent),
      reasoning: resolveReasoning(agent),
      // Working-tree changes are measured against HEAD (params.sha); commit/PR runs
      // use the PR base or the commit's first parent.
      baseSha: params.refType === 'working-tree' ? params.sha : (prBaseSha ?? `${params.sha}^`),
      headSha: params.sha,
      changedFiles: changedFiles.join('\n'),
      prompt: promptText
    }

    const args = agent.args.map((a) => substitute(a, vars))
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [k, v] of Object.entries(agent.env)) env[k] = substitute(v, vars)
    // The GitHub token is never exposed to the agent process.

    emit('system', `[aerie] running: ${agent.command} (agent "${agent.id}")\n`)

    // detached → the child leads its own process group so killTree reaches its
    // subprocesses. Not unref'd: we still track and reap it.
    const child = spawn(agent.command, args, { cwd: prepared.worktreePath, env, detached: true })
    agentSpawned = true
    running.set(runId, child)

    let captured = ''
    let truncated = false
    const append = (d: string): void => {
      if (truncated) return
      if (captured.length + d.length > MAX_CAPTURE) {
        captured += d.slice(0, Math.max(0, MAX_CAPTURE - captured.length))
        captured += `\n[aerie] output truncated at ${MAX_CAPTURE} bytes\n`
        truncated = true
      } else {
        captured += d
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (agent.outputCapture === 'stdout') append(d)
      emit('stdout', d)
    })
    child.stderr?.on('data', (d: string) => emit('stderr', d))

    // An agent that exits before reading stdin would make write()/end() emit EPIPE.
    child.stdin?.on('error', (e) => emit('system', `[aerie] stdin write failed: ${e.message}\n`))
    if (agent.promptDelivery === 'stdin') {
      child.stdin?.write(promptText)
    }
    child.stdin?.end()

    let killedByTimeout = false
    let graceTimer: NodeJS.Timeout | null = null
    const timer = setTimeout(() => {
      killedByTimeout = true
      emit('system', `\n[aerie] timeout after ${agent.timeoutSec}s — killing agent.\n`)
      killTree(child, 'SIGTERM')
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), 3000)
    }, agent.timeoutSec * 1000)

    child.on('error', (err) => {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      running.delete(runId)
      emit('system', `\n[aerie] failed to start agent: ${err.message}\n`)
      finalize('error', null, captured)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      running.delete(runId)
      let output = captured
      if (agent.outputCapture === 'file') {
        if (!agent.outputFile) {
          emit('system', '\n[aerie] agent uses outputCapture "file" but declares no outputFile.\n')
          finalize('error', code ?? null, '[aerie] no output file configured.')
          return
        }
        const file = substitute(agent.outputFile, vars)
        try {
          if (!existsSync(file)) throw new Error('declared output file not found')
          output = readFileSync(file, 'utf8')
        } catch (e) {
          emit('system', `\n[aerie] could not read output file: ${(e as Error).message}\n`)
          finalize('error', code ?? null, `[aerie] ${(e as Error).message}`)
          return
        }
      }
      const status: RunStatus = runStatusForExit(
        code ?? null,
        killedByTimeout,
        agent.successExitCodes
      )
      emit('system', `\n[aerie] agent exited with code ${code ?? 'null'} → ${status}\n`)
      finalize(status, code ?? null, output)
    })
  } catch (err) {
    running.delete(runId)
    const message = err instanceof Error ? err.message : 'Run failed.'
    emit('system', `\n[aerie] error: ${message}\n`)
    finish('error', null, null)
    cleanup()
    releaseSlot()
  }
}

/** Kills a running agent (whole process group). Returns true if one was signalled. */
export function killRun(runId: number): boolean {
  const child = running.get(runId)
  if (!child) return false
  killTree(child, 'SIGTERM')
  setTimeout(() => killTree(child, 'SIGKILL'), 3000)
  return true
}

export function hasRunningAgents(): boolean {
  return running.size > 0
}

/**
 * True if any run is queued OR running (per the hub), not just spawned. The quit
 * drain gates on this so a run that is queued/preparing but has not spawned its
 * child yet still gets the shutdown grace window.
 */
export function hasActiveRuns(): boolean {
  return activeCount() > 0
}

/** Signals every in-flight agent's process group (used on app quit). */
export function killAllRuns(): void {
  const children = [...running.values()]
  for (const child of children) killTree(child, 'SIGTERM')
  setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL')
  }, 2000).unref()
}

export function readRunOutput(outputPath: string): string {
  return existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
}

/**
 * The full console transcript for a run: the live buffer while running, else the
 * persisted <id>.log, else the clean <id>.out. Used by the UI to show progress
 * (running) or the recorded log (finished), incl. from History.
 */
export function getRunTranscript(runId: number, outputPath: string | null): string {
  const live = liveTranscripts.get(runId)
  if (live !== undefined) return live
  const logPath = join(app.getPath('userData'), 'runs', `${runId}.log`)
  if (existsSync(logPath)) return readFileSync(logPath, 'utf8')
  return outputPath ? readRunOutput(outputPath) : ''
}

export function listRunRecords(repoId: number): RunRecord[] {
  return listRunsForRepo(repoId).map(rowToRecord)
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])

function rowToFinding(f: ReturnType<typeof listFindingsForRun>[number]): Finding {
  return {
    tool: f.tool,
    ruleId: f.rule_id,
    severity: (SEVERITIES.has(f.severity) ? f.severity : 'medium') as Finding['severity'],
    file: f.file,
    line: f.line,
    message: f.message,
    fingerprint: f.fingerprint
  }
}

/** A run's persisted structured findings (tool output or an agent's findings block). */
export function listRunFindings(runId: number): RunFinding[] {
  return listFindingsForRun(runId).map((f) => ({
    tool: f.tool,
    ruleId: f.rule_id,
    severity: (SEVERITIES.has(f.severity) ? f.severity : 'medium') as RunFinding['severity'],
    file: f.file,
    line: f.line,
    message: f.message
  }))
}

/**
 * Cross-agent consensus (M8/M9): aggregate the persisted findings ACROSS several runs
 * (a panel) into one list, tagged with how many distinct agents/tools flagged each.
 * `groupBy:'location'` (file+line) is the robust default for agents that phrase the same
 * problem differently; `consensusMin` keeps only issues enough sources agree on.
 */
export function aggregateRunFindings(params: ConsensusParams): ConsensusResult {
  const all: Finding[] = []
  for (const id of params.runIds) {
    for (const row of listFindingsForRun(id)) all.push(rowToFinding(row))
  }
  const agg = aggregateFindings(all, {
    consensusMin: params.consensusMin,
    minSeverity: params.minSeverity,
    groupBy: params.groupBy
  })
  return {
    total: all.length,
    findings: agg.kept.map((k, i) => ({
      tool: k.tool,
      ruleId: k.ruleId,
      severity: k.severity,
      file: k.file,
      line: k.line,
      message: k.message,
      agreement: agg.agreement[i]
    }))
  }
}

export function listAllRunHistory(): RunHistoryItem[] {
  return listAllRuns().map((r) => ({
    ...rowToRecord(r),
    repoFullName: r.full_name,
    accountId: r.account_id
  }))
}
