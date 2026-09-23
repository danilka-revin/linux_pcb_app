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
  data: string;
}

export function makeZip(files: ZipFile[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;

  for (const f of files) {
    const d = enc.encode(f.data);
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

export function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
