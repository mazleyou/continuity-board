import { createHash } from 'node:crypto';
// Builds the ComfyUI graphs for both workflows from the official
// "image_flux2_klein_image_edit_4b_distilled" template, generalized to N reference images:
// every reference is VAE-encoded and chained through ReferenceLatent on both the positive
// conditioning and its negative, exactly as the template's "Reference Conditioning" subgraph does.
// With cfg 1 ComfyUI skips the negative pass, so the negative chain only matters for the Base preset.

export const WORKFLOW_VERSION = '1.1.0';

export type PresetName = 'distilled' | 'base' | 'gguf';

interface Preset { loader: 'safetensors' | 'gguf'; diffusion: string; textEncoder: string; steps: number; cfg: number }

const PRESETS: Record<PresetName, Preset> = {
  // Apple Silicon (MPS) cannot dequantize fp8, so macOS defaults to the bf16 release of the same model.
  distilled: {
    loader: 'safetensors',
    diffusion: process.platform === 'darwin' ? 'flux-2-klein-4b.safetensors' : 'flux-2-klein-4b-fp8.safetensors',
    textEncoder: 'qwen_3_4b.safetensors', steps: 4, cfg: 1,
  },
  // Undistilled model for quality comparison; settings follow the official image_flux2_klein_image_edit_4b_base template.
  base: { loader: 'safetensors', diffusion: 'flux-2-klein-base-4b.safetensors', textEncoder: 'qwen_3_4b.safetensors', steps: 20, cfg: 5 },
  // Quantized weights through the ComfyUI-GGUF custom node, for machines with little memory.
  gguf: { loader: 'gguf', diffusion: 'flux-2-klein-4b-Q8_0.gguf', textEncoder: 'Qwen3-4B-Q8_0.gguf', steps: 4, cfg: 1 },
};

export const PRESET_NAME: PresetName = (Object.keys(PRESETS) as PresetName[]).includes(process.env.CB_PRESET as PresetName)
  ? process.env.CB_PRESET as PresetName : 'distilled';
const preset = PRESETS[PRESET_NAME];

export const MODELS = {
  diffusion: process.env.CB_DIFFUSION_MODEL ?? preset.diffusion,
  textEncoder: process.env.CB_TEXT_ENCODER ?? preset.textEncoder,
  vae: process.env.CB_VAE ?? 'flux2-vae.safetensors',
};
export const LOADER = preset.loader;
export const FRAME = { width: 1344, height: 768 }; // 16:9-ish, multiples of 16, ~1 MP
export const STEPS = Number(process.env.CB_STEPS ?? preset.steps);
export const CFG = Number(process.env.CB_CFG ?? preset.cfg);

type Link = [string, number];
type Inputs = Record<string, string | number | boolean | Link>;
export type ApiGraph = Record<string, { class_type: string; inputs: Inputs; _meta?: { title: string } }>;

export interface GraphReference {
  /** File name as already uploaded to ComfyUI's input directory. */
  image: string;
  /** Pixels the reference is scaled to before encoding. BFL caps multi-reference inputs at ~1 MP. */
  megapixels: number;
}

export interface GraphParams {
  prompt: string;
  /** In prompt order (image 1, image 2, ...). */
  references: GraphReference[];
  seed: number;
  width?: number;
  height?: number;
  filenamePrefix?: string;
  /**
   * Masked edit: sample only inside the mask (white) and keep reference 1's latent elsewhere.
   * Reference 1 must already be width × height.
   */
  inpaintMask?: string;
  /** 'save' writes to ComfyUI's output folder (templates); 'preview' uses its temp folder, cleared on restart. */
  output?: 'save' | 'preview';
}

