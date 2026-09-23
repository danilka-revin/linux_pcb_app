// Чтение и запись файлов Sprint-Layout 6.0 (.lay6) и макросов (.lmk).
// Формат восстановлен по проекту sergey-raevskiy/xlay (и порту Tropby/xlay).
//
// Общие положения:
//  - все числа little-endian; float32 для координат;
//  - координаты в 1/10000 мм, ось Y направлена вверх;
//  - out/in для площадок и окружностей — РАДИУСЫ (диаметр = 2*значение/10000);
//  - строки — ANSI (для русского текста CP1251);
//  - файл: FileHeader, затем N плат (BoardHeader + объекты + connections), затем Trailer;
//  - макрос .lmk: FileHeader (в поле num_boards — число объектов) + объекты + connections.

import * as M from './model';
import { textPolylines } from './strokefont';

// ---------------- CP1251 ----------------
const CP1251_HI: number[] = (() => {
  const t: number[] = [];
  for (let b = 0x80; b <= 0xff; b++) {
    if (b >= 0xc0) t.push(0x0410 + b - 0xc0); // А-Яа-я
    else if (b === 0xa8) t.push(0x0401); // Ё
    else if (b === 0xb8) t.push(0x0451); // ё
    else t.push(b); // остальное оставляем как есть
  }
  return t;
})();

export function decodeAnsi(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break; // строки могут быть дополнены нулями
    s += b < 0x80 ? String.fromCharCode(b) : String.fromCharCode(CP1251_HI[b - 0x80]);
  }
  return s;
}

export function encodeAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x0410 && c <= 0x044f) out.push(0xc0 + (c - 0x0410));
    else if (c === 0x0401) out.push(0xa8);
    else if (c === 0x0451) out.push(0xb8);
    else out.push(0x3f); // '?'
  }
  return new Uint8Array(out);
}

// ---------------- типы объектов LAY ----------------
export const LAY_LAYER = { C1: 1, S1: 2, C2: 3, S2: 4, I1: 5, I2: 6, O: 7 } as const;
export const LAY_TYPE = { THT_PAD: 2, POLY: 4, CIRCLE: 5, LINE: 6, TEXT: 7, SMD_PAD: 8 } as const;
export const LAY_SHAPE = { ROUND: 1, OCT: 2, SQUARE: 3 } as const;

export interface LayObj {
  type: number;
  x: number; y: number;      // мм
  out: number;               // мм, «диаметр» (2r)
  inn: number;               // мм, «диаметр» (2r)
  lineWidthRaw: number;      // u32; для CIRCLE — конечный угол*1000
  layer: number;
  shape: number;
  styleU32: number;          // для CIRCLE — начальный угол*1000
  styleCustom: number;
  thermobarier: number;
  flipVertical: number;
  cutoff: number;
  thzise: number;            // поворот (единицы см. importRotation)
  metalisation: number;
  soldermask: number;
  text: string;
  points: M.Pt[];            // уже в мм
  children: LayObj[];
  componentName?: string;
}

// ---------------- чтение ----------------
class Reader {
  off = 0;
  dv: DataView;
  constructor(public buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number) {
    if (this.off + n > this.buf.length) throw new Error(`lay6: конец файла (off=${this.off}, need=${n}, len=${this.buf.length})`);
  }
  u8(): number { this.need(1); return this.dv.getUint8(this.off++); }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.off, true); this.off += 4; return v; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.off, true); this.off += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.off, true); this.off += 8; return v; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  skip(n: number) { this.need(n); this.off += n; }
  fixstr(max: number): string {
    const len = this.u8();
    const n = Math.min(len, max);
    const s = decodeAnsi(this.bytes(n));
    if (len < max) this.skip(max - len);
    else if (len > max) this.skip(len - max);
    return s;
  }
  varstr(): string {
    const len = this.u32();
    if (len > 4 * 1024 * 1024) throw new Error('lay6: слишком длинная строка');
    return decodeAnsi(this.bytes(len));
  }
}

