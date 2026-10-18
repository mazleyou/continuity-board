import { FRAME, MODELS, PRESET_NAME, STEPS, WORKFLOW_VERSION } from './workflow.ts';
import { REFERENCE_MEGAPIXELS, editPrompt, editRefs, generationPrompt, generationRefs } from './prompt.ts';
import { compositeMasked } from './inpaint.ts';
import { NotFoundError, newId, now, type Store } from './store.ts';
import type { Candidate, Job, Project } from './model.ts';
import { CancelledError, type Backend, type Progress } from './backends/types.ts';

/**
 * One worker for all projects: a single GPU runs one graph at a time.
 * Job state is persisted in project.json. The backend job id is saved before submission, so after an app
 * restart an interrupted job is queued again and adopts the result the backend was still producing.
 */
export class JobRunner {
  private queue: { projectId: string; jobId: string }[] = [];
  private busy = false;
  private running: { projectId: string; jobId: string; backendJobId?: string; cancel?: boolean } | null = null;
  private readonly progress = new Map<string, Progress>();
  private readonly store: Store;
  private readonly backend: Backend;

  constructor(store: Store, backend: Backend) {
    this.store = store;
    this.backend = backend;
  }

  async recover() {
    for (const { id } of await this.store.list()) {
      const queued = await this.store.update(id, (p) => {
        for (const j of p.jobs) if (j.status === 'running') j.status = 'queued';
        return p.jobs.filter((j) => j.status === 'queued').map((j) => j.id);
      });
      for (const jobId of queued) this.queue.push({ projectId: id, jobId });
    }
    this.pump();
  }

  enqueue(projectId: string, jobId: string) {
    this.queue.push({ projectId, jobId });
    this.pump();
  }

  /** Live progress of running jobs (kept in memory only; it changes several times per second). */
  progressOf(jobId: string): Progress | undefined {
    return this.progress.get(jobId);
  }

  /** Cancels a queued or running job. Returns false if the job is not active. */
  async cancel(projectId: string, jobId: string): Promise<boolean> {
    if (this.running?.projectId === projectId && this.running.jobId === jobId) {
      this.running.cancel = true;
      if (this.running.backendJobId) await this.backend.cancel(this.running.backendJobId);
      return true;
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => !(q.projectId === projectId && q.jobId === jobId));
    return this.queue.length < before;
  }

  /** Resolves when the queue is empty and nothing is running (used by tests and scripts). */
  async idle() {
    while (this.busy || this.queue.length) await new Promise((r) => setTimeout(r, 25));
  }

  private async pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    try {
      await this.process(next.projectId, next.jobId);
    } catch {
      // process() records failures on the job; a vanished project is simply skipped
    } finally {
      this.busy = false;
      if (!this.queue.length) await this.backend.release().catch(() => {});
      this.pump();
    }
  }

  private async process(projectId: string, jobId: string) {
    const started = await this.store.update(projectId, (p) => {
      const job = p.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== 'queued') return null;
      job.status = 'running';
      job.startedAt = now();
      job.attempts += 1;
      job.error = undefined;
      job.seed ??= Math.floor(Math.random() * 2 ** 48);
      return structuredClone(p);
    });
    if (!started) return;
    const job = started.jobs.find((j) => j.id === jobId)!;
    this.running = { projectId, jobId, backendJobId: job.backendJobId };
    const t0 = Date.now();
    try {
      const candidate = await this.execute(started, job, t0);
      if (this.running.cancel) throw new CancelledError();
      await this.store.update(projectId, (p) => {
        const cut = p.cuts.find((c) => c.id === job.cutId)!;
        cut.candidates.push(candidate);
        const j = p.jobs.find((x) => x.id === jobId)!;
        j.status = 'done';
        j.finishedAt = now();
        j.candidateId = candidate.id;
      });
    } catch (e) {
      const cancelled = e instanceof CancelledError || this.running?.cancel;
      await this.store.update(projectId, (p) => {
        const j = p.jobs.find((x) => x.id === jobId);
        if (!j) return;
        j.status = cancelled ? 'cancelled' : 'failed';
        j.error = cancelled ? undefined : (e as Error).message;
        j.finishedAt = now();
      }).catch(() => {});
    } finally {
      this.running = null;
      this.progress.delete(jobId);
    }
  }

  private async execute(p: Project, job: Job, t0: number): Promise<Candidate> {
    const cut = p.cuts.find((c) => c.id === job.cutId);
    const version = p.versions.find((v) => v.id === job.characterVersionId);
    if (!cut || !version) throw new NotFoundError('컷 또는 캐릭터 기준을 찾을 수 없습니다');

    let refs, prompt, source;
    if (job.kind === 'edit') {
      source = cut.candidates.find((c) => c.id === job.sourceCandidateId);
      if (!source) throw new NotFoundError('수정할 원본 후보를 찾을 수 없습니다');
      refs = editRefs(version, source.image);
      prompt = editPrompt(version, job.instruction ?? '');
    } else {
      refs = generationRefs(version, cut);
      prompt = generationPrompt(p, version, cut, refs);
    }
    const references = await Promise.all(refs.map(async (r) => ({
      role: r.role, sha256: r.asset.sha256, bytes: await this.store.readAsset(p.id, r.asset), megapixels: REFERENCE_MEGAPIXELS[r.role],
    })));
    const maskBytes = job.mask ? await this.store.readAsset(p.id, job.mask) : undefined;
    const candidateId = newId();
    const result = await this.backend.run({
      kind: job.kind, prompt, references, seed: job.seed!, ...FRAME,
      inpaintMask: maskBytes && job.mask ? { sha256: job.mask.sha256, bytes: maskBytes } : undefined,
      label: `${p.id}_cut${cut.index + 1}_${candidateId}`,
      resumeId: job.backendJobId,
      onSubmit: async (backendJobId) => {
        if (this.running?.cancel) throw new CancelledError();
        if (this.running) this.running.backendJobId = backendJobId;
        await this.store.update(p.id, (q) => {
          const j = q.jobs.find((x) => x.id === job.id);
          if (j) j.backendJobId = backendJobId;
        });
      },
      onProgress: (pr) => this.progress.set(job.id, pr),
    });
    const bytes = maskBytes && source
      ? await compositeMasked(references[0].bytes, result.image, maskBytes)
      : result.image;
    const image = await this.store.putAsset(p.id, bytes);
    return {
      id: candidateId,
      createdAt: now(),
      kind: job.kind,
      parentId: job.sourceCandidateId,
      instruction: job.instruction,
      mask: job.mask,
      characterVersionId: version.id,
      image,
      reviews: [],
      generation: {
        backend: this.backend.name,
        model: { ...MODELS },
        workflow: { id: job.kind, version: WORKFLOW_VERSION },
        preset: PRESET_NAME,
        prompt,
        seed: job.seed!,
        ...FRAME,
        steps: STEPS,
        references: refs.map((r) => ({ role: r.role, sha256: r.asset.sha256 })),
        graph: result.graph,
        durationMs: Date.now() - t0,
        coldStart: result.coldStart,
      },
    };
  }
}
