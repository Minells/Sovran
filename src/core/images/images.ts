/**
 * Images a vision model can receive. Only the formats OpenAI-compatible servers accept everywhere are sent (PNG,
 * JPEG, WebP, GIF); their dimensions are read from the header, without decoding pixels, for the chip and for the
 * token estimate. Dependency-free, so the webview can use the labels and limits too.
 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export const IMAGE_LIMITS = {
  /** Largest image sent. Servers and gateways commonly cap a request body around 10–20 MB, and base64 adds a third. */
  maxBytes: 8 * 1024 * 1024,
  /** Images in one message. Many local vision models handle only a few per prompt. */
  maxPerMessage: 8,
} as const;

export const IMAGE_LABELS: Record<ImageMime, string> = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
  'image/gif': 'GIF image',
};

export const IMAGE_EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ImageInfo {
  mime: ImageMime;
  width?: number;
  height?: number;
}

const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, i: number) => le16(b, i) | ((b[i + 2] ?? 0) << 16);
const be32 = (b: Uint8Array, i: number) => ((be16(b, i) << 16) >>> 0) + be16(b, i + 2);
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** Width and height when both are plausible; headers of damaged files can say anything. */
function size(width: number, height: number): Pick<ImageInfo, 'width' | 'height'> {
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : {};
}

/** JPEG keeps its size in the first start-of-frame segment, after any metadata (EXIF can be tens of KB). */
function jpegSize(b: Uint8Array): Pick<ImageInfo, 'width' | 'height'> {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return {};
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return size(be16(b, i + 7), be16(b, i + 5));
    }
    i += 2 + be16(b, i + 2);
  }
  return {};
}

function webpSize(b: Uint8Array): Pick<ImageInfo, 'width' | 'height'> {
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const b1 = b[21]!;
    const b2 = b[22]!;
    const b3 = b[23]!;
    const b4 = b[24]!;
    return size(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
  }
  if (ascii(b, 12, 'VP8X')) return size(1 + le24(b, 24), 1 + le24(b, 27));
  return {};
}

/**
 * The format of an image a model can receive, from its signature, and its size when the header gives it (JPEG needs
 * the bytes up to its frame header, so pass the first 64 KB or the whole file). Undefined for anything else,
 * including image formats models do not accept (BMP, TIFF, HEIC…).
 */
export function imageInfo(b: Uint8Array): ImageInfo | undefined {
  if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) {
    return { mime: 'image/png', ...(ascii(b, 12, 'IHDR') ? size(be32(b, 16), be32(b, 20)) : {}) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ...jpegSize(b) };
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))
    return { mime: 'image/gif', ...size(le16(b, 6), le16(b, 8)) };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { mime: 'image/webp', ...webpSize(b) };
  return undefined;
}

/**
 * Tokens an image is likely to cost, for the context budget. Vision models scale large images down (to about
 * 1.5 megapixels) and cost roughly one token per 750 pixels; servers differ, so this is an estimate, and an image of
 * unknown size counts as a large one.
 */
export function estimateImageTokens(info: Pick<ImageInfo, 'width' | 'height'>): number {
  if (!info.width || !info.height) return 1600;
  const scale = Math.min(1, 1568 / Math.max(info.width, info.height));
  const pixels = info.width * scale * (info.height * scale);
  return Math.min(1600, Math.max(85, Math.ceil(pixels / 750)));
}

/** `1280×720`, or '' when the size is unknown. */
export const dimensions = (info: Pick<ImageInfo, 'width' | 'height'>) =>
  info.width && info.height ? `${info.width}×${info.height}` : '';