export function buildGraph(params: GraphParams): ApiGraph {
  const { prompt, references, seed } = params;
  const width = params.width ?? FRAME.width;
  const height = params.height ?? FRAME.height;
  const g: ApiGraph = {};
  const add = (id: string, class_type: string, inputs: Inputs, title?: string): Link => {
    g[id] = { class_type, inputs, ...(title ? { _meta: { title } } : {}) };
    return [id, 0];
  };

  const model = LOADER === 'gguf'
    ? add('1', 'UnetLoaderGGUF', { unet_name: MODELS.diffusion })
    : add('1', 'UNETLoader', { unet_name: MODELS.diffusion, weight_dtype: 'default' });
  const clip = LOADER === 'gguf'
    ? add('2', 'CLIPLoaderGGUF', { clip_name: MODELS.textEncoder, type: 'flux2' })
    : add('2', 'CLIPLoader', { clip_name: MODELS.textEncoder, type: 'flux2', device: 'default' });
  const vae = add('3', 'VAELoader', { vae_name: MODELS.vae });
  let positive = add('4', 'CLIPTextEncode', { text: prompt, clip }, 'Prompt');
  // Distilled (cfg 1) never runs the negative pass; Base uses an empty prompt as its negative, like the official template.
  let negative = CFG > 1
    ? add('5', 'CLIPTextEncode', { text: '', clip }, 'Negative (empty)')
    : add('5', 'ConditioningZeroOut', { conditioning: positive });

  references.forEach((ref, i) => {
    const base = 100 + i * 10;
    const loaded = add(`${base}`, 'LoadImage', { image: ref.image }, `Reference image ${i + 1}`);
    const scaled = add(`${base + 1}`, 'ImageScaleToTotalPixels', {
      image: loaded, upscale_method: 'nearest-exact', megapixels: ref.megapixels, resolution_steps: 1,
    });
    const latent = add(`${base + 2}`, 'VAEEncode', { pixels: scaled, vae });
    positive = add(`${base + 3}`, 'ReferenceLatent', { conditioning: positive, latent });
    negative = add(`${base + 4}`, 'ReferenceLatent', { conditioning: negative, latent });
  });

  let latentImage: Link;
  if (params.inpaintMask) {
    const source = add('20', 'VAEEncode', { pixels: ['100', 0], vae }, 'Source latent');
    const maskImage = add('21', 'LoadImage', { image: params.inpaintMask }, 'Edit mask');
    const mask = add('22', 'ImageToMask', { image: maskImage, channel: 'red' });
    latentImage = add('23', 'SetLatentNoiseMask', { samples: source, mask });
  } else {
    latentImage = add('14', 'EmptyFlux2LatentImage', { width, height, batch_size: 1 });
  }

  const guider = add('10', 'CFGGuider', { model, positive, negative, cfg: CFG });
  const sampler = add('11', 'KSamplerSelect', { sampler_name: 'euler' });
  const sigmas = add('12', 'Flux2Scheduler', { steps: STEPS, width, height });
  const noise = add('13', 'RandomNoise', { noise_seed: seed }, 'Seed');
  const samples = add('15', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: latentImage });
  const image = add('16', 'VAEDecode', { samples, vae });
  if (params.output === 'preview') add('17', 'PreviewImage', { images: image }, 'Output');
  else add('17', 'SaveImage', { images: image, filename_prefix: params.filenamePrefix ?? 'continuity-board/cut' }, 'Output');
  return g;
}

// ---- UI (litegraph) format export, so the same graphs open as editable workflows in ComfyUI ----

interface NodeSpec { inputs: [string, string][]; widgets: string[]; outputs: [string, string][] }

const SPECS: Record<string, NodeSpec> = {
  UNETLoader: { inputs: [], widgets: ['unet_name', 'weight_dtype'], outputs: [['MODEL', 'MODEL']] },
  UnetLoaderGGUF: { inputs: [], widgets: ['unet_name'], outputs: [['MODEL', 'MODEL']] },
  CLIPLoaderGGUF: { inputs: [], widgets: ['clip_name', 'type'], outputs: [['CLIP', 'CLIP']] },
  ImageToMask: { inputs: [['image', 'IMAGE']], widgets: ['channel'], outputs: [['MASK', 'MASK']] },
  SetLatentNoiseMask: { inputs: [['samples', 'LATENT'], ['mask', 'MASK']], widgets: [], outputs: [['LATENT', 'LATENT']] },
  CLIPLoader: { inputs: [], widgets: ['clip_name', 'type', 'device'], outputs: [['CLIP', 'CLIP']] },
  VAELoader: { inputs: [], widgets: ['vae_name'], outputs: [['VAE', 'VAE']] },
  CLIPTextEncode: { inputs: [['clip', 'CLIP']], widgets: ['text'], outputs: [['CONDITIONING', 'CONDITIONING']] },
  ConditioningZeroOut: { inputs: [['conditioning', 'CONDITIONING']], widgets: [], outputs: [['CONDITIONING', 'CONDITIONING']] },
  LoadImage: { inputs: [], widgets: ['image', 'upload'], outputs: [['IMAGE', 'IMAGE'], ['MASK', 'MASK']] },
  ImageScaleToTotalPixels: {
    inputs: [['image', 'IMAGE']], widgets: ['upscale_method', 'megapixels', 'resolution_steps'], outputs: [['IMAGE', 'IMAGE']],
  },
  VAEEncode: { inputs: [['pixels', 'IMAGE'], ['vae', 'VAE']], widgets: [], outputs: [['LATENT', 'LATENT']] },
  ReferenceLatent: {
    inputs: [['conditioning', 'CONDITIONING'], ['latent', 'LATENT']], widgets: [], outputs: [['CONDITIONING', 'CONDITIONING']],
  },
  CFGGuider: {
    inputs: [['model', 'MODEL'], ['positive', 'CONDITIONING'], ['negative', 'CONDITIONING']], widgets: ['cfg'], outputs: [['GUIDER', 'GUIDER']],
  },
  KSamplerSelect: { inputs: [], widgets: ['sampler_name'], outputs: [['SAMPLER', 'SAMPLER']] },
  Flux2Scheduler: { inputs: [], widgets: ['steps', 'width', 'height'], outputs: [['SIGMAS', 'SIGMAS']] },
  RandomNoise: { inputs: [], widgets: ['noise_seed', 'control_after_generate'], outputs: [['NOISE', 'NOISE']] },
  EmptyFlux2LatentImage: { inputs: [], widgets: ['width', 'height', 'batch_size'], outputs: [['LATENT', 'LATENT']] },
  SamplerCustomAdvanced: {
    inputs: [['noise', 'NOISE'], ['guider', 'GUIDER'], ['sampler', 'SAMPLER'], ['sigmas', 'SIGMAS'], ['latent_image', 'LATENT']],
    widgets: [], outputs: [['output', 'LATENT'], ['denoised_output', 'LATENT']],
  },
  VAEDecode: { inputs: [['samples', 'LATENT'], ['vae', 'VAE']], widgets: [], outputs: [['IMAGE', 'IMAGE']] },
  SaveImage: { inputs: [['images', 'IMAGE']], widgets: ['filename_prefix'], outputs: [] },
  PreviewImage: { inputs: [['images', 'IMAGE']], widgets: [], outputs: [] },
};

