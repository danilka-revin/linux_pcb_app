// Статистика платы: длина дорожек, площадь меди, отверстия, состав.
import assert from 'node:assert/strict';
import { boardStats } from '../src/pcb/stats';
import { copperAreaOf } from '../src/pcb/cnc';
import { newBoard, type Doc, type Entity } from '../src/pcb/model';

function docOf(ents: Entity[], w = 40, h = 30): Doc {
  return { name: 'Тест', w, h, entities: ents };
}

// ------------------------------------------------------- площадь меди (ЧПУ)
{
  // квадратная залитая фигура 10×10 на K1
  const ents: Entity[] = [{
    id: 'r', kind: 'rect', x: 5, y: 5, w: 10, h: 10, filled: true, th: 0.2, layer: 'k1',
  }];
  const a1 = copperAreaOf(ents, 'k1');
  assert(a1 !== null && Math.abs(a1 - 100) < 0.01, `10×10 = 100 мм², а ${a1}`);
  const a2 = copperAreaOf(ents, 'k2');
  assert(a2 !== null && Math.abs(a2) < 0.01, 'на K2 такой фигуры нет');
}
{
  // дорожка шириной 2 мм длиной 10 мм ≈ 20 мм² (с полукруглыми торцами ≈ 20+π/2·r²…)
  const ents: Entity[] = [{
    id: 't', kind: 'track', pts: [{ x: 5, y: 5 }, { x: 15, y: 5 }], w: 2, layer: 'k1',
  }];
  const a = copperAreaOf(ents, 'k1');
  assert(a !== null && a > 19 && a < 24, `дорожка ≈ 20 мм², а ${a?.toFixed(1)}`);
}

// ---------------------------------------------------------------- статистика
{
  const ents: Entity[] = [
    { id: 't1', kind: 'track', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], w: 0.5, layer: 'k1' },
    { id: 't2', kind: 'track', pts: [{ x: 0, y: 5 }, { x: 0, y: 15 }], w: 0.5, layer: 'k2' },
    { id: 'p', kind: 'pad', x: 2, y: 2, shape: 'round', size: 2, drill: 1 },
    { id: 'v', kind: 'via', x: 8, y: 8, size: 1.5, drill: 0.8 },
    { id: 'h', kind: 'hole', x: 20, y: 20, d: 3 },
    { id: 's', kind: 'smd', x: 4, y: 4, w: 2, h: 1, rot: 0, layer: 'k1' },
    { id: 'tx', kind: 'text', x: 0, y: 20, size: 2, th: 0.3, rot: 0, text: 'VCC', mirror: false, layer: 's1' },
  ];
  const st = boardStats(docOf(ents));
  assert(Math.abs(st.k1.trackLen - 10) < 1e-9, 'K1: 10 мм дорожек');
  assert(Math.abs(st.k2.trackLen - 10) < 1e-9, 'K2: 10 мм дорожек');
  assert(Math.abs(st.trackLen - 20) < 1e-9, 'всего 20 мм');
  assert.equal(st.longestTrack, 10);
  assert.equal(st.pads, 1);
  assert.equal(st.smd, 1);
  assert.equal(st.vias, 1);
  assert.equal(st.texts, 1);
  assert(st.holes >= 2, `сверла: пятачок + переход + монтажное, а ${st.holes}`);
  assert(st.k1.area > 0, 'площадь K1 посчитана');
  assert(st.k2.area > 0, 'площадь K2 посчитана (переход и пятачок на обоих)');
  assert(st.fillPct > 0 && st.fillPct < 100, 'процент заполнения в пределах');
  assert.equal(st.width, 40, 'габарит рабочего поля без контура');
  assert.equal(st.boardArea, 40 * 30);
}

// ---------------------------------------------------------- контур платы
{
  const board = newBoard(50, 40, 'С контуром');
  const st = boardStats(board);
  assert(Math.abs(st.width - 50) < 0.01 && Math.abs(st.height - 40) < 0.01, 'габарит по рамке контура');
  assert(Math.abs(st.boardArea - 50 * 40) < 1, 'площадь подложки');
}

// ---------------------------------------------------------- размеры и дырки
{
  const ents: Entity[] = [
    {
      id: 'd', kind: 'dim',
      x1: 0, y1: 0, x2: 10, y2: 0, off: 2, th: 0.15, size: 2, mode: 'aligned', layer: 's1',
    },
    {
      id: 'poly', kind: 'poly',
      pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
      holes: [[{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }]],
      layer: 's1',
    },
  ];
  const st = boardStats(docOf(ents, 20, 20));
  assert.equal(st.dims, 1, 'размеры считаются');
  assert.equal(st.polys, 1, 'полигоны считаются');
  assert(st.k1.area < 0.01, 'шелкографический полигон не даёт меди');
}

console.log('stats: ok');
