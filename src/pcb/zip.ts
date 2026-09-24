// Минимальный ZIP-архиватор (без сжатия, метод store).

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipFile {
  name: string;
  data: string | Uint8Array;
}

export function makeZip(files: ZipFile[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;

  for (const f of files) {
    const d = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const nm = enc.encode(f.name);
    const crc = crc32(d);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, d.length, true);
    lh.setUint32(22, d.length, true);
    lh.setUint16(26, nm.length, true);
    chunks.push(new Uint8Array(lh.buffer), nm, d);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, d.length, true);
    cd.setUint32(24, d.length, true);
    cd.setUint16(28, nm.length, true);
    cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), nm);

    off += 30 + nm.length + d.length;
  }

  const cdStart = off;
  let cdLen = 0;
  for (const c of central) cdLen += c.length;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdLen, true);
  end.setUint32(16, cdStart, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)] as BlobPart[], {
    type: 'application/zip',
  });
}

type DecStream = new (format: string) => ReadableWritablePair<Uint8Array, Uint8Array>;
const decompression = (): DecStream | null =>
  (typeof (globalThis as Record<string, unknown>).DecompressionStream === 'function'
    ? (globalThis as Record<string, unknown>).DecompressionStream as DecStream
    : null);

/**
 * Минимальный ZIP-ридер: методы store (0) и deflate (8, через DecompressionStream).
 * Возвращает пары «имя файла в архиве» → байты. Каталоги пропускаются.
 */
export async function unzip(buf: ArrayBuffer | Uint8Array): Promise<Map<string, Uint8Array>> {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  // End of Central Directory (0x06054b50) ищем с конца: после него возможен комментарий
  let eocd = -1;
  const from = Math.max(0, b.length - 22 - 65536);
  for (let i = b.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не ZIP-архив (запись конца каталога не найдена)');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const text = new TextDecoder('utf-8');

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP: повреждён центральный каталог');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = text.decode(b.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue; // каталог

    // локальный заголовок: после него сразу идут данные файла
    const lhName = dv.getUint16(lho + 26, true);
    const lhExtra = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lhName + lhExtra;
    const raw = b.subarray(start, start + csize);

    if (method === 0) {
      out.set(name, raw.slice());
    } else if (method === 8) {
      const DS = decompression();
      if (!DS) throw new Error('ZIP с deflate-сжатием: нужен браузер с DecompressionStream');
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      let len = 0;
      for (const c of chunks) len += c.length;
      const data = new Uint8Array(len);
      let p = 0;
      for (const c of chunks) { data.set(c, p); p += c.length; }
      out.set(name, data);
    } else {
      throw new Error(`ZIP: неизвестный метод сжатия ${method} в «${name}»`);
    }
  }
  return out;
}

export function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
