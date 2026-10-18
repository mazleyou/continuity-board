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

export interface RunResult {
  image: Buffer;
  graph: ApiGraph | null;
  coldStart: boolean;
}

export interface Health {
  ok: boolean;
  backend: string;
  detail: string;
  missingModels?: string[];
}

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
