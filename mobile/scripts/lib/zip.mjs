/**
 * A minimal, dependency-free ZIP writer.
 *
 * The payload has to reach the phone as one compressed archive, and the
 * repository has no zip library that is guaranteed to be installed at build
 * time (the ones it does have are transitive dependencies of build tools and
 * can disappear on an upgrade). This writes the parts of the format the
 * recipient — Android's `ZipInputStream` — actually needs: local headers,
 * deflated or stored entries, a central directory, and the end record.
 *
 * Limits, all checked rather than silently mis-written:
 *   - no ZIP64, so the archive must stay under 4 GiB and 65535 entries;
 *   - no encryption, no multi-disk, no data descriptors (sizes are known
 *     before each header is written, because every entry is compressed first).
 *
 * Entry names are UTF-8 and flagged as such (general-purpose bit 11), which is
 * what makes an asset named in Chinese survive the round trip.
 */
import { createWriteStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw);

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;
const ZIP_VERSION = 20; // 2.0: deflate + directories
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** CRC-32 (IEEE 802.3), the checksum ZIP entries carry. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date and time, which is what a ZIP header stores. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Walk a tree, yielding files with their archive names (forward slashes). */
async function collectFiles(rootDir) {
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, name);
      } else if (entry.isFile()) {
        const info = await stat(full);
        files.push({ full, name, size: info.size, mtime: info.mtime });
      }
      // Symlinks are not expected: the payload assembler dereferences them.
    }
  }
  await walk(rootDir, '');
  return files;
}

/**
 * Compress `rootDir` into a ZIP file at `outFile`.
 *
 * Entries below `storeBytes` are deflated; anything smaller (a few hundred
 * bytes of JSON) would grow, so it is stored instead.
 */
export async function zip(rootDir, outFile, onProgress, options = {}) {
  const storeBytes = options.storeBytes ?? 0;
  const level = options.level ?? 6;

  const files = await collectFiles(rootDir);
  if (files.length > MAX_ENTRIES) {
    throw new Error(
      `The payload has ${files.length} files, more than ZIP's ${MAX_ENTRIES}-entry limit. ` +
        'Prune the payload or split it across archives.',
    );
  }

  const output = createWriteStream(outFile);
  const write = (buffer) =>
    new Promise((resolve, reject) => {
      output.write(buffer, (error) => (error ? reject(error) : resolve()));
    });

  const central = [];
  let offset = 0;
  let bytes = 0;

  for (const file of files) {
    const content = await readFileFully(file.full);
    const checksum = crc32(content);
    // Entries that are already compressed (WASM, PNG, fonts) do not shrink and
    // cost time; the deflate attempt is cheap to skip for incompressible data.
    const shouldDeflate = content.length >= storeBytes && content.length > 0;
    const body = shouldDeflate ? await deflate(content, { level }) : content;
    const useDeflate = shouldDeflate && body.length < content.length;
    const payload = useDeflate ? body : content;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const nameBytes = Buffer.from(file.name, 'utf8');
    const { time, date } = dosDateTime(file.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(ZIP_VERSION, 4); // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6); // general purpose flags
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    await write(local);
    await write(nameBytes);
    await write(payload);

    const localSize = local.length + nameBytes.length + payload.length;
    central.push({ nameBytes, method, time, date, checksum, compressed: payload.length, size: content.length, offset });
    offset += localSize;
    bytes += localSize;

    if (offset > MAX_SIZE) {
      throw new Error(`The archive passed ZIP's 4 GiB limit at ${file.name}.`);
    }
    onProgress?.({ files: central.length, bytes });
  }

  // Central directory.
  const centralStart = offset;
  let centralSize = 0;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory signature
    header.writeUInt16LE(ZIP_VERSION, 4); // version made by
    header.writeUInt16LE(ZIP_VERSION, 6); // version needed
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.checksum, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(entry.offset, 42);
    await write(header);
    await write(entry.nameBytes);
    centralSize += header.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  await write(end);

  await new Promise((resolve, reject) => {
    output.end((error) => (error ? reject(error) : resolve()));
  });

  return { files: central.length, bytes: centralStart + centralSize + end.length };
}

/** Read a whole file into memory; the payload's largest file is a few MB. */
async function readFileFully(target) {
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(info.size);
    let read = 0;
    while (read < info.size) {
      const { bytesRead } = await handle.read(buffer, read, info.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read === info.size ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}
