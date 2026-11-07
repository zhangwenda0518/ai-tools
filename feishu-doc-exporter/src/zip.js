/* Minimal ZIP writer (STORE method, no compression) — no dependencies.
 * Images are already compressed; CSV is small. STORE keeps the code tiny
 * and avoids shipping a 100KB JSZip bundle inside the content script. */
(function () {
  'use strict';
  if (window.__FXE_ZIP) return;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  class Writer {
    constructor(size) {
      this.buf = new Uint8Array(size);
      this.view = new DataView(this.buf.buffer);
      this.pos = 0;
    }
    u16(v) { this.view.setUint16(this.pos, v, true); this.pos += 2; }
    u32(v) { this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
    bytes(b) { this.buf.set(b, this.pos); this.pos += b.length; }
  }

  /**
   * @param {{name:string, data:Uint8Array}[]} files
   * @returns {Blob}
   */
  function buildZip(files) {
    const now = new Date();
    const time = dosTime(now);
    const date = dosDate(now);
    const entries = files.map((f) => {
      const name = utf8(f.name);
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      return { name, data, crc: crc32(data) };
    });

    let localSize = 0;
    for (const e of entries) localSize += 30 + e.name.length + e.data.length;
    let centralSize = 0;
    for (const e of entries) centralSize += 46 + e.name.length;

    const out = new Writer(localSize + centralSize + 22);
    const offsets = [];

    for (const e of entries) {
      offsets.push(out.pos);
      out.u32(0x04034b50);
      out.u16(20);
      out.u16(0x0800); // UTF-8 filename
      out.u16(0); // STORE
      out.u16(time);
      out.u16(date);
      out.u32(e.crc);
      out.u32(e.data.length);
      out.u32(e.data.length);
      out.u16(e.name.length);
      out.u16(0);
      out.bytes(e.name);
      out.bytes(e.data);
    }

    const cdStart = out.pos;
    entries.forEach((e, i) => {
      out.u32(0x02014b50);
      out.u16(20);
      out.u16(20);
      out.u16(0x0800);
      out.u16(0);
      out.u16(time);
      out.u16(date);
      out.u32(e.crc);
      out.u32(e.data.length);
      out.u32(e.data.length);
      out.u16(e.name.length);
      out.u16(0);
      out.u16(0);
      out.u16(0);
      out.u16(0);
      out.u32(0);
      out.u32(offsets[i]);
      out.bytes(e.name);
    });

    const cdSize = out.pos - cdStart;
    out.u32(0x06054b50);
    out.u16(0);
    out.u16(0);
    out.u16(entries.length);
    out.u16(entries.length);
    out.u32(cdSize);
    out.u32(cdStart);
    out.u16(0);

    return new Blob([out.buf], { type: 'application/zip' });
  }

  window.__FXE_ZIP = { buildZip, crc32 };
})();
