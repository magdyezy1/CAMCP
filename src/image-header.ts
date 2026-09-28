/**
 * Facts read from an image's own header bytes rather than from FFmpeg, whose handling differs by version: FFmpeg 5.1
 * (the production image) ignores a JPEG's EXIF orientation while recent builds apply it. AMCP reads the orientation
 * itself, turns FFmpeg's automatic rotation off (`-noautorotate`) and applies `orientationFilter`, so a resized photo
 * comes out the same way up on every version.
 */

/** The EXIF orientation (1 to 8) of a JPEG, or 1 when it states none. */
export function jpegOrientation(bytes: Buffer): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start of scan or end of image: no EXIF comes after the image data starts.
    if (marker === 0xda || marker === 0xd9) return 1;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    if (end > bytes.length || end < offset + 4) return 1;
    if (marker === 0xe1 && end - offset >= 18 && bytes.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0')
      return tiffOrientation(bytes.subarray(offset + 10, end));
    offset = end;
  }
  return 1;
}
function tiffOrientation(tiff: Buffer): number {
  if (tiff.length < 8) return 1;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const u16 = (o: number) => (order === 'II' ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)),
    u32 = (o: number) => (order === 'II' ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  for (let i = 0, count = u16(ifd); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    // Orientation (0x0112) is one SHORT, left-justified in the entry's value field.
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 2) === 3 ? u16(entry + 8) : 0;
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** The FFmpeg filter that turns an image stored with this EXIF orientation the way it is meant to be seen. */
export function orientationFilter(orientation: number): string | undefined {
  return ['hflip', 'hflip,vflip', 'vflip', 'transpose=0', 'transpose=1', 'transpose=3', 'transpose=2'][orientation - 2];
}

/** Whether a PNG can hold transparency: a colour type with alpha, or a tRNS chunk. Unreadable headers count as yes. */
export function pngHasAlpha(bytes: Buffer): boolean {
  if (bytes.length < 33 || bytes.toString('latin1', 12, 16) !== 'IHDR') return true;
  if (bytes[25] === 4 || bytes[25] === 6) return true;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + bytes.readUInt32BE(offset);
  }
  return true;
}
