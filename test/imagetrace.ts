// Векторизация изображения: контуры, дырки, упрощение, масштабирование.
import assert from 'node:assert/strict';
import { facesToPolys, ringArea, traceImage, type BitmapImage } from '../src/pcb/imagetrace';

/** Белое поле с чёрными пикселями по функции ink(x, y). */
function makeImg(w: number, h: number, ink: (x: number, y: number) => boolean): BitmapImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dark = ink(x, y);
      data[i] = data[i + 1] = data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const inBox = (x: number, y: number, x1: number, y1: number, x2: number, y2: number) =>
  x >= x1 && x < x2 && y >= y1 && y < y2;

// ------------------------------------------------------------------ квадрат
{
  const img = makeImg(32, 32, (x, y) => inBox(x, y, 8, 8, 24, 24));
  const res = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001 });
  assert.equal(res.faces.length, 1, 'один квадрат — одно лицо');
  const f = res.faces[0];
  assert.equal(f.holes.length, 0, 'без дырок');
  // 16px из 32 → 8 мм при ширине 16 мм
  const xs = f.outer.map((p) => p.x), ys = f.outer.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  assert(Math.abs(w - 8) < 0.5, `ширина квадрата ≈ 8 мм, а ${w.toFixed(2)}`);
  assert(Math.abs(h - 8) < 0.5, `высота квадрата ≈ 8 мм, а ${h.toFixed(2)}`);
  // центр рисунка в нуле
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  assert(Math.abs(cx) < 0.5 && Math.abs(cy) < 0.5, 'центр в (0;0)');
  assert.equal(res.widthMm, 16);
  assert(Math.abs(res.heightMm - 16) < 0.01, 'высота пропорциональна');
}

// ------------------------------------------------------------------- бублик
{
  // кольцо: черное 8..24 с белой дыркой 12..20
  const img = makeImg(32, 32, (x, y) =>
    inBox(x, y, 8, 8, 24, 24) && !inBox(x, y, 12, 12, 20, 20));
  const res = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001 });
  assert.equal(res.faces.length, 1, 'кольцо — одно лицо');
  assert.equal(res.faces[0].holes.length, 1, 'у кольца одна дырка');
  const outerA = Math.abs(ringArea(res.faces[0].outer));
  const holeA = Math.abs(ringArea(res.faces[0].holes[0]));
  assert(outerA > holeA * 2, 'дырка заметно меньше внешнего контура');
}

// ------------------------------------------------------------- две фигуры
{
  const img = makeImg(32, 32, (x, y) =>
    inBox(x, y, 2, 2, 10, 10) || inBox(x, y, 20, 20, 30, 30));
  const res = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001 });
  assert.equal(res.faces.length, 2, 'две раздельные фигуры — два лица');
}

// ----------------------------------------------------------------- инверсия
{
  // чёрный фон с белым квадратом
  const img = makeImg(32, 32, (x, y) => !inBox(x, y, 8, 8, 24, 24));
  const plain = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001 });
  const inv = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001, invert: true });
  assert(plain.faces.length >= 1, 'без инверсии — рамка/фон');
  assert.equal(inv.faces.length, 1, 'с инверсией — белый квадрат');
}

// ------------------------------------------------------- мелкие пятна и порог
{
  const img = makeImg(64, 64, (x, y) =>
    inBox(x, y, 4, 4, 40, 40) || inBox(x, y, 56, 56, 58, 58));
  // 0,1 мм/px: большая фигура ≈ 3,6×3,6 мм (12,96 мм²), пятно 2×2 px = 0,04 мм²
  const res = traceImage(img, { widthMm: 6.4, simplifyMm: 0, minAreaMm2: 0.5 });
  assert.equal(res.faces.length, 1, 'пятно 2×2 px отброшено порогом площади');
  assert(res.dropped === 0 || res.dropped >= 0, 'счётчик dropped — число');
}

// ------------------------------------------------------ прозрачный фон (альфа)
{
  const w = 16, h = 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const solid = inBox(x, y, 4, 4, 12, 12);
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = solid ? 255 : 0; // чернила только в квадрате
    }
  }
  const res = traceImage({ width: w, height: h, data }, { widthMm: 8, simplifyMm: 0, minAreaMm2: 0.001 });
  assert.equal(res.faces.length, 1, 'прозрачность = фон');
}

// -------------------------------------------------------------- facesToPolys
{
  const img = makeImg(32, 32, (x, y) =>
    inBox(x, y, 8, 8, 24, 24) && !inBox(x, y, 12, 12, 20, 20));
  const res = traceImage(img, { widthMm: 16, simplifyMm: 0, minAreaMm2: 0.001 });
  let n = 0;
  const polys = facesToPolys(res.faces, 's1', () => `p${n++}`);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].kind, 'poly');
  assert.equal(polys[0].layer, 's1');
  assert.equal(polys[0].id, 'p0');
  assert.equal(polys[0].holes?.length, 1, 'дырка перенеслась в полигон');
  assert(polys[0].pts.length >= 3);
}

console.log('imagetrace: ok');
