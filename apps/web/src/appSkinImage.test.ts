import { describe, expect, it } from "vite-plus/test";

import { detectAppSkinImageType } from "./appSkinImage";

const bytes = (...values: ReadonlyArray<number | string>) =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === "string" ? Array.from(value, (char) => char.charCodeAt(0)) : [value],
    ),
  );

const bmp = (dibHeaderSize: number) =>
  bytes("BM", 0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, dibHeaderSize, 0, 0, 0, 1, 0, 0, 0);

const ftyp = (major: string, ...compatible: ReadonlyArray<string>) => {
  const size = 16 + compatible.length * 4;
  return bytes(0, 0, 0, size, "ftyp", major, 0, 0, 0, 0, ...compatible);
};

describe("detectAppSkinImageType", () => {
  it.each([
    ["PNG", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d), "image/png"],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, "JFIF"), "image/jpeg"],
    ["GIF89a", bytes("GIF89a", 1, 0, 1, 0), "image/gif"],
    ["GIF87a", bytes("GIF87a", 1, 0, 1, 0), "image/gif"],
    ["WebP", bytes("RIFF", 0x24, 0, 0, 0, "WEBPVP8 "), "image/webp"],
    ["BMP with a BITMAPINFOHEADER", bmp(40), "image/bmp"],
    ["BMP with a BITMAPV5HEADER", bmp(124), "image/bmp"],
    ["OS/2 BMP with a BITMAPCOREHEADER", bmp(12), "image/bmp"],
    ["AVIF by major brand", ftyp("avif", "mif1", "miaf"), "image/avif"],
    ["animated AVIF", ftyp("avis", "msf1"), "image/avif"],
    ["AVIF by compatible brand", ftyp("mif1", "miaf", "avif"), "image/avif"],
  ])("recognizes %s", (_name, header, type) => {
    expect(detectAppSkinImageType(header)).toBe(type);
  });

  it.each([
    ["an empty file", bytes()],
    ["text that starts with BM", bytes("BM is a plain text file here")],
    ["a truncated PNG signature", bytes(0x89, "PNG")],
    ["a GIF-like header with a bad version", bytes("GIF88a", 1, 0)],
    ["a RIFF file that is not WebP", bytes("RIFF", 0x24, 0, 0, 0, "WAVEfmt ")],
    ["HEIC", ftyp("heic", "mif1", "heic")],
    ["an MP4 video", ftyp("isom", "iso2", "mp41")],
    ["SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])("refuses %s", (_name, header) => {
    expect(detectAppSkinImageType(header)).toBeNull();
  });
});
