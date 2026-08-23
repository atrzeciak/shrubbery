import { describe, expect, it } from "vitest";
import { crc32, zipStream } from "../src/backup/zip.js";

const enc = new TextEncoder();
const AT = new Date("2026-08-22T10:00:00Z");

async function collect(stream) {
  const out = [];
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value);
  const total = out.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of out) { buf.set(c, at); at += c.length; }
  return buf;
}

async function* two() {
  yield { name: "dane.sql", bytes: enc.encode("SELECT 1;") };
  yield { name: "media/a.jpg", bytes: new Uint8Array([1, 2, 3, 4]) };
}

describe("crc32", () => {
  it("matches the known vectors", () => {
    expect(crc32(enc.encode(""))).toBe(0);
    expect(crc32(enc.encode("123456789")) >>> 0).toBe(0xcbf43926);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog")) >>> 0).toBe(0x414fa339);
  });
});

describe("zipStream", () => {
  it("writes local headers, data and a central directory an unzipper can follow", async () => {
    const buf = await collect(zipStream(two(), AT));
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);            // first local header
    expect(dv.getUint16(8, true)).toBe(0);                      // method: store

    // end of central directory sits at the tail, with both entries counted
    const eocd = buf.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    expect(cdOffset + cdSize).toBe(eocd);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);      // first central header

    // the first entry's stored bytes are intact and its sizes and CRC are correct
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const name = new TextDecoder().decode(buf.subarray(30, 30 + nameLen));
    expect(name).toBe("dane.sql");
    const data = buf.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + 9);
    expect(new TextDecoder().decode(data)).toBe("SELECT 1;");
    expect(dv.getUint32(14, true) >>> 0).toBe(crc32(enc.encode("SELECT 1;")) >>> 0);
    expect(dv.getUint32(18, true)).toBe(9);                     // compressed size
    expect(dv.getUint32(22, true)).toBe(9);                     // uncompressed size
  });

  it("handles an empty archive and an empty file", async () => {
    async function* one() { yield { name: "pusty.txt", bytes: new Uint8Array(0) }; }
    const empty = await collect(zipStream((async function* () {})(), AT));
    expect(empty.length).toBe(22);
    expect(new DataView(empty.buffer).getUint16(10, true)).toBe(0);
    const oneFile = await collect(zipStream(one(), AT));
    expect(new DataView(oneFile.buffer).getUint32(14, true)).toBe(0);   // crc of nothing
  });

  it("throws on entry size exceeding 4 GiB", async () => {
    async function* tooLarge() {
      yield { name: "huge.bin", bytes: { length: 0x1_0000_0000 } };
    }
    await expect(async () => {
      const stream = zipStream(tooLarge(), AT);
      const reader = stream.getReader();
      await reader.read();
    }).rejects.toThrow(/exceeds 4 GiB limit/);
  });

  it("throws on entry count exceeding 65535", async () => {
    async function* manyEntries() {
      const tiny = new Uint8Array(1);
      for (let i = 0; i <= 0xffff; i++) {
        yield { name: `f${i}`, bytes: tiny };
      }
    }
    const stream = zipStream(manyEntries(), AT);
    const reader = stream.getReader();
    let caught = false;
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read());
    } catch (err) {
      expect(String(err)).toMatch(/exceeds 65535 limit/);
      caught = true;
    }
    expect(caught).toBe(true);
  });
});
