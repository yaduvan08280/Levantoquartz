// ============================================================
//  Mono — minimal ZIP reader  [Unified Import v1]
//  ------------------------------------------------------------
//  An .xlsx is a ZIP of XML parts. We read it with zero external
//  dependencies: parse the central directory, then inflate each
//  entry with the platform DecompressionStream('deflate-raw')
//  (available in modern Chromium / Electron, which is where the
//  Mono app runs). Handles STORED (0) and DEFLATE (8) entries.
//
//  ZIP64: this used to say "xlsx effectively never are, out of
//  scope". That is false at scale. A 1,048,576 x 100 sheet is
//  3,971 MB of XML, which puts the entry past the 32-bit field and
//  forces ZIP64 — the writer has no choice. Without the support
//  below, compSize and localOffset read back as the 0xFFFFFFFF
//  sentinel and the reader silently produces garbage rather than
//  failing. So ZIP64 is parsed here.
//
//  readZip() inflates everything into memory and is right for normal
//  workbooks. For a sheet too big to materialise, use zipDirectory()
//  + openEntryStream() and hand the stream to xlsxStream.js.
// ============================================================

const DEC = new TextDecoder('utf-8');

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }
function u64(dv, o) {
  const n = Number(dv.getBigUint64(o, true));
  if (!Number.isSafeInteger(n)) throw new Error('ZIP entry is larger than 9 PB — refusing');
  return n;
}
const SENTINEL = 0xFFFFFFFF;

// Inflate raw DEFLATE bytes -> Uint8Array via the platform stream.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable — cannot inflate .xlsx in this environment');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  let buf;
  try { buf = await new Response(stream).arrayBuffer(); }
  catch (e) {
    // A corrupt deflate stream rejects with a bare TypeError carrying no
    // message, which surfaces to the user as "TypeError:" and nothing more.
    throw new Error('This .xlsx is damaged — its compressed data could not be read'
      + (e && e.message ? ': ' + e.message : ''));
  }
  return new Uint8Array(buf);
}

/**
 * Parse the central directory WITHOUT inflating anything.
 * @returns {Map<string, {method:number, start:number, compSize:number, size:number}>}
 *          `start` is the offset of the entry's compressed bytes.
 */
export function zipDirectory(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx (no ZIP end-of-directory found)');

  let count = u16(dv, eocd + 10);
  let cdOffset = u32(dv, eocd + 16);

  // ZIP64: a locator sits immediately before the EOCD and points at the
  // ZIP64 EOCD record, which carries the real 64-bit count and offset.
  if (eocd >= 20 && u32(dv, eocd - 20) === 0x07064b50) {
    const z64 = u64(dv, eocd - 20 + 8);
    if (z64 >= 0 && z64 + 56 <= bytes.length && u32(dv, z64) === 0x06064b50) {
      count = u64(dv, z64 + 32);
      cdOffset = u64(dv, z64 + 48);
    }
  }

  const out = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    let compSize = u32(dv, p + 20);
    let size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    let localOffset = u32(dv, p + 42);
    const name = DEC.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 extra field (0x0001): only the fields that were the sentinel
    // are present, in this order — size, compSize, localOffset.
    if (size === SENTINEL || compSize === SENTINEL || localOffset === SENTINEL) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = u16(dv, e), len = u16(dv, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === SENTINEL) { size = u64(dv, q); q += 8; }
          if (compSize === SENTINEL) { compSize = u64(dv, q); q += 8; }
          if (localOffset === SENTINEL) { localOffset = u64(dv, q); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    const lhNameLen = u16(dv, localOffset + 26);
    const lhExtraLen = u16(dv, localOffset + 28);
    const start = localOffset + 30 + lhNameLen + lhExtraLen;
    if (!name.endsWith('/')) out.set(name, { method, start, compSize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Read a ZIP (ArrayBuffer | Uint8Array) -> Map<path, Uint8Array>.
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dir = zipDirectory(bytes);
  const out = new Map();
  for (const [name, e] of dir) {
    const comp = bytes.subarray(e.start, e.start + e.compSize);
    if (e.method === 0) out.set(name, comp.slice());
    else if (e.method === 8) out.set(name, await inflateRaw(comp));
  }
  return out;
}

/**
 * A ReadableStream of one entry's inflated bytes, without ever holding
 * the whole entry. This is how a multi-GB worksheet is read.
 */
export function openEntryStream(input, entry) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const comp = bytes.subarray(entry.start, entry.start + entry.compSize);
  const src = new Blob([comp]).stream();
  if (entry.method === 0) return src;
  if (entry.method !== 8) throw new Error('Unsupported ZIP compression method ' + entry.method);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable — cannot inflate .xlsx in this environment');
  }
  return src.pipeThrough(new DecompressionStream('deflate-raw'));
}

// Decode a zip entry as UTF-8 text.
export function zipText(map, path) {
  const b = map.get(path);
  return b ? DEC.decode(b) : null;
}