const COLUMN: Record<string, number> = {
  UnetLoaderGGUF: 0, CLIPLoaderGGUF: 0, ImageToMask: 1, SetLatentNoiseMask: 3,
  UNETLoader: 0, CLIPLoader: 0, VAELoader: 0, LoadImage: 0,
  CLIPTextEncode: 1, ImageScaleToTotalPixels: 1, KSamplerSelect: 1, RandomNoise: 1, EmptyFlux2LatentImage: 1, Flux2Scheduler: 1,
  ConditioningZeroOut: 2, VAEEncode: 2,
  ReferenceLatent: 3,
  CFGGuider: 4,
  SamplerCustomAdvanced: 5,
  VAEDecode: 6, SaveImage: 7, PreviewImage: 7,
};

export function toUiWorkflow(api: ApiGraph, title: string) {
  const links: [number, number, number, number, number, string][] = [];
  const rowsPerColumn = new Map<number, number>();
  const nodes = Object.entries(api).map(([id, n]) => {
    const spec = SPECS[n.class_type];
    if (!spec) throw new Error(`no UI spec for ${n.class_type}`);
    const col = COLUMN[n.class_type] ?? 4;
    const row = rowsPerColumn.get(col) ?? 0;
    rowsPerColumn.set(col, row + 1);
    return {
      id: Number(id),
      type: n.class_type,
      pos: [col * 360, row * 150],
      size: [320, n.class_type === 'CLIPTextEncode' ? 200 : 110],
      flags: {},
      order: 0,
      mode: 0,
      title: n._meta?.title,
      inputs: spec.inputs.map(([name, type]) => ({ name, type, link: null as number | null })),
      outputs: spec.outputs.map(([name, type], slot) => ({ name, type, slot_index: slot, links: [] as number[] })),
      properties: { 'Node name for S&R': n.class_type },
      widgets_values: spec.widgets.map((w) => {
        if (w === 'upload') return 'image';
        if (w === 'control_after_generate') return 'fixed';
        return n.inputs[w] as string | number;
      }),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, n] of Object.entries(api)) {
    const target = byId.get(Number(id))!;
    for (const [name, value] of Object.entries(n.inputs)) {
      if (!Array.isArray(value)) continue;
      const slot = target.inputs.findIndex((i) => i.name === name);
      const origin = byId.get(Number(value[0]))!;
      const linkId = links.length + 1;
      const type = target.inputs[slot].type;
      links.push([linkId, origin.id, value[1], target.id, slot, type]);
      target.inputs[slot].link = linkId;
      origin.outputs[value[1]].links.push(linkId);
    }
  }
  // Topological order keeps the frontend's execution order stable.
  const order = topoOrder(api);
  for (const n of nodes) n.order = order.indexOf(String(n.id));
  // Deterministic id (derived from the content) so regenerating unchanged workflows produces no diff.
  const h = createHash('sha256').update(title + JSON.stringify(api)).digest('hex');
  return {
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
    revision: 0,
    last_node_id: Math.max(...nodes.map((n) => n.id)),
    last_link_id: links.length,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { info: { name: title, source: 'continuity-board', workflowVersion: WORKFLOW_VERSION } },
    version: 0.4,
  };
}

function topoOrder(api: ApiGraph): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const v of Object.values(api[id].inputs)) if (Array.isArray(v)) visit(v[0]);
    out.push(id);
  };
  Object.keys(api).forEach(visit);
  return out;
}
