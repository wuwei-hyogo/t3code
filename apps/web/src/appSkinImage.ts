export type AppSkinImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/avif";

export const APP_SKIN_MAX_BYTES = 32 * 1024 * 1024;
export const APP_SKIN_ACCEPT = [
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".gif",
  ".webp",
  ".bmp",
  ".dib",
  ".avif",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
].join(",");

// BITMAPCOREHEADER through BITMAPV5HEADER; a bare "BM" prefix alone would match plain text.
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
  const boxSize = Math.min(
    bytes.length,
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
  );
  // Major brand at 8, minor version at 12, then compatible brands.
  for (let offset = 8; offset + 4 <= boxSize; offset += offset === 8 ? 8 : 4) {
    const brand = ascii(bytes, offset, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

/** Reads the file signature, so a renamed or extensionless file still gets its real type. */
export function detectAppSkinImageType(bytes: Uint8Array): AppSkinImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? "image/gif" : null;
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 18) {
    const dibHeaderSize =
      (bytes[14] ?? 0) |
      ((bytes[15] ?? 0) << 8) |
      ((bytes[16] ?? 0) << 16) |
      ((bytes[17] ?? 0) << 24);
    return BMP_DIB_HEADER_SIZES.has(dibHeaderSize) ? "image/bmp" : null;
  }
  return isAvif(bytes) ? "image/avif" : null;
}
