import sharp from 'sharp';

export class ImageError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const ALLOWED = new Set(['jpeg', 'png', 'webp']);

// Validates and re-encodes. Order matters: format and pixel caps are checked
// from the header BEFORE any decode; output drops all metadata (EXIF/GPS).
export async function processImage(buf, limits) {
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: limits.pixels, failOn: 'error' }).metadata();
  } catch {
    throw new ImageError(400, 'invalid_image');
  }
  if (!ALLOWED.has(meta.format)) throw new ImageError(415, 'unsupported_format');
  if (!meta.width || !meta.height || meta.width * meta.height > limits.pixels) {
    throw new ImageError(413, 'image_too_large_dimensions');
  }
  for (const quality of [80, 60, 40]) {
    let out;
    try {
      out = await sharp(buf, { limitInputPixels: limits.pixels, failOn: 'error' })
        .rotate() // apply EXIF orientation, then metadata is dropped by default
        .resize({ width: limits.maxEdge, height: limits.maxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    } catch {
      throw new ImageError(400, 'invalid_image');
    }
    if (out.length <= limits.storedBytes) return { data: out, contentType: 'image/jpeg' };
  }
  throw new ImageError(413, 'image_too_large_after_encode');
}
