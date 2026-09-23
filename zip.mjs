/**
 * A small ZIP writer (zero dependencies): node:zlib's raw deflate + a CRC32 table.
 * Enough for the SmartMonkey package — a handful of files, no zip64 (the package is
 * capped far below 4 GB), UTF-8 names. Each entry is stored if deflating doesn't help
 * (screenshots are already compressed).
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ name: 'docs/spec.md', data: Buffer|string, mtime?: Date }] → Buffer (a .zip) */
export function makeZip(entries, { now = new Date() } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    const name = String(e.name).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe name in zip: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate name in zip: ${name}`);
    seen.add(name);
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(e.mtime || now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    // "made by" UNIX (3), spec 2.0. Made-by MS-DOS makes Info-ZIP's unzip (macOS's) read names
    // as a DOS code page and garble UTF-8 ("Ürün.md") despite the UTF-8 flag — and our
    // external attributes are Unix permissions anyway.
    central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs = 0; external attrs: regular file 0644
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end of central directory
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
