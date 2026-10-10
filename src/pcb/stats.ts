// Статистика платы: габарит, длина дорожек, площадь меди и процент заполнения,
// число отверстий и состав элементов. Точная площадь меди считается объединением
// (clipper, как в ЧПУ), при слишком сложной геометрии — приблизительная сумма.

import type { Doc, Entity } from './model';
import { expandDoc } from './expand';
import { boardShape } from './board-shape';
import { boardInventory } from './inventory';
import { polylineLength } from './trackcalc';
import { copperAreaOf } from './cnc';
import { ringArea } from './imagetrace';

export interface LayerCopper {
  /** длина дорожек, мм */
  trackLen: number;
  /** площадь меди, мм² (точная, если удалось объединить) */
  area: number;
  /** площадь посчитана приближённо (очень сложная геометрия) */
  approx: boolean;
  tracks: number;
}

export interface BoardStats {
  /** габарит платы (по контуру или рабочему полю), мм */
  width: number;
  height: number;
  /** площадь подложки, мм² (внешний контур минус вырезы) */
  boardArea: number;
  k1: LayerCopper;
  k2: LayerCopper;
  /** суммарная длина дорожек, мм */
  trackLen: number;
  /** площадь меди всего (оба слоя), мм² */
  copperArea: number;
  /** доля меди от площади платы, % (оба слоя вместе) */
  fillPct: number;
  pads: number;
  smd: number;
  vias: number;
  holes: number;
  comps: number;
  texts: number;
  dims: number;
  polys: number;
  /** длиннейшая дорожка, мм */
  longestTrack: number;
}

function approxArea(ents: Entity[], layer: 'k1' | 'k2'): number {
  let a = 0;
  for (const e of ents) {
    switch (e.kind) {
      case 'pad': a += Math.PI * (e.size / 2) ** 2; break;
      case 'via': a += Math.PI * (e.size / 2) ** 2; break;
      case 'smd': if (e.layer === layer) a += e.w * e.h; break;
      case 'track':
        if (e.layer === layer) a += polylineLength(e.pts) * e.w;
        break;
      case 'line':
        if (e.layer === layer) a += polylineLength([{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }]) * e.w;
        break;
      case 'circle':
        if (e.layer === layer) a += 2 * Math.PI * e.r * e.w;
        break;
      case 'rect':
        if (e.layer === layer) a += e.filled ? e.w * e.h : 2 * (e.w + e.h) * e.th;
        break;
      case 'poly':
        if (e.layer === layer && e.pts.length > 2) {
          a += Math.abs(ringArea(e.pts));
          for (const hole of e.holes ?? []) a -= Math.abs(ringArea(hole));
        }
        break;
      default: break;
    }
  }
  return Math.max(0, a);
}

function layerStats(flat: Entity[], layer: 'k1' | 'k2'): LayerCopper {
  let trackLen = 0, tracks = 0;
  for (const e of flat) {
    if (e.kind === 'track' && e.layer === layer) {
      tracks++;
      trackLen += polylineLength(e.pts);
    }
  }
  let area = 0, approx = false;
  try {
    const exact = copperAreaOf(flat, layer);
    if (exact === null) { approx = true; area = approxArea(flat, layer); }
    else area = exact;
  } catch {
    approx = true;
    area = approxArea(flat, layer);
  }
  return { trackLen, area, approx, tracks };
}

export function boardStats(doc: Doc): BoardStats {
  const flat = expandDoc(doc.entities);
  const k1 = layerStats(flat, 'k1');
  const k2 = layerStats(flat, 'k2');

  // габарит и площадь подложки: замкнутый контур, иначе рабочее поле
  let width = doc.w, height = doc.h, boardArea = doc.w * doc.h;
  try {
    const shape = boardShape(doc, flat);
    if (!shape.fallback && shape.regions.length) {
      width = shape.bounds[2] - shape.bounds[0];
      height = shape.bounds[3] - shape.bounds[1];
      boardArea = 0;
      for (const r of shape.regions) {
        boardArea += Math.abs(ringArea(r.outer));
        for (const hole of r.holes) boardArea -= Math.abs(ringArea(hole));
      }
      boardArea = Math.max(0, boardArea);
    }
  } catch {
    /* контур не замкнут — оставляем рабочее поле */
  }

  const inv = boardInventory(doc.entities);
  let comps = 0, texts = 0, dims = 0, polys = 0, pads = 0, smd = 0, vias = 0, holes = 0;
  let longestTrack = 0;
  for (const e of flat) {
    switch (e.kind) {
      case 'pad': pads++; break;
      case 'smd': smd++; break;
      case 'via': vias++; break;
      case 'hole': holes++; break;
      case 'comp': comps++; break;
      case 'text': texts++; break;
      case 'dim': dims++; break;
      case 'poly': polys++; break;
      case 'track':
        longestTrack = Math.max(longestTrack, polylineLength(e.pts));
        break;
      default: break;
    }
  }
  // отверстия: свёрла в площадках/переходах + монтажные (точный перечень — в inventory)
  holes = inv.totals.holes;

  const copperArea = k1.area + k2.area;
  const trackLen = k1.trackLen + k2.trackLen;
  return {
    width, height, boardArea,
    k1, k2, trackLen, copperArea,
    fillPct: boardArea > 0 ? (copperArea / boardArea) * 100 : 0,
    pads, smd, vias, holes, comps, texts, dims, polys,
    longestTrack,
  };
}
