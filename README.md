# Continuity Board

**English** · [한국어](README.ko.md)

**An open-source storyboard that keeps one character consistent across 6 cuts, leaves approved cuts untouched, and fixes only the wrong ones.**

Built for small creators who storyboard short ads, videos, and picture books. It runs on a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with [FLUX.2 [klein] 4B](https://github.com/black-forest-labs/flux2) (Apache-2.0) — open weights only, no cloud APIs. The focus is not character generation itself, but three things around it:

- **The character baseline is versioned.** Changing it keeps already-approved cuts, and cuts made from an older baseline are flagged.
- **Edits are scoped.** An edit only ever adds a new candidate; nothing changes until a person approves it, and earlier results can always be restored.
- **Every generation is reproducible.** Reference images, prompt, seed, model file names, and the exact ComfyUI graph that was submitted are exported with the project.

> **"Locked" means two different things**
> - **Approved cuts are guaranteed by the system.** An approved image file never changes when other cuts are generated or edited. Files are stored under their content hash and never overwritten.
> - **Character consistency is guided, not guaranteed.** References and prompts steer the model, but the output is still a model output.

## Real results

Produced by `npm run smoke:comfy` with the real model on a Mac Studio (M5 Ultra). The two baseline images ([examples/mina](examples/mina/)) are a fictional person made with the same model: the full body from text only, the face close-up from that full-body image. One candidate per cut, approved without cherry-picking.

![The real 6-cut board](docs/images/board.png)

**Masked edit.** Left: original. Middle: painted region (red). Right: the result of `change the red shoulder bag on her left hip to a bright green shoulder bag`. Only the bag inside the painted region turned green; the unpainted red bag on the left stayed red. Zero pixels changed outside the mask, and the file hashes of the other five approved cuts were unchanged.

![Masked edit](docs/images/masked-edit.png)

**Timing** (1344×768, one candidate per cut)

| Task | M5 Ultra 96GB · `distilled` (bf16) | M5 Ultra · `gguf` (Q8_0) | M5 Ultra · `base` | M4 24GB · `distilled` (`--disable-smart-memory`) |
|---|---|---|---|---|
| First cut (incl. model load) | 10–16 s | 13 s | 86 s | 456 s |
| Following cuts | 10–11 s | 10.7 s | 83 s | 227–312 s |
| Edit (3 references) | 15 s | 16 s | 129 s | 405 s |
| Masked edit | 15 s | 16 s | 129 s | — |

Broken down, one `distilled` cut on the M5 Ultra is 1.5 s of preparation (text and reference encoding), 8.3 s of sampling, and 0.2–0.3 s of finishing. The first cut after ComfyUI starts spends 3.2 s preparing because it loads the models (12.3 s total). The app decides whether a run loaded models by whether ComfyUI actually executed the loader nodes (versus using its cache), and records per-phase timing on every candidate, visible in the review dialog and in `evaluation.csv`.

All measurements used ComfyUI 0.39.0 (`e8665ca`). The M4 was nearly out of swap from other apps during measurement. From the preset comparison:

- `gguf` matched bf16 in speed and quality on the M5 Ultra; its advantage is memory use.
- `base` was about 8× slower and not better on this 6-cut sample (one cut showed the person twice, another lost the rain), so it is only used as a comparison during evaluation.

## Quick start

Requires Node.js 23.6+ (runs TypeScript without a build step) and [uv](https://docs.astral.sh/uv/). With nvm, `nvm install && nvm use` picks the version in `.nvmrc` (24). On an older Node, `npm ci` and `npm start` stop immediately and say why. Downloading the models needs about 16 GB of free disk space.

```bash
npm install

# 1) Install ComfyUI and download the models (once)
./scripts/setup-comfyui.sh                 # default location: ~/ComfyUI-Installs/ComfyUI
# Reuse an existing models folder: MODELS_DIR=~/ComfyUI-Shared/models ./scripts/setup-comfyui.sh

# 2) Run ComfyUI (Macs with 32 GB or less need --disable-smart-memory, see below)
~/ComfyUI-Installs/ComfyUI/.venv/bin/python ~/ComfyUI-Installs/ComfyUI/main.py --listen 127.0.0.1 --port 8188 --disable-smart-memory

# 3) Run the app → http://127.0.0.1:5177
npm start
```

To try the UI and flow without a GPU or models:

```bash
npm run start:mock      # makes fake images determined by the inputs and seed
```

The status badge at the top shows which backend is running: ComfyUI connected, MOCK mode, or a ComfyUI problem (such as a missing model, with the exact fix).

> The UI is currently in Korean. The prompts sent to the model are built in English, and scene text can be typed in English or Korean.

### Model files

| File | Folder | Notes |
|---|---|---|
| `flux-2-klein-4b.safetensors` (bf16, 7.8 GB) | `models/diffusion_models/` | **macOS default.** Apple Silicon (MPS) cannot run fp8 |
| `flux-2-klein-4b-fp8.safetensors` (3.9 GB) | `models/diffusion_models/` | Linux/Windows (CUDA) default; same file as the official ComfyUI example |
| `qwen_3_4b.safetensors` | `models/text_encoders/` | The image model's **text encoder**, not a script-writing LLM |
| `flux2-vae.safetensors` | `models/vae/` | |

`setup-comfyui.sh` downloads the right files for your OS.

**On a 24 GB unified-memory Mac**, the bf16 diffusion model (7.8 GB) and the Qwen3 text encoder (7.5 GB) stay resident together, swap fills up, and sampling stalls (observed on an M4 24GB). Running ComfyUI with `--disable-smart-memory` unloads models after each stage and avoids this, at the cost of reloading per cut. A 96 GB machine does not need it.

## How it works

1. **Register the character.** Upload a front face (image 1, face filling about half the frame) and a full body (image 2, head to toe), then enter name, hair, outfit, and props.
2. **Approve the baseline.** The current references and traits become **baseline vN**; every cut is generated from it. "New storyboard with this character" starts a project with the same character already approved as v1. Baselines are compared by content (references and traits), not by version number, so cuts made from a restored baseline count as current again.
3. **Write 6 cuts.** Place, action, expression, shot size, and optional lighting/mood per cut. Reorder with ◀/▶ (scene, candidates and approval move with the cut). Optionally add a background (image 3) and a prop (image 4) reference per cut.
4. **Generate.** "Generate all unapproved cuts" or per-cut "Generate". If ComfyUI is down or restarting, jobs don't fail: a waiting banner appears, the app backs off from 2 s to 30 s, and resumes automatically when ComfyUI is back. 1–3 candidates per cut; jobs run one at a time (single GPU) with live progress (loading → sampling n/4 → finishing), and can be cancelled or retried.
5. **Regenerate with the same seed.** When the composition is right but a detail (like the expression) is off, edit the scene text and regenerate from that candidate's seed. Measured with the real model, same-seed expression changes differed from the original about 2.4× less than a new seed (mean diff 25–32 vs 65–69).
6. **Review and approve.** Compare the approved cut and candidates **side by side** or with a **swipe overlay**. Keyboard: <kbd>←</kbd>/<kbd>→</kbd> cut, <kbd>1</kbd>–<kbd>9</kbd> candidate, <kbd>A</kbd> approve, <kbd>P</kbd> pin as comparison base, <kbd>Z</kbd> synchronized zoom (2–8× with the wheel) so faces can be compared even in wide shots. A checklist (face, hair, outfit, props, scene) records reviews.
7. **Edit.** Pick a candidate and give an instruction such as "change the bag color"; that cut goes in as image 1 and a **new candidate** comes out. Approve it, or restore an earlier one.
   - **Paint a region:** only the painted area is redrawn. Brush, eraser, undo (<kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>), and a true-size cursor. The **rectangle** tool paints with two clicks, so it works without dragging. Pixels outside the painted area stay **byte-identical** to the original.
   - **Update cuts from an older baseline:** after moving to v2, one click creates an update candidate for every cut approved under the old baseline. Approval stays a human decision.
8. **Export.** "Export ZIP" saves the board PNG, approved cuts, project JSON, all references and candidates, per-cut ComfyUI graphs, and an evaluation CSV. The ZIP can be imported on another machine as-is.

"Integrity check" re-hashes every image the project references and shows that approved files have not changed.

Deleted projects go to `data/trash/` first: "Undo" in the toast restores them for 10 seconds, and trash older than 7 days is purged on startup. `project.json` is fsynced on every save with the previous version kept as `project.json.bak`; a torn file is recovered from the backup automatically (the damaged file is kept as `project.json.corrupt-*`), and a project whose backup is also unreadable is listed as "(damaged)" rather than hidden. Unreferenced uploads are garbage-collected after 10 minutes; baseline versions, candidates, masks, and every reference actually used by a generation are kept and exported.

### Input language

Korean and English scene text followed character consistency and scene directions equally well with the same seeds. The difference is the background: Korean text tends to add Korean-style signboards with garbled lettering (English text also garbles signboard letters). Telling the model to avoid signs made them appear more, so the app recommends fixing distracting signs with a masked edit instead.

![English vs Korean input](docs/images/korean-vs-english.jpg)

## ComfyUI workflows

[`workflows/`](workflows/) publishes three workflows in **UI format** (drag into ComfyUI to edit) and **API format** (`POST /prompt`). They generalize the official `image_flux2_klein_image_edit_4b_distilled` template to N references.

```text
A. Reference-based cut generation
   face(1) + full body(2) [+ background(3)] [+ prop(4)]
     → LoadImage → ImageScaleToTotalPixels(1MP) → VAEEncode
     → ReferenceLatent chain (on the positive and on the ConditioningZeroOut negative)
   character traits + style + cut direction → CLIPTextEncode (Qwen3 4B)
     → CFGGuider(cfg 1) + Flux2Scheduler(4 steps) + euler → SamplerCustomAdvanced
     → VAEDecode → 1344×768 cut

B. Edit an existing cut
   cut to edit(1) + face(2) + full body(3) + instruction → same graph → new candidate

C. Masked edit
   cut to edit(1) + face(2) + full body(3) + instruction (same prompt as B)
     → SetLatentNoiseMask(mask) on the original latent so only that region is sampled
     → the app server composites the result over the original (bytes outside the mask unchanged)
```

Background and prop references are encoded at 0.5 MP; face, body, and the cut being edited at 1 MP (BFL recommends 1 MP as the cap with multiple references). Prompts follow BFL's FLUX.2 guide: person first, descriptive, and positive phrasing only (FLUX has no negative prompt).

- Every cut is generated from the **approved original references**, never chained from the previous cut, so drift does not accumulate.
- An edit without a painted region redraws the whole image, so background or face may change.
- `npm run workflows` regenerates `workflows/`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `5177` / `127.0.0.1` | App address |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI address |
| `CB_BACKEND` | `comfyui` | `mock` runs without models |
| `CB_DATA` | `./data` | Project storage |
| `CB_PRESET` | `distilled` | `distilled` (default), `base` (quality comparison), `gguf` (low memory) |
| `CB_DIFFUSION_MODEL` / `CB_TEXT_ENCODER` / `CB_VAE` | preset | Override file names |
| `CB_STEPS` / `CB_CFG` | preset | |
| `CB_TIMEOUT_MS` | `900000` | Per-job timeout |
| `CB_FREE_ON_IDLE` | off | `1` asks ComfyUI to free models (`/free`) when the queue drains |
| `CB_KEEP_COMFY_OUTPUTS` | off | `1` also saves results to ComfyUI's `output/` (default uses ComfyUI's temp folder; results are always saved in the project) |
| `CB_ALLOWED_HOSTS` | (none) | Extra host names allowed besides localhost (comma-separated) |

| Preset | Model | Settings | Install |
|---|---|---|---|
| `distilled` | FLUX.2 [klein] 4B Distilled (bf16 on Mac, fp8 elsewhere) | 4 steps, cfg 1 | default |
| `base` | FLUX.2 [klein] 4B Base | 20 steps, cfg 5, empty-prompt negative (as in the official Base template) | `WITH_BASE=1 ./scripts/setup-comfyui.sh` |
| `gguf` | Q8_0 GGUF diffusion model + Qwen3-4B Q8_0 | 4 steps, cfg 1 (ComfyUI-GGUF custom node) | `WITH_GGUF=1 ./scripts/setup-comfyui.sh` |

### Security

There is no login, so the app blocks other websites from driving it: requests with an unexpected `Host` (DNS rebinding), cross-origin requests, and writes sent as preflight-free content types (`text/plain`, forms). Uploaded references have EXIF rotation applied and all metadata (GPS, camera) stripped, capped at 64 MP / 4096 px. Imports check ZIP entry sizes before extracting (256 MB per file, 3 GB total), only read `project.json` and `assets/`, and verify the structure and every referenced hash before creating the project. The default bind address is `127.0.0.1`.

## Layout

```text
server/
  index.ts          entry point (backend selection, restart recovery)
  app.ts            HTTP API and static files
  model.ts          data model (baseline versions, cuts, candidates, jobs, approval history)
  store.ts          file store: atomic project.json, hash-named assets, integrity check
  jobs.ts           single-GPU job queue: persisted state, progress, cancel, retry, resume after restart
  prompt.ts         reference roles (image 1–4) and prompt building
  workflow.ts       ComfyUI graph building (API format → UI format conversion)
  export.ts         board PNG, ZIP export/import, evaluation CSV
  inpaint.ts        masked edit: mask normalization, original-preserving composite
  backends/         comfy.ts (ComfyUI API + WebSocket progress/cancel/resume), mock.ts
web/                build-free UI (index.html, app.js, style.css)
workflows/          published workflows (UI and API format)
scripts/            setup-comfyui.sh, smoke-comfy.ts (real-model E2E), export-workflows.ts
test/               flow, security and feature tests; backend tests against a fake ComfyUI server
docs/               evaluation guide, 2-minute demo script
```

The app talks to ComfyUI through its own HTTP/WebSocket API (`/upload/image`, `/prompt`, `/ws`, `/history`, `/view`, `/api/jobs/{id}`, `/api/jobs/{id}/cancel`). The UI updates over a server-sent event stream. Job IDs are created and persisted by the app before submission, so an app restart adopts the result ComfyUI was producing instead of discarding it; if the WebSocket drops, results are fetched by polling `/history`. Execution sits behind a single `Backend` interface, so an SDK or Comfy Cloud backend can be added later.

## Tests

```bash
npm test               # mock-backend flows, security, features, backend tests against a fake ComfyUI
npm run typecheck
npm run report         # evaluation report across all projects (also under "평가 보고서" in the app)
npm run smoke:comfy    # real ComfyUI: baseline → 6 cuts → edit → masked edit → integrity → export
```

Among other things, the tests check that generating, editing, or regenerating one cut never changes the file hash of another approved cut; that an unapproved candidate never overwrites an approval; that pixels outside a mask are byte-identical; that jobs resume after an app restart with approvals intact; and that exported ZIPs re-import with matching hashes.

## License

Code in this repository is Apache-2.0. FLUX.2 [klein] **4B** (Distilled and Base) is also Apache-2.0; the 9B and dev variants are non-commercial, so check the license if you switch models.