export interface LayBoard {
  name: string;
  w: number;
  h: number;
  objects: LayObj[];
}

export interface LayFile {
  boards: LayBoard[];
  projectName: string;
  comment: string;
  activeTab: number;
}

function readObject(r: Reader, textChild: boolean, layerOverride?: number): LayObj {
  const type = r.u8();
  if (type === 0) throw new Error('lay6: объект с типом 0');
  const x = r.f32() / 10000;
  const y = r.f32() / 10000;
  const out = (r.f32() / 10000) * 2;
  const inn = (r.f32() / 10000) * 2;
  const lineWidthRaw = r.u32();
  r.u8(); // reserved
  let layer = r.u8();
  if (layerOverride !== undefined) layer = layerOverride;
  const shape = r.u8();
  r.u32(); // reserved
  r.u16(); // component_id
  r.u8(); // selected
  const styleU32 = r.u32();
  r.skip(5);
  const styleCustom = r.u8();
  r.u32(); // ground distance
  r.skip(5);
  const thermobarier = r.u8();
  const flipVertical = r.u8();
  const cutoff = r.u8();
  const thzise = r.u32();
  const metalisation = r.u8();
  const soldermask = r.u8();
  r.skip(18);

  const o: LayObj = {
    type, x, y, out, inn, lineWidthRaw, layer, shape, styleU32, styleCustom,
    thermobarier, flipVertical, cutoff, thzise, metalisation, soldermask,
    text: '', points: [], children: [],
  };

  if (!textChild) {
    o.text = r.varstr();
    const markerLen = r.u32();
    r.skip(markerLen);
    const groupLen = r.u32();
    r.skip(groupLen * 4);
  }

  if (type === LAY_TYPE.CIRCLE) return o;

  if (type === LAY_TYPE.TEXT) {
    const cnt = r.u32();
    if (cnt > 100000) throw new Error('lay6: подозрительное число glyph-объектов');
    for (let i = 0; i < cnt; i++) o.children.push(readObject(r, true, layer));
    if (o.shape === 1) {
      // запись компонента: offX, offY, centerMode, rotation(double), package, comment, use
      r.f32(); r.f32(); r.u8(); r.f64();
      const pkg = r.varstr();
      r.varstr(); // comment
      r.u8(); // use
      if (pkg) o.componentName = pkg;
    }
    return o;
  }

  const pc = r.u32();
  if (pc > 100000) throw new Error('lay6: подозрительное число точек полигона');
  for (let i = 0; i < pc; i++) {
    o.points.push({ x: r.f32() / 10000, y: r.f32() / 10000 });
  }
  return o;
}

