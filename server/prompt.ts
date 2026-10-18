import type { Asset, CharacterVersion, Cut, Project, ShotSize, Traits } from './model.ts';

// FLUX.2 [klein] reads reference images in order and the prompt refers to them as "image 1", "image 2", ...
// Roles follow the plan: 1 = face & hair, 2 = outfit & full body, 3 = optional background, 4 = optional prop.
//
// Prompt style follows BFL's FLUX.2 guidance: subject first, narrative prose, say what should be there instead of
// negations (FLUX has no negative prompt; "do not X" draws attention to X), end with "Style:" and "Mood:".
// Meta text such as "storyboard frame 3 of 6" is avoided because the model draws it as a framed, numbered panel.

export interface Reference {
  role: 'cut' | 'face' | 'body' | 'background' | 'prop';
  asset: Asset;
}

/** Scale per role: identity references keep BFL's 1 MP multi-reference cap; scenery and props need less detail. */
export const REFERENCE_MEGAPIXELS: Record<Reference['role'], number> = {
  cut: 1, face: 1, body: 1, background: 0.5, prop: 0.5,
};

const SHOT_TEXT: Record<ShotSize, string> = {
  'extreme-wide': 'an extreme wide shot where the person is small within a large environment',
  wide: 'a wide shot showing the whole place and the full figure',
  full: 'a full shot from head to toe',
  medium: 'a medium shot from the waist up',
  'close-up': 'a close-up on the face and shoulders',
  'extreme-close-up': 'an extreme close-up on the face',
};

const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?。]$/.test(t) ? '' : '.'}` : '';
};

function traitProse(t: Traits) {
  return [
    t.hair && `They have ${t.hair}`,
    t.outfit && `they wear ${t.outfit}`,
    t.props && `they carry ${t.props}`,
  ].filter(Boolean).join(', ');
}

export function generationRefs(version: CharacterVersion, cut: Cut): Reference[] {
  const refs: Reference[] = [
    { role: 'face', asset: version.faceRef },
    { role: 'body', asset: version.bodyRef },
  ];
  if (cut.backgroundRef) refs.push({ role: 'background', asset: cut.backgroundRef });
  if (cut.propRef) refs.push({ role: 'prop', asset: cut.propRef });
  return refs;
}

export function generationPrompt(p: Project, version: CharacterVersion, cut: Cut, refs: Reference[]): string {
  const t = version.traits;
  const n = (role: Reference['role']) => refs.findIndex((r) => r.role === role) + 1;
  const s = cut.scene;
  const who = t.name ? `${t.name}, the person from image ${n('face')}` : `The person from image ${n('face')}`;
  return [
    `${who}, maintaining exact likeness of the face and hair, wearing the exact outfit from image ${n('body')}.`,
    sentence(traitProse(t)),
    t.notes && sentence(t.notes),
    // Positive phrasing instead of "only one person": without it the model sometimes draws the character twice.
    `${t.name || 'This character'} appears exactly once in the frame; any other people are clearly different strangers with their own faces and clothes.`,
    s.location && sentence(`The scene takes place at ${s.location}${n('background') > 0 ? `, matching the place in image ${n('background')}` : ''}`),
    !s.location && n('background') > 0 && `The scene takes place in the place shown in image ${n('background')}.`,
    s.action && sentence(`Action: ${s.action}`),
    s.expression && sentence(`Facial expression: ${s.expression}`),
    n('prop') > 0 && `The object from image ${n('prop')} appears in the scene.`,
    sentence(`Framed as ${SHOT_TEXT[s.shot]}, one single full-bleed illustration filling the whole 16:9 frame, set in the described location with a natural new pose`),
    sentence(`Lighting: ${s.lighting || 'natural light that fits the place and time of day'}`),
    sentence(`Style: ${p.style}`),
    s.expression && sentence(`Mood: ${s.expression}`),
  ].filter(Boolean).join(' ');
}

export function editRefs(version: CharacterVersion, source: Asset): Reference[] {
  return [
    { role: 'cut', asset: source },
    { role: 'face', asset: version.faceRef },
    { role: 'body', asset: version.bodyRef },
  ];
}

/**
 * Same prompt for full and masked edits. For masked edits the model cannot see the mask; the latent noise mask
 * and the server-side composite decide what may change (tested on the real model: painting the area green in
 * image 1, as the 9B image-extend template does, left visible green edges with 4B Distilled).
 */
export function editPrompt(version: CharacterVersion, instruction: string): string {
  const t = traitProse(version.traits);
  return [
    sentence(`In image 1, ${instruction.trim().replace(/^[A-Z]/, (c) => c.toLowerCase())}`),
    'Keep the composition, camera angle, pose, action, lighting and background of image 1 unchanged.',
    'The person keeps the exact face and hair from image 2 and the outfit from image 3, maintaining exact likeness.',
    t && sentence(t),
  ].filter(Boolean).join(' ');
}

export const REFRESH_INSTRUCTION =
  'redraw the person so the face, hair, outfit and props exactly match the current character baseline in image 2 and image 3';
