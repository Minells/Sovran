import { createHash } from 'node:crypto';

/** The image's name in the image store: the SHA-256 of its bytes, so the same image is stored once per chat. */
export function imageId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