export function parseLay6(buf: ArrayBuffer | Uint8Array): LayFile {
  const r = new Reader(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const magic = [r.u8(), r.u8(), r.u8(), r.u8()];
  if (!(magic[0] === 0x06 && magic[1] === 0x33 && magic[2] === 0xaa && magic[3] === 0xff))
    throw new Error('Это не файл Sprint-Layout 6 (.lay6/.lmk)');
  const numBoards = r.u32();
  if (numBoards > 1000) throw new Error('lay6: слишком много плат');

  const boards: LayBoard[] = [];
  for (let b = 0; b < numBoards; b++) {
    const name = r.fixstr(30);
    r.u32();
    const w = r.u32() / 10000;
    const h = r.u32() / 10000;
    r.skip(7 + 8 + 8 + 4 + 4); // groundplane, grid, zoom, viewport
    r.u8(); r.skip(3);
    r.skip(7 + 1 + 1);
    r.fixstr(200); r.fixstr(200);
    r.skip(4 + 4 + 4 * 4 + 4 + 4); // dpi, shifts, unk
    r.i32(); r.i32(); // center
    r.u8(); // multilayer
    const objCount = r.u32();
    if (objCount > 1000000) throw new Error('lay6: слишком много объектов');
    const objects: LayObj[] = [];
    let pads = 0;
    for (let i = 0; i < objCount; i++) {
      const o = readObject(r, false);
      objects.push(o);
      if (o.type === LAY_TYPE.THT_PAD || o.type === LAY_TYPE.SMD_PAD) pads++;
    }
    for (let i = 0; i < pads; i++) {
      const n = r.u32();
      r.skip(n * 4);
    }
    boards.push({ name, w, h, objects });
  }

  // Trailer
  let projectName = '', comment = '', activeTab = 0;
  if (r.off + 0x137 <= r.buf.length) {
    activeTab = r.u32();
    projectName = r.fixstr(100);
    r.fixstr(100); // author
    r.fixstr(100); // company
    const clen = r.u32();
    if (clen > 0 && clen < 4 * 1024 * 1024) {
      const raw = r.bytes(clen);
      // комментарий в UTF-16LE
      try {
        comment = new TextDecoder('utf-16le').decode(raw).replace(/\0+$/g, '');
      } catch { comment = ''; }
    }
  }
  return { boards, projectName, comment, activeTab };
}

/** Парсинг макроса .lmk (без BoardHeader: заголовок + объекты + connections) */
export function parseLmk(buf: ArrayBuffer | Uint8Array): LayObj[] {
  const r = new Reader(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const magic = [r.u8(), r.u8(), r.u8(), r.u8()];
  if (!(magic[0] === 0x06 && magic[1] === 0x33 && magic[2] === 0xaa && magic[3] === 0xff))
    throw new Error('Это не файл Sprint-Layout (.lmk)');
  const objCount = r.u32();
  const objects: LayObj[] = [];
  let pads = 0;
  for (let i = 0; i < objCount; i++) {
    const o = readObject(r, false);
    objects.push(o);
    if (o.type === LAY_TYPE.THT_PAD || o.type === LAY_TYPE.SMD_PAD) pads++;
  }
  for (let i = 0; i < pads && r.off + 4 <= r.buf.length; i++) {
    const n = r.u32();
    r.skip(n * 4);
  }
  return objects;
}

// ---------------- маппинг LAY -> наш документ ----------------
const LAY2OURS: Record<number, M.LayerId> = {
  1: 'k1', 2: 's1', 3: 'k2', 4: 's2', 5: 'k1', 6: 'k2', 7: 'outline',
};
const oursLayer = (l: number): M.LayerId => LAY2OURS[l] ?? 'k1';
const cu = (l: M.LayerId): 'k1' | 'k2' => (l === 'k2' ? 'k2' : 'k1');

const thtShape = (s: number): M.PadShape =>
  s === 2 ? 'oct' : s === 3 ? 'square' : s === 5 || s === 8 ? 'oct'
    : s === 6 || s === 9 ? 'square' : 'round';

/** Восстановление поворота текста из thzise (единицы не документированы) */
function importRotation(thzise: number): number {
  if (thzise === 0) return 0;
  const cands = [thzise, thzise / 10, thzise / 100, thzise / 1000];
  for (const v of cands) {
    if (Math.abs(v) <= 360 && Number.isFinite(v)) {
      const k = Math.round(v / 90) * 90;
      if (Math.abs(v - k) <= 2) return ((k % 360) + 360) % 360;
    }
  }
  for (const v of cands) if (Math.abs(v) <= 3600) return ((v % 360) + 360) % 360;
  return 0;
}

function polylineToEnts(
  pts: M.Pt[], w: number, layer: M.LayerId, warns?: string[],
): M.Entity[] {
  if (pts.length < 2) return [];
  if (layer === 'k1' || layer === 'k2')
    return [{ id: M.uid(), kind: 'track', pts, w: Math.max(w, 0.05), layer }];
  const out: M.Entity[] = [];
  for (let i = 0; i < pts.length - 1; i++)
    out.push({
      id: M.uid(), kind: 'line',
      x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y,
      w: Math.max(w, 0.05), layer,
    });
  return out;
}

function arcToPts(cx: number, cy: number, r: number, a0: number, a1: number): M.Pt[] {
  // Sprint: углы против часовой; дуга от a1 к a0... импортируем принудительно по кратчайшей
  let deg = a1 - a0;
  while (deg > 360) deg -= 360;
  while (deg < -360) deg += 360;
  const dir = deg >= 0 ? 1 : -1;
  const steps = Math.max(2, Math.ceil(Math.abs(deg) / 10));
  const pts: M.Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + (deg * i) / steps) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  void dir;
  return pts;
}

export function layObjToEnts(o: LayObj, warns: string[]): M.Entity[] {
  const layer = oursLayer(o.layer);
  switch (o.type) {
    case LAY_TYPE.THT_PAD: {
      if (!o.metalisation) {
        const d = o.inn > 0 ? o.inn : o.out;
        return d > 0 ? [{ id: M.uid(), kind: 'hole', x: o.x, y: o.y, d }] : [];
      }
      return [{
        id: M.uid(), kind: 'pad', x: o.x, y: o.y,
        shape: thtShape(o.shape), size: o.out, drill: o.inn,
      }];
    }
    case LAY_TYPE.SMD_PAD: {
      if (o.points.length >= 2) {
        const xs = o.points.map((p) => p.x), ys = o.points.map((p) => p.y);
        const x1 = Math.min(...xs), x2 = Math.max(...xs);
        const y1 = Math.min(...ys), y2 = Math.max(...ys);
        return [{
          id: M.uid(), kind: 'smd',
          x: (x1 + x2) / 2, y: (y1 + y2) / 2,
          w: Math.max(x2 - x1, 0.05), h: Math.max(y2 - y1, 0.05),
          rot: 0, layer: cu(layer),
        }];
      }
      return [{
        id: M.uid(), kind: 'smd', x: o.x, y: o.y,
        w: Math.max(o.out, 0.05), h: Math.max(o.inn, 0.05),
        rot: 0, layer: cu(layer),
      }];
    }
    case LAY_TYPE.LINE: {
      const w = o.lineWidthRaw / 10000;
      return polylineToEnts(o.points, w, layer, warns);
    }
    case LAY_TYPE.POLY: {
      const w = o.lineWidthRaw / 10000;
      // прямоугольник из 4 осесимметричных точек — восстанавливаем как rect
      const rr = axisAlignedRect(o.points);
      if (rr && (o.cutoff || layer === 'outline'))
        return [{ id: M.uid(), kind: 'rect', x: rr.x, y: rr.y, w: rr.w, h: rr.h, filled: false, th: Math.max(w, 0.1), layer: 'outline' }];
      if (o.cutoff) return polylineToEnts([...o.points, o.points[0]], Math.max(w, 0.1), 'outline', warns);
      if (o.styleCustom && (layer === 'k1' || layer === 'k2')) {
        return o.points.length >= 3
          ? [{ id: M.uid(), kind: 'poly', pts: o.points, layer }]
          : [];
      }
      if (o.points.length >= 3 && layer !== 'outline' && !o.styleCustom) {
        // незалитый полигон — замкнутая ломаная
        return polylineToEnts([...o.points, o.points[0]], Math.max(w, 0.1), layer, warns);
      }
      if (o.points.length >= 3 && layer === 'outline')
        return polylineToEnts([...o.points, o.points[0]], Math.max(w, 0.1), 'outline', warns);
      if (o.points.length >= 3) return [{ id: M.uid(), kind: 'poly', pts: o.points, layer: cu(layer) }];
      return polylineToEnts(o.points, Math.max(w, 0.1), layer, warns);
    }
    case LAY_TYPE.CIRCLE: {
      const r = (o.out + o.inn) / 4;
      const w = Math.max((o.out - o.inn) / 2, 0.05);
      const start = o.styleU32 / 1000;
      const end = o.lineWidthRaw / 1000;
      const full = Math.abs((((end - start) % 360) + 360) % 360) < 0.01 || start === end;
      if (r <= 0) return [];
      if (full) return [{ id: M.uid(), kind: 'circle', x: o.x, y: o.y, r, w, layer }];
      const pts = arcToPts(o.x, o.y, r, start, end);
      return polylineToEnts(pts, w, layer, warns);
    }
    case LAY_TYPE.TEXT: {
      if (!o.text.trim() && !o.children.length) return [];
      // геометрия высоты — из векторных глифов, если есть
      let size = o.out > 0 ? o.out / 2 : 2.54;
      let th = o.inn > 0 ? o.inn / 2 : 0.3;
      let minY = Infinity, maxY = -Infinity;
      let lwSum = 0, lwCnt = 0;
      const scan = (c: LayObj) => {
        for (const p of c.points) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
        if (c.lineWidthRaw > 0) { lwSum += c.lineWidthRaw / 10000; lwCnt++; }
        c.children.forEach(scan);
      };
      o.children.forEach(scan);
      if (isFinite(maxY) && maxY > minY) size = maxY - minY;
      if (lwCnt) th = lwSum / lwCnt;
      // поворот текста в lay6 — по часовой стрелке (наш — против)
      const rot = ((360 - importRotation(o.thzise)) % 360 + 360) % 360;
      return [{
        id: M.uid(), kind: 'text',
        x: o.x, y: isFinite(minY) ? minY : o.y, // базовая линия ≈ низ глифов
        size, th, rot,
        text: o.text || '?',
        mirror: !!o.thermobarier,
        layer: layer === 'outline' ? 's1' : layer,
      }];
    }
    default:
      warns.push(`Неизвестный тип объекта: ${o.type}`);
      return [];
  }
}

/** 4 точки, образующие осесимметричный прямоугольник? */
function axisAlignedRect(pts: M.Pt[]): { x: number; y: number; w: number; h: number } | undefined {
  if (pts.length !== 4) return undefined;
  const xs = [...new Set(pts.map((p) => Math.round(p.x * 1000) / 1000))].sort((a, b) => a - b);
  const ys = [...new Set(pts.map((p) => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
  if (xs.length !== 2 || ys.length !== 2) return undefined;
  const corners = new Set(pts.map((p) => `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}`));
  if (corners.size !== 4) return undefined;
  return { x: xs[0], y: ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0] };
}

export function lay6ToDoc(buf: ArrayBuffer | Uint8Array): { doc: M.Doc; warnings: string[] } {
  const f = parseLay6(buf);
  const b = f.boards[Math.min(f.activeTab, f.boards.length - 1)] ?? f.boards[0];
  if (!b) throw new Error('В файле нет плат');
  const warnings: string[] = [];
  const doc = M.newBoard(Math.max(b.w, 5), Math.max(b.h, 5), f.projectName || b.name || 'Плата');
  const entities: M.Entity[] = [];
  for (const o of b.objects) entities.push(...layObjToEnts(o, warnings));
  // контент в файле может лежать где угодно на бесконечной сетке Sprint
  // (обычно в зоне x>0, y<0). Сдвигаем всё так, чтобы медиана координат
  // совпала с центром платы из заголовка — выбросы за краем сохраняются.
  if (b.objects.length) {
    const xs = b.objects.map((o) => o.x).sort((a, c) => a - c);
    const ys = b.objects.map((o) => o.y).sort((a, c) => a - c);
    const mx = xs[Math.floor(xs.length / 2)], my = ys[Math.floor(ys.length / 2)];
    const dx = doc.w / 2 - mx, dy = doc.h / 2 - my;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)
      entities.forEach((e) => M.translateEnt(e, dx, dy));
  }
  // контур: если в объектах нет outline-геометрии — оставляем дефолтный rect
  const hasOutline = entities.some((e) => (e as { layer?: string }).layer === 'outline');
  doc.entities = hasOutline ? entities : [...doc.entities, ...entities];
  return { doc, warnings };
}

export function lmkToEnts(buf: ArrayBuffer | Uint8Array): { ents: M.Entity[]; warnings: string[] } {
  const objects = parseLmk(buf);
  const warnings: string[] = [];
  const ents: M.Entity[] = [];
  for (const o of objects) ents.push(...layObjToEnts(o, warnings));
  // привести к началу координат: центр bbox -> (0,0)
  if (ents.length) {
    const bb = M.unionBBox(ents.map(M.entBBox));
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    ents.forEach((e) => M.translateEnt(e, -cx, -cy));
  }
  return { ents, warnings };
}

// ---------------- запись ----------------
class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { return this.u16(v).u16(v >> 16); }
  i32(v: number) { return this.u32(v >>> 0); }
  f32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.parts.push(...b);
    return this;
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.parts.push(...b);
    return this;
  }
  zeros(n: number) { for (let i = 0; i < n; i++) this.parts.push(0); return this; }
  bytes(b: Uint8Array | number[]) { this.parts.push(...b); return this; }
  fixstr(text: string, max: number) {
    const b = encodeAnsi(text.slice(0, max));
    this.u8(b.length);
    this.bytes(b);
    this.zeros(max - b.length);
    return this;
  }
  varstr(text: string) {
    const b = encodeAnsi(text);
    this.u32(b.length);
    this.bytes(b);
    return this;
  }
  get length() { return this.parts.length; }
  toUint8(): Uint8Array { return new Uint8Array(this.parts); }
}

