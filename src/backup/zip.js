// A ZIP writer with no compression and no dependency: photos and PDFs are already compressed, so
// storing them verbatim costs nothing and keeps this file small enough to audit in one sitting.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS packed date and time: seconds lose their odd second, which no unzipper minds.
function dosStamp(at) {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

function bytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const u16 = (n) => {
  if (n > 0xffff) throw new Error(`value ${n} exceeds u16 max (65535)`);
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
};

const u32 = (n) => {
  if (n > 0xffffffff) throw new Error(`value ${n} exceeds u32 max (4294967295)`);
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
};

// onError: the archive is streamed with a 200 already sent, so failing is all this can do to the
// client. The caller gets told so the failure can be written down rather than vanishing.
export function zipStream(entries, at = new Date(), onError = null) {
  const { time, date } = dosStamp(at);
  const enc = new TextEncoder();
  const iterator = entries[Symbol.asyncIterator] ? entries[Symbol.asyncIterator]() : entries;
  const central = [];
  let offset = 0;
  let entryCount = 0;
  // pull() runs once per read the consumer actually makes, so nothing beyond the entry currently
  // being asked for is ever produced or held in the stream's queue at once.
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value: entry, done } = await iterator.next();
        if (done) {
          let cdSize = 0;
          for (const c of central) { controller.enqueue(c); cdSize += c.length; }
          if (cdSize > 0xffffffff) throw new Error(`central directory size ${cdSize} exceeds 4 GiB limit`);
          controller.enqueue(bytes(
            u32(0x06054b50), u16(0), u16(0), u16(entryCount), u16(entryCount),
            u32(cdSize), u32(offset), u16(0)));
          controller.close();
          return;
        }
        const size = entry.bytes.length;
        if (size > 0xffffffff) throw new Error(`entry "${entry.name}" size ${size} exceeds 4 GiB limit`);
        const name = enc.encode(entry.name);
        const crc = crc32(entry.bytes);
        const local = bytes(
          u32(0x04034b50), u16(20), u16(0x0800), u16(0),      // flag 0x0800: the name is UTF-8
          u16(time), u16(date), u32(crc), u32(size), u32(size),
          u16(name.length), u16(0), name);
        controller.enqueue(local);
        controller.enqueue(entry.bytes);
        central.push(bytes(
          u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
          u16(time), u16(date), u32(crc), u32(size), u32(size),
          u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
        offset += local.length + size;
        if (offset > 0xffffffff) throw new Error(`archive offset ${offset} exceeds 4 GiB limit`);
        entryCount++;
        if (entryCount > 0xffff) throw new Error(`entry count ${entryCount} exceeds 65535 limit`);
      } catch (err) {
        try { onError?.(err); } catch { /* recording a failure must never mask the failure */ }
        controller.error(err);
      }
    },
  });
}
