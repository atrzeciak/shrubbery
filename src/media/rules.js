import { ApiError } from "../api/common.js";
import { jpegSize } from "../people/jpeg.js";

export const MEDIA_CAP = 6;
export const PHOTO_MAX_BYTES = 2_097_152;
export const DOC_MAX_BYTES = 10_485_760;
export const THUMB_MAX_BYTES = 102_400;
export const PHOTO_MAX_SIDE = 2048;

const bad = () => { throw new ApiError(400, "bad_request"); };

export const isPdf = (u8) => u8.length >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d;

export function checkPhoto(u8) {
  if (u8.length === 0 || u8.length > PHOTO_MAX_BYTES) bad();
  const size = jpegSize(u8);
  if (!size || size.width > PHOTO_MAX_SIDE || size.height > PHOTO_MAX_SIDE) bad();
  return "image/jpeg";
}

// Documents keep archive fidelity: PDFs as-is, JPEG scans at any dimensions within the byte cap.
export function checkDocument(u8, contentType) {
  if (u8.length === 0 || u8.length > DOC_MAX_BYTES) bad();
  if (/^application\/pdf\b/.test(contentType || "") && isPdf(u8)) return "application/pdf";
  if (/^image\/jpeg\b/.test(contentType || "") && jpegSize(u8)) return "image/jpeg";
  bad();
}

export function cleanCaption(v) {
  if (v == null) return null;
  if (typeof v !== "string") bad();
  const s = v.trim();
  if (s.length > 200) bad();
  return s || null;
}

export function cleanYear(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1000 || n > 2999) bad();
  return n;
}