interface LayEmit {
  obj: LayObj;
  isPad: boolean;
}

function baseObj(type: number): LayObj {
  return {
    type, x: 0, y: 0, out: 0, inn: 0, lineWidthRaw: 0,
    layer: 1, shape: 0, styleU32: 0, styleCustom: 0,
    thermobarier: 0, flipVertical: 0, cutoff: 0, thzise: 0,
    metalisation: 0, soldermask: 0, text: '', points: [], children: [],
  };
}

const OURS2LAY: Record<M.LayerId, number> = {
  k1: LAY_LAYER.C1, s1: LAY_LAYER.S1, k2: LAY_LAYER.C2, s2: LAY_LAYER.S2, outline: LAY_LAYER.O,
};

function entitiesToLay(ents: M.Entity[]): LayEmit[] {
  const out: LayEmit[] = [];
  const push = (o: LayObj) => out.push({ obj: o, isPad: o.type === LAY_TYPE.THT_PAD || o.type === LAY_TYPE.SMD_PAD });

  const lineObj = (pts: M.Pt[], w: number, layer: M.LayerId) => {
    if (pts.length < 2) return;
    const o = baseObj(LAY_TYPE.LINE);
    o.x = pts[0].x; o.y = pts[0].y;
    o.lineWidthRaw = Math.round(w * 10000);
    o.layer = OURS2LAY[layer];
    o.points = pts;
    push(o);
  };

  const polyObj = (pts: M.Pt[], fill: boolean, w: number, layer: M.LayerId, cutoff = false) => {
    if (pts.length < 3) return;
    const o = baseObj(LAY_TYPE.POLY);
    o.x = pts[0].x; o.y = pts[0].y;
    o.cutoff = cutoff ? 1 : 0;
    o.styleCustom = fill ? 1 : 0;
    o.lineWidthRaw = Math.round(w * 10000);
    o.layer = OURS2LAY[layer];
    o.points = pts;
    push(o);
  };

  const walk = (e: M.Entity) => {
    switch (e.kind) {
      case 'pad': case 'via': {
        const o = baseObj(LAY_TYPE.THT_PAD);
        o.x = e.x; o.y = e.y;
        const size = e.kind === 'pad' ? e.size : e.size;
        const drill = e.kind === 'pad' ? e.drill : e.drill;
        o.out = size; o.inn = drill;
        o.shape = e.kind === 'pad' ? (e.shape === 'oct' ? 2 : e.shape === 'square' ? 3 : 1) : 1;
        o.metalisation = 1;
        o.layer = LAY_LAYER.C1;
        push(o);
        break;
      }
      case 'hole': {
        const o = baseObj(LAY_TYPE.THT_PAD);
        o.x = e.x; o.y = e.y;
        o.out = e.d; o.inn = e.d;
        o.shape = 1;
        o.metalisation = 0;
        o.layer = LAY_LAYER.C1;
        push(o);
        break;
      }
      case 'smd': {
        const o = baseObj(LAY_TYPE.SMD_PAD);
        o.x = e.x; o.y = e.y;
        const rot = ((Math.round(e.rot) % 180) + 180) % 180;
        const w = rot === 0 ? e.w : e.h;
        const h = rot === 0 ? e.h : e.w;
        o.out = w; o.inn = h;
        o.layer = e.layer === 'k1' ? LAY_LAYER.C1 : LAY_LAYER.C2;
        const hw = w / 2, hh = h / 2;
        o.points = [
          { x: e.x - hw, y: e.y - hh }, { x: e.x + hw, y: e.y - hh },
          { x: e.x + hw, y: e.y + hh }, { x: e.x - hw, y: e.y + hh },
        ];
        push(o);
        break;
      }
      case 'track':
        lineObj(e.pts, e.w, e.layer);
        break;
      case 'line':
        lineObj([{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }], e.w, e.layer);
        break;
      case 'poly':
        polyObj(e.pts, true, 0.1, e.layer);
        break;
      case 'rect': {
        const c = [
          { x: e.x, y: e.y }, { x: e.x + e.w, y: e.y },
          { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h },
        ];
        if (e.filled) polyObj(c, true, 0.1, e.layer);
        else polyObj(c, false, e.th, e.layer, e.layer === 'outline');
        break;
      }
      case 'circle': {
        const o = baseObj(LAY_TYPE.CIRCLE);
        o.x = e.x; o.y = e.y;
        o.out = e.r * 2 + e.w; o.inn = Math.max(e.r * 2 - e.w, 0.02);
        o.lineWidthRaw = 360000; // полный круг
        o.styleU32 = 0;
        o.layer = OURS2LAY[e.layer];
        push(o);
        break;
      }
      case 'text': {
        const o = baseObj(LAY_TYPE.TEXT);
        o.x = e.x; o.y = e.y;
        o.out = e.size * 2; o.inn = e.th * 2;
        o.layer = OURS2LAY[e.layer === 'outline' ? 's1' : e.layer];
        o.styleCustom = 1; // показывать векторные глифы
        o.text = e.text;
        // поворот текста в lay6 — по часовой (у нас — против)
        o.thzise = ((360 - (Math.round(e.rot) % 360)) % 360 + 360) % 360;
        o.thermobarier = e.mirror ? 1 : 0;
        // векторные глифы из нашего шрифта
        const sc = e.size / 10;
        const a = (e.rot * Math.PI) / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (const seg of textPolylines(e.text)) {
          const pts = seg.map((p) => {
            const mx = e.mirror ? -p.x : p.x;
            const x = mx * sc, y = p.y * sc;
            return { x: e.x + x * ca - y * sa, y: e.y + x * sa + y * ca };
          });
          const ch = baseObj(LAY_TYPE.LINE);
          ch.x = pts[0].x; ch.y = pts[0].y;
          ch.lineWidthRaw = Math.round(e.th * 10000);
          ch.layer = o.layer;
          ch.points = pts;
          o.children.push(ch);
        }
        push(o);
        break;
      }
      case 'comp':
        // компоненты разворачиваем в примитивы заранее (см. appendExpanded)
        break;
    }
  };

  for (const e of ents) walk(e);
  return out;
}

