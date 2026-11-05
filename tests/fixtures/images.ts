/**
 * Small images built in code. The PNG is a complete, decodable file (grey pixels); the others carry valid headers,
 * which is all Sovran reads (it never decodes pixels).
 */
import { zlibSync } from 'fflate';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function chunk(type: string, data: Uint8Array): number[] {
  const body = Uint8Array.from([...[...type].map((c) => c.charCodeAt(0)), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** A valid greyscale PNG of the given size. `seed` changes the pixels, so two images differ. */
export function makePng(width: number, height: number, seed = 128): Uint8Array {
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 0, 0, 0, 0]);
  const rows = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) rows.fill(seed & 0xff, y * (width + 1) + 1, (y + 1) * (width + 1));
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibSync(rows)),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

/** A JPEG header (SOI, an APP1 block of `metadataBytes`, SOF0) and EOI: enough to read its size. */
export function makeJpeg(width: number, height: number, metadataBytes = 16): Uint8Array {
  const app1 = [
    0xff,
    0xe1,
    ((metadataBytes + 2) >> 8) & 0xff,
    (metadataBytes + 2) & 0xff,
    ...new Array<number>(metadataBytes).fill(0x45),
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Uint8Array.from([0xff, 0xd8, ...app1, ...sof0, 0xff, 0xd9]);
}

export function makeGif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...[...'GIF89a'].map((c) => c.charCodeAt(0)),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
    0x3b,
  ]);
}

/** A WebP header in one of its three layouts. */
export function makeWebp(width: number, height: number, kind: 'VP8 ' | 'VP8L' | 'VP8X'): Uint8Array {
  const head = (fourcc: string, body: number[]) => [
    ...[...'RIFF'].map((c) => c.charCodeAt(0)),
    0x40,
    0,
    0,
    0,
    ...[...'WEBP'].map((c) => c.charCodeAt(0)),
    ...[...fourcc].map((c) => c.charCodeAt(0)),
    body.length,
    0,
    0,
    0,
    ...body,
  ];
  if (kind === 'VP8 ')
    return Uint8Array.from(
      head(kind, [
        0,
        0,
        0,
        0x9d,
        0x01,
        0x2a,
        width & 0xff,
        (width >> 8) & 0x3f,
        height & 0xff,
        (height >> 8) & 0x3f,
        0,
        0,
      ]),
    );
  if (kind === 'VP8L') {
    const w = width - 1;
    const h = height - 1;
    return Uint8Array.from(
      head(kind, [
        0x2f,
        w & 0xff,
        ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
        (h >> 2) & 0xff,
        (h >> 10) & 0x0f,
        0,
        0,
        0,
      ]),
    );
  }
  const w = width - 1;
  const h = height - 1;
  return Uint8Array.from(
    head(kind, [
      0,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ]),
  );
}
