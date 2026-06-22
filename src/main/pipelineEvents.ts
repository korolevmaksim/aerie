// Pipeline run-status hub (ROADMAP M9a). A tiny in-process EventEmitter that the engine
// adapter fires on every pipeline_run insert / status change / post, and the IPC bridge
// fans out to the renderer (the Automate UI live-updates). No Electron imports — stays
// unit-testable in plain Node, like `runEvents`. The payload is token-free (run metadata only).

import { EventEmitter } from 'events'
import type { PipelineRunChange } from '../shared/types'

const bus = new EventEmitter()
// The IPC bridge subscribes; the default cap (10) is plenty but set explicitly for safety.
bus.setMaxListeners(50)

const CHANGE = 'pipeline-run-change'

/** Records a pipeline-run change (insert / status transition / posted). */
export function emitPipelineRunChange(change: PipelineRunChange): void {
  bus.emit(CHANGE, change)
}

/** Subscribe to pipeline-run changes (the renderer fan-out). Returns an unsubscribe fn. */
export function onPipelineRunChange(cb: (change: PipelineRunChange) => void): () => void {
  bus.on(CHANGE, cb)
  return () => bus.off(CHANGE, cb)
}

/** Test/maintenance helper — clears all subscribers. */
export function resetPipelineEvents(): void {
  bus.removeAllListeners()
  bus.setMaxListeners(50)
}