function writeObject(w: Writer, o: LayObj, textChild: boolean) {
  w.u8(o.type);
  w.f32(o.x * 10000); w.f32(o.y * 10000);
  w.f32((o.out * 10000) / 2); w.f32((o.inn * 10000) / 2);
  w.u32(o.lineWidthRaw);
  w.u8(0);
  w.u8(o.layer);
  w.u8(o.shape);
  w.u32(0);
  w.u16(0); // component_id
  w.u8(0); // selected
  w.u32(o.styleU32);
  w.zeros(5);
  w.u8(o.styleCustom);
  w.u32(0); // ground distance
  w.zeros(5);
  w.u8(o.thermobarier);
  w.u8(o.flipVertical);
  w.u8(o.cutoff);
  w.u32(o.thzise);
  w.u8(o.metalisation);
  w.u8(o.soldermask);
  w.zeros(18);

  if (!textChild) {
    w.varstr(o.text);
    w.u32(0); // marker
    w.u32(0); // groups
  }

  if (o.type === LAY_TYPE.CIRCLE) return;

  if (o.type === LAY_TYPE.TEXT) {
    w.u32(o.children.length);
    for (const c of o.children) writeObject(w, c, true);
    // tht_shape=0 -> записи компонента нет
    return;
  }

  w.u32(o.points.length);
  for (const p of o.points) { w.f32(p.x * 10000); w.f32(p.y * 10000); }
}

