import type { ApiGraph } from '../workflow.ts';

export interface Progress {
  /** 0..1 */
  fraction: number;
  phase: string;
}

export interface RunRequest {
  kind: 'generate' | 'edit';
  prompt: string;
  /** In prompt order (image 1, image 2, ...). */
  references: { role: string; sha256: string; bytes: Buffer; megapixels: number }[];
  /** Masked edit: white = may change. Same size as reference 1. */
  inpaintMask?: { sha256: string; bytes: Buffer };
  seed: number;
  width: number;
  height: number;
  label: string;
  /** Backend job id from an earlier, interrupted attempt; the backend adopts it if it is still known. */
  resumeId?: string;
  /** Called with the backend job id before the work is submitted, so it can be persisted. */
  onSubmit?: (id: string) => Promise<void>;
  onProgress?: (p: Progress) => void;
}

/** Where the time went, measured from the backend's execution events (fields are absent when not observable). */
export interface Phases {
  /** Waiting in the backend's own queue. */
  queueMs?: number;
  /** Text/reference encoding, including any model loading that happens before sampling. */
  prepareMs?: number;
  sampleMs?: number;
  /** Decoding and saving. */
  finishMs?: number;
  /** Backend execution time from start to success, by the backend's clock. */
  runMs?: number;
}

export interface RunResult {
  image: Buffer;
  graph: ApiGraph | null;
  /** True when this run had to load model weights (loader nodes executed instead of being cached). */
  coldStart: boolean;
  phases?: Phases;
}

export interface Health {
  ok: boolean;
  backend: string;
  detail: string;
  missingModels?: string[];
}

/** The backend cannot be reached (not running, restarting, network). The job should wait, not fail. */
export class BackendUnavailableError extends Error {}

export class CancelledError extends Error {
  constructor() {
    super('취소되었습니다');
  }
}

export interface Backend {
  readonly name: string;
  health(): Promise<Health>;
  run(req: RunRequest): Promise<RunResult>;
  /** Stops a submitted job; run() then rejects with CancelledError. */
  cancel(id: string): Promise<void>;
  /** Called when the queue drains, to give memory back on small machines. */
  release(): Promise<void>;
}
