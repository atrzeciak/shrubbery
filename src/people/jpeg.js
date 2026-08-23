// Walks JPEG marker segments to the first SOF0/1/2 and reads its dimensions. Null when the
// bytes are not a JPEG or the header is truncated. Not a decoder — the browser did the resizing.
export function jpegSize(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xff) return null;
    const marker = u8[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: (u8[i + 5] << 8) | u8[i + 6], width: (u8[i + 7] << 8) | u8[i + 8] };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}
