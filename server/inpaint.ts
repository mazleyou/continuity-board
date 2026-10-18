import sharp from 'sharp';

// Masked edits are sampled in ComfyUI with SetLatentNoiseMask, but the VAE round trip and 8-bit save
// still shift pixels slightly everywhere. The final image is therefore composited here: outside the
// (slightly grown) mask every byte is copied from the original, so "only the marked area changed" is exact.

const GROW_PX = 8;
const FEATHER_PX = 6;

/** Resizes a user-painted mask to the frame and makes it strictly black/white (white = may change). */
export async function normalizeMask(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const raw = await sharp(bytes).flatten({ background: '#000' }).resize(width, height, { fit: 'fill' }).greyscale().threshold(128).raw().toBuffer();
  if (!raw.some((v) => v > 0)) throw new Error('수정할 영역을 칠하세요');
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/** Alpha used for blending: 255 inside the mask, a soft ramp just outside it, exactly 0 beyond GROW_PX. */
export async function blendAlpha(maskPng: Buffer, width: number, height: number): Promise<Uint8Array> {
  const grown = await sharp(maskPng).resize(width, height, { fit: 'fill' }).greyscale()
    .blur(GROW_PX / 2).threshold(1).raw().toBuffer();
  const soft = await sharp(grown, { raw: { width, height, channels: 1 } }).blur(FEATHER_PX / 2).raw().toBuffer();
  const mask = await sharp(maskPng).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = grown[i] === 0 ? 0 : mask[i] > 127 ? 255 : Math.min(soft[i], 255);
  return alpha;
}

export async function compositeMasked(original: Buffer, generated: Buffer, maskPng: Buffer): Promise<Buffer> {
  const { data: base, info } = await sharp(original).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const top = await sharp(generated).removeAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer();
  const alpha = await blendAlpha(maskPng, width, height);
  const out = Buffer.from(base);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p];
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c;
      out[i] = Math.round((top[i] * a + base[i] * (255 - a)) / 255);
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

