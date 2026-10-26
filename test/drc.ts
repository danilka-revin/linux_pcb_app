import assert from 'node:assert/strict';
import { newBoard, type Entity, type Net } from '../src/pcb/model';
import { runBoardDrc, type DrcRules } from '../src/pcb/drc';
import { panelizeDoc } from '../src/pcb/panelize';

const base = () => newBoard(30, 20);
const rules: Partial<DrcRules> = { minClearance: .25, minBoardEdge: .25, minTrackWidth: .15, minAnnularRing: .15, minDrill: .3 };
const ids = (entities: Entity[], nets: Net[] = []) => new Set(runBoardDrc({ ...base(), entities, nets }, rules).map((x) => x.rule));

assert.deepEqual(runBoardDrc(base()), [], 'empty rectangular board is clean');
assert(ids([{ id: 'thin', kind: 'track', pts: [{ x: 5, y: 5 }, { x: 10, y: 5 }], w: .1, layer: 'k1' }]).has('track-width'));
assert(ids([{ id: 'ring', kind: 'pad', x: 8, y: 8, size: 1, drill: .8, shape: 'round' }]).has('annular-ring'));
assert(ids([{ id: 'edge', kind: 'pad', x: .5, y: 10, size: 1, drill: 0, shape: 'round' }]).has('copper-edge'));
assert(ids([{ id: 'drill-edge', kind: 'hole', x: .2, y: 10, d: .8 }]).has('drill-edge'));
assert(ids([
  { id: 'a', kind: 'track', pts: [{ x: 5, y: 5 }, { x: 12, y: 5 }], w: .3, layer: 'k1' },
  { id: 'b', kind: 'track', pts: [{ x: 5, y: 5.4 }, { x: 12, y: 5.4 }], w: .3, layer: 'k1' },
]).has('copper-clearance'));
const noClearance = runBoardDrc({ ...base(), entities: [
  { id: 'a', kind: 'track', pts: [{ x: 5, y: 5 }, { x: 12, y: 5 }], w: .3, layer: 'k1' },
  { id: 'b', kind: 'track', pts: [{ x: 5, y: 5.6 }, { x: 12, y: 5.6 }], w: .3, layer: 'k1' },
] }, rules);
assert(!noClearance.some((x) => x.rule === 'copper-clearance'), 'clearance exactly above threshold is legal');
const nets: Net[] = [{ id: 'n1', name: 'SIGNAL', pads: ['p1', 'p2'] }];
const floating = runBoardDrc({ ...base(), nets, entities: [
  { id: 'p1', kind: 'pad', x: 5, y: 5, size: 1, drill: 0, shape: 'round' },
  { id: 'p2', kind: 'smd', x: 20, y: 5, w: 1, h: 1, rot: 0, layer: 'k1' },
] }, rules);
assert(floating.some((x) => x.rule === 'unconnected-net' && x.severity === 'warning'));
const outline = runBoardDrc({ ...base(), entities: [
  { id: 'o1', kind: 'line', layer: 'outline', x1: 0, y1: 0, x2: 30, y2: 20, w: .2 },
] }, rules);
assert(outline.some((x) => x.rule === 'outline-open' && x.severity === 'error'), 'open outline is reported');
assert(outline.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y)), 'violations carry finite navigation points');
const panel = panelizeDoc(base(), { cols: 2, rows: 1, stepX: 32, stepY: 20, breakawayTabs: true, railWidth: 5 }).doc;
const panelDrc = runBoardDrc(panel);
assert(panelDrc.some((x) => x.rule === 'outline-open' && x.severity === 'warning'));
assert(!panelDrc.some((x) => x.rule === 'outline-missing'), 'intentional breakaway tabs are not misreported as a missing board outline');
// Односторонняя плата: медь на K1 — ошибка, переход — лишнее отверстие.
{
  const single = { ...base(), layers: 1 as const, entities: [
    { id: 'top', kind: 'track' as const, pts: [{ x: 5, y: 5 }, { x: 10, y: 5 }], w: .5, layer: 'k1' as const },
    { id: 'smd', kind: 'smd' as const, x: 15, y: 15, w: 1.2, h: 1.2, rot: 0, layer: 'k1' as const },
    { id: 'br', kind: 'via' as const, x: 20, y: 10, size: 1.4, drill: .7 },
    { id: 'bot', kind: 'track' as const, pts: [{ x: 5, y: 15 }, { x: 10, y: 15 }], w: .5, layer: 'k2' as const },
  ] };
  const v = runBoardDrc(single, rules);
  const copper = v.filter((x) => x.rule === 'single-side-copper');
  assert.equal(copper.length, 2, 'дорожка и SMD на K1 — два нарушения');
  assert(copper.every((x) => x.severity === 'error' && x.layer === 'K1'));
  assert(v.some((x) => x.rule === 'single-side-via' && x.severity === 'warning'), 'переход на одном слое — предупреждение');
  assert(!v.some((x) => x.rule === 'single-side-copper' && x.entities?.includes('bot')), 'медь на K2 законна');
  const two = runBoardDrc({ ...single, layers: 2 }, rules);
  assert(!two.some((x) => x.rule.startsWith('single-side')), 'на двусторонней плате правил одного слоя нет');
  console.log('DRC: single-sided board flags top copper and stray bridges');
}

console.log('DRC: copper, track width, edge, annular ring, drill, connectivity and outline checks OK');
