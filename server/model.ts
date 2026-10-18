// Project data model. Everything a project needs to be reopened, audited and exported lives in project.json;
// binary files live next to it under assets/ and are named by their sha256, so an asset is never rewritten.

export const CUT_COUNT = 6;
export const SCHEMA_VERSION = 1;

export type ShotSize = 'extreme-wide' | 'wide' | 'full' | 'medium' | 'close-up' | 'extreme-close-up';

export interface Asset {
  sha256: string; // also the file name: assets/<sha256>.<ext>
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

export interface Traits {
  name: string;
  hair: string;
  outfit: string;
  props: string;
  notes: string;
}

/** An approved, immutable snapshot of the character baseline. */
export interface CharacterVersion {
  id: string;
  number: number;
  createdAt: string;
  traits: Traits;
  faceRef: Asset;
  bodyRef: Asset;
}

/** Editable baseline that becomes a CharacterVersion when approved. */
export interface CharacterDraft {
  traits: Traits;
  faceRef?: Asset;
  bodyRef?: Asset;
}

export interface Scene {
  location: string;
  action: string;
  expression: string;
  shot: ShotSize;
  /** Optional lighting / mood, e.g. "soft morning light, calm". */
  lighting?: string;
}

export interface Checklist {
  face?: boolean;
  hair?: boolean;
  outfit?: boolean;
  props?: boolean;
  scene?: boolean;
  /** Edits only: the edit instruction was carried out. */
  instruction?: boolean;
}

export interface Review {
  reviewer: string;
  at: string;
  checklist: Checklist;
  note: string;
}

export interface GenerationRecord {
  backend: string;
  model: { diffusion: string; textEncoder: string; vae: string };
  workflow: { id: 'generate' | 'edit'; version: string };
  /** Model preset (distilled, base, gguf). Missing in records made before presets existed. */
  preset?: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  /** Reference images in the order the prompt refers to them (image 1, image 2, ...). */
  references: { role: string; sha256: string }[];
  /** The exact API-format graph submitted to ComfyUI (null for the mock backend). */
  graph: Record<string, unknown> | null;
  durationMs: number;
  /** Whether the backend had to load model weights for this run (see Phases in backends/types.ts). */
  coldStart: boolean;
  phases?: { queueMs?: number; prepareMs?: number; sampleMs?: number; finishMs?: number; runMs?: number };
}

export interface Candidate {
  id: string;
  createdAt: string;
  kind: 'generate' | 'edit';
  /** For edits: the candidate that was edited. */
  parentId?: string;
  instruction?: string;
  /** For masked edits: white = area that was allowed to change. Pixels outside it are copied from the parent. */
  mask?: Asset;
  characterVersionId: string;
  image: Asset;
  generation: GenerationRecord;
  reviews: Review[];
}

export interface ApprovalEvent {
  at: string;
  candidateId: string | null;
  action: 'approve' | 'unapprove' | 'restore';
}

export interface Cut {
  id: string;
  index: number;
  scene: Scene;
  backgroundRef?: Asset;
  propRef?: Asset;
  candidates: Candidate[];
  approvedCandidateId: string | null;
  approvals: ApprovalEvent[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  cutId: string;
  kind: 'generate' | 'edit';
  /** For edits. */
  sourceCandidateId?: string;
  instruction?: string;
  mask?: Asset;
  /** Fixed when the job first starts, so a resumed job reproduces the same request. */
  seed?: number;
  /** ComfyUI prompt id, recorded before submission so an app restart can adopt the in-flight result. */
  backendJobId?: string;
  characterVersionId: string;
  status: JobStatus;
  error?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  candidateId?: string;
}

export interface Project {
  schemaVersion: number;
  id: string;
  title: string;
  style: string;
  aspect: '16:9';
  createdAt: string;
  updatedAt: string;
  draft: CharacterDraft;
  versions: CharacterVersion[];
  cuts: Cut[];
  jobs: Job[];
}

export function emptyTraits(): Traits {
  return { name: '', hair: '', outfit: '', props: '', notes: '' };
}

export function currentVersion(p: Project): CharacterVersion | undefined {
  return p.versions.at(-1);
}

export function approvedCandidate(cut: Cut): Candidate | undefined {
  return cut.candidates.find((c) => c.id === cut.approvedCandidateId);
}

/** An approved cut is stale when it was made from an older character baseline than the current one. */
export function isStale(p: Project, cut: Cut): boolean {
  const approved = approvedCandidate(cut);
  const current = currentVersion(p);
  return !!approved && !!current && approved.characterVersionId !== current.id;
}

/** Stale and not yet refreshed: no candidate edited from the approved one under the current baseline exists. */
export function needsRefresh(p: Project, cut: Cut, refreshInstruction: string): boolean {
  if (!isStale(p, cut)) return false;
  const current = currentVersion(p)!;
  return !cut.candidates.some((c) => c.parentId === cut.approvedCandidateId
    && c.characterVersionId === current.id && c.instruction === refreshInstruction);
}
