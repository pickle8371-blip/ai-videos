import fs from 'node:fs/promises';

export type SniffedKind =
  | { family: 'image'; ext: 'png' | 'jpg' | 'webp'; mime: string }
  | { family: 'av'; ext: 'mp4' | 'mov' | 'm4a' | 'webm' | 'mkv' | 'avi' | 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac'; mime: string };

/**
 * Identify a media file by its magic bytes. File extensions and client-sent
 * MIME types are never trusted. Returns null for unsupported files.
 */
export async function sniffFile(file: string): Promise<SniffedKind | null> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return sniffBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function sniffBuffer(b: Buffer): SniffedKind | null {
  const ascii = (start: number, len: number) => b.subarray(start, start + len).toString('latin1');
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return { family: 'image', ext: 'png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { family: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { family: 'image', ext: 'webp', mime: 'image/webp' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { family: 'av', ext: 'wav', mime: 'audio/wav' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return { family: 'av', ext: 'avi', mime: 'video/x-msvideo' };
  const box = ascii(4, 4);
  if (box === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'qt  ') return { family: 'av', ext: 'mov', mime: 'video/quicktime' };
    if (brand === 'M4A ' || brand === 'M4B ') return { family: 'av', ext: 'm4a', mime: 'audio/mp4' };
    return { family: 'av', ext: 'mp4', mime: 'video/mp4' };
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return { family: 'av', ext: 'mov', mime: 'video/quicktime' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const isWebm = b.subarray(0, 64).includes(Buffer.from('webm'));
    return isWebm ? { family: 'av', ext: 'webm', mime: 'video/webm' } : { family: 'av', ext: 'mkv', mime: 'video/x-matroska' };
  }
  if (ascii(0, 3) === 'ID3') return { family: 'av', ext: 'mp3', mime: 'audio/mpeg' };
  if (ascii(0, 4) === 'OggS') return { family: 'av', ext: 'ogg', mime: 'audio/ogg' };
  if (ascii(0, 4) === 'fLaC') return { family: 'av', ext: 'flac', mime: 'audio/flac' };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { family: 'av', ext: 'aac', mime: 'audio/aac' };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { family: 'av', ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}
