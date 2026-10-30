/**
 * A `sharp` stand-in for Android.
 *
 * sharp is a binding to libvips, which has no prebuilt Android target: the
 * package resolves to `@img/sharp-<platform>` native binaries and there is no
 * `android` one. The APK therefore cannot carry a real sharp, and three call
 * sites in this application use it.
 *
 * What they need, and what this shim does instead:
 *
 *   - `metadata()` — real. Format and pixel dimensions are read from the
 *     container headers (PNG, JPEG, WebP, GIF, BMP, TIFF, AVIF), which is
 *     exactly the information every caller asks for.
 *   - `toBuffer()` — the original bytes, unchanged. No resize, no re-encode.
 *     Callers that compress an image to fit a byte budget get the original
 *     back, so an image already inside the budget still passes and one outside
 *     it is skipped by the caller's own cap. Nothing is silently corrupted:
 *     `info.format` reports the bytes' real format, and the two call sites that
 *     build a `data:` URL from the result label it from that field.
 *
 * Everything the chainable API accepts is accepted and ignored, so importing
 * this module never throws. That matters more than fidelity: a thrown error at
 * import time would take down the routes that merely import a module which
 * happens to import sharp.
 */
'use strict';

/** The formats the header sniffers below can identify, and their MIME types. */
const FORMAT_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heif: 'image/heif',
};

/** Read the container format and pixel dimensions from the bytes themselves. */
function sniff(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 16) return {};

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk at offset 16.
  if (
    bytes[0] === 0x89 &&
    bytes.toString('latin1', 1, 4) === 'PNG' &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // JPEG: FF D8 FF, then segments until a start-of-frame marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          format: 'jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    return { format: 'jpeg' };
  }

  // GIF: "GIF87a"/"GIF89a", little-endian dimensions at 6.
  if (bytes.toString('latin1', 0, 3) === 'GIF') {
    return { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }

  // WebP: RIFF....WEBP, then a VP8/VP8L/VP8X chunk.
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { format: 'webp', width, height };
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
      return {
        format: 'webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (kind === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return {
        format: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return { format: 'webp' };
  }

  // BMP: "BM", little-endian dimensions in the DIB header.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    return { format: 'bmp', width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
  }

  // TIFF: "II*\0" or "MM\0*".
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00)
  ) {
    return { format: 'tiff' };
  }

  // AVIF/HEIF: an ISO-BMFF `ftyp` box.
  if (bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12);
    return { format: brand.startsWith('avi') ? 'avif' : 'heif' };
  }

  return {};
}

/**
 * One chainable operation sequence. Every method returns `this`, so any chain
 * the call sites build runs to completion; the operations themselves are
 * deliberately not applied (see the module comment).
 */
class SharpOperation {
  constructor(input, options) {
    this._input = input;
    this._options = options ?? {};
  }

  // --- chainable no-ops -------------------------------------------------
  rotate() {
    return this;
  }
  resize() {
    return this;
  }
  flatten() {
    return this;
  }
  toColourspace() {
    return this;
  }
  webp() {
    return this;
  }
  jpeg() {
    return this;
  }
  png() {
    return this;
  }
  raw() {
    return this;
  }
  withMetadata() {
    return this;
  }
  keepMetadata() {
    return this;
  }
  limitInputPixels() {
    return this;
  }
  sequentialRead() {
    return this;
  }
  timeout() {
    return this;
  }
  failOn() {
    return this;
  }

  // --- terminal operations ---------------------------------------------
  async metadata() {
    const info = sniff(this._input);
    if (!info.format) throw new Error('Input buffer is not a recognized image');
    return {
      format: info.format,
      width: info.width,
      height: info.height,
      space: 'srgb',
      depth: 'uchar',
      channels: 4,
      hasAlpha: info.format !== 'jpeg',
      // No multi-page format is decoded here, so every image is one page.
      pages: 1,
      size: Buffer.isBuffer(this._input) ? this._input.length : 0,
    };
  }

  /**
   * The original bytes, untouched.
   *
   * `info.format` is the input's real format, so a caller that builds a
   * `data:` URL from it labels the bytes correctly rather than claiming the
   * conversion that did not happen.
   */
  async toBuffer(options) {
    const info = sniff(this._input);
    const data = Buffer.isBuffer(this._input) ? this._input : Buffer.from(this._input ?? []);
    if (!info.format) throw new Error('Input buffer is not a recognized image');
    const resolved = {
      data,
      info: {
        format: info.format,
        width: info.width,
        height: info.height,
        size: data.length,
        channels: 4,
      },
    };
    return options?.resolveWithObject ? resolved : data;
  }

  async toFile() {
    throw new Error('sharp.toFile is not available on Android');
  }
}

/** The `sharp()` factory. */
function sharp(input) {
  return new SharpOperation(input);
}

sharp.cache = () => {};
sharp.concurrency = () => 1;
sharp.simd = () => false;
sharp.format = Object.fromEntries(
  Object.entries(FORMAT_MIME).map(([name]) => [name, { input: { file: true, buffer: true } }]),
);
sharp.versions = { sharp: '0.0.0-shim' };

module.exports = sharp;
module.exports.default = sharp;
module.exports.FORMAT_MIME = FORMAT_MIME;
