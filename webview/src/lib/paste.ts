/** Images pasted into the chat input: which clipboard items count, and their bytes for the host. */

/**
 * The image files of a paste, or none when the clipboard also holds text. A screenshot tool puts only the image there;
 * copying from a document or a web page puts text too, and then the text is pasted as it always was.
 */
export function pastedImages(data: Pick<DataTransfer, 'files' | 'types'>): File[] {
  if (data.types.includes('text/plain')) return [];
  return [...data.files].filter((f) => f.type.startsWith('image/'));
}

/** Base64 of a file's bytes, built in chunks so a large screenshot does not overflow the call stack. */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
