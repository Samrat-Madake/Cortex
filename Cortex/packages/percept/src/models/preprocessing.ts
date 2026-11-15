// packages/percept/src/models/preprocessing.ts

// Dynamic import — sharp is optional (Level 0 doesn't need it)
let sharpFn: any = null;
let sharpLoadPromise: Promise<any> | null = null;

async function getSharp(): Promise<any> {
  if (sharpFn) return sharpFn;
  if (!sharpLoadPromise) {
    sharpLoadPromise = import("sharp").then(
      (m) => { sharpFn = m.default ?? m; return sharpFn; },
      () => { sharpLoadPromise = null; return null; },
    );
  }
  const result = await sharpLoadPromise;
  if (!result) {
    throw new Error(
      "sharp is not installed. Install it for Level 1 perception:\n  npm install sharp",
    );
  }
  return result;
}

/**
 * Decode a base64 JPEG frame into raw pixel buffer.
 * Returns { data: Uint8Array (RGB), width, height }.
 */
export async function decodeBase64Frame(
  base64: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const sharp = await getSharp();
  const buf = Buffer.from(base64, "base64");
  const img = sharp(buf).removeAlpha();
  const meta = await img.metadata();
  const raw = await img.raw().toBuffer();
  return {
    data: new Uint8Array(raw),
    width: meta.width!,
    height: meta.height!,
  };
}

/**
 * Resize image to target size with letterbox padding (preserve aspect ratio).
 * Returns resized raw RGB buffer and scale/offset info for coordinate mapping.
 */
export async function resizeAndPad(
  base64: string,
  targetW: number,
  targetH: number,
): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
  scale: number;
  padX: number;
  padY: number;
  origWidth: number;
  origHeight: number;
}> {
  const sharp = await getSharp();
  const buf = Buffer.from(base64, "base64");
  const img = sharp(buf).removeAlpha();
  const meta = await img.metadata();
  const origW = meta.width!;
  const origH = meta.height!;

  const scale = Math.min(targetW / origW, targetH / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.floor((targetW - newW) / 2);
  const padY = Math.floor((targetH - newH) / 2);

  const resized = await sharp(buf)
    .removeAlpha()
    .resize(newW, newH, { fit: "fill" })
    .extend({
      top: padY,
      bottom: targetH - newH - padY,
      left: padX,
      right: targetW - newW - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer();

  return {
    data: new Uint8Array(resized),
    width: targetW,
    height: targetH,
    scale,
    padX,
    padY,
    origWidth: origW,
    origHeight: origH,
  };
}

/**
 * Convert raw RGB pixels to a normalized NCHW Float32 array.
 * Applies (pixel/255 - mean) / std per channel.
 * Returns { data: Float32Array, dims: number[] } instead of ort.Tensor.
 */
export function normalizeImageToTensor(
  pixels: Uint8Array,
  width: number,
  height: number,
  mean: [number, number, number],
  std: [number, number, number],
): { data: Float32Array; dims: number[] } {
  const channels = 3;
  const size = width * height;
  const float32 = new Float32Array(1 * channels * size);

  for (let i = 0; i < size; i++) {
    for (let c = 0; c < channels; c++) {
      const pixelVal = pixels[i * channels + c]! / 255;
      float32[c * size + i] = (pixelVal - mean[c]!) / std[c]!;
    }
  }

  return { data: float32, dims: [1, channels, height, width] };
}

/**
 * Crop a region from a base64 image.
 * Coordinates are in pixel space (x, y, width, height).
 */
export async function cropRegion(
  base64: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const sharp = await getSharp();
  const buf = Buffer.from(base64, "base64");
  const raw = await sharp(buf)
    .removeAlpha()
    .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
    .raw()
    .toBuffer();
  return { data: new Uint8Array(raw), width: Math.round(w), height: Math.round(h) };
}

/**
 * Crop and resize to target dimensions for ReID models.
 */
export async function cropAndResize(
  base64: string,
  x: number,
  y: number,
  w: number,
  h: number,
  targetW: number,
  targetH: number,
): Promise<Uint8Array> {
  const sharp = await getSharp();
  const buf = Buffer.from(base64, "base64");
  const raw = await sharp(buf)
    .removeAlpha()
    .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
    .resize(targetW, targetH, { fit: "fill" })
    .raw()
    .toBuffer();
  return new Uint8Array(raw);
}