export const LAY6_MAGIC = [0x06, 0x33, 0xaa, 0xff];

export function hasLay6Magic(buf: ArrayBuffer | Uint8Array): boolean {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length > 8 && b[0] === 0x06 && b[1] === 0x33 && b[2] === 0xaa && b[3] === 0xff;
}

/** Наш документ -> .lay6 (без развёрнутых компонентов — их разворачиваем снаружи) */
export function docToLay6(doc: M.Doc, expanded: M.Entity[]): Uint8Array {
  const w = new Writer();
  // FileHeader
  w.bytes(LAY6_MAGIC);
  w.u32(1); // одна плата
  // дефолтный прямоугольный контур (0,0,w,h) не экспортируем —
  // Sprint берёт размер из заголовка, а рисованный контур остаётся
  const isDefaultOutline = (e: M.Entity): boolean =>
    e.kind === 'rect' && e.layer === 'outline' &&
    Math.abs(e.x) < 0.01 && Math.abs(e.y) < 0.01 &&
    Math.abs(e.w - doc.w) < 0.01 && Math.abs(e.h - doc.h) < 0.01;
  const emits = entitiesToLay(expanded.filter((e) => !isDefaultOutline(e)));

  // BoardHeader (534 байта)
  w.fixstr(doc.name.slice(0, 30), 30);
  w.u32(0);
  w.u32(Math.round(doc.w * 10000));
  w.u32(Math.round(doc.h * 10000));
  w.zeros(7); // ground planes
  w.f64(1.27 * 10000); // сетка
  w.f64(1); // zoom
  w.u32(0); w.u32(0); // viewport
  w.u8(LAY_LAYER.C2); w.zeros(3);
  for (let i = 0; i < 7; i++) w.u8(0); // visible
  w.u8(0); w.u8(0); // scanned copy show
  w.fixstr('', 200); w.fixstr('', 200);
  w.u32(300 * 10000); w.u32(300 * 10000); // dpi
  w.u32(0); w.u32(0); w.u32(0); w.u32(0); // shifts
  w.u32(0); w.u32(0); // unk
  w.i32(Math.round((doc.w / 2) * 10000));
  w.i32(Math.round((doc.h / 2) * 10000));
  w.u8(0); // multilayer
  w.u32(emits.length);

  for (const e of emits) writeObject(w, e.obj, false);
  for (const e of emits) if (e.isPad) w.u32(0); // connections (пустые)

  // Trailer
  w.u32(0); // active tab
  w.fixstr(doc.name, 100);
  w.fixstr('LayOut (linux_pcb_app)', 100);
  w.fixstr('', 100);
  w.u32(0); // comment len

  return w.toUint8();
}

/** Локальные примитивы макроса -> .lmk */
export function entsToLmk(ents: M.Entity[]): Uint8Array {
  const w = new Writer();
  w.bytes(LAY6_MAGIC);
  // нормировка: центр bbox в (0,0)
  let list = ents;
  if (ents.length) {
    const bb = M.unionBBox(ents.map(M.entBBox));
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    list = ents.map((e) => {
      const c = JSON.parse(JSON.stringify(e)) as M.Entity;
      M.translateEnt(c, -cx, -cy);
      return c;
    });
  }
  const emits = entitiesToLay(list);
  w.u32(emits.length);
  for (const e of emits) writeObject(w, e.obj, false);
  for (const e of emits) if (e.isPad) w.u32(0);
  return w.toUint8();
}
