// Параметры станка и их проверка отдельно от геометрии: UI не загружает Clipper.
export type CncSide = 'top' | 'bottom';

export interface CncSettings {
  /** Расстояние от рабочего нуля станка до левого нижнего угла платы, мм. */
  originX: number;
  originY: number;
  /** Безопасный подъём над поверхностью платы (Z=0), мм. */
  safeZ: number;
  toolDiameter: number;
  clearance: number;
  isolationDepth: number;
  isolationFeed: number;
  isolationPlunge: number;
  isolationRpm: number;
  drillSide: CncSide;
  drillDepth: number;
  drillStep: number;
  drillFeed: number;
  drillRpm: number;
  cutOutline: boolean;
  outlineDiameter: number;
  outlineDepth: number;
  outlineStep: number;
  outlineFeed: number;
  outlineRpm: number;
}

/** Отправные значения, не универсальный режим резания: оператор обязан сверить их со станком. */
export const DEFAULT_CNC_SETTINGS: CncSettings = {
  originX: 5, originY: 5, safeZ: 3,
  toolDiameter: 0.4, clearance: 0.15, isolationDepth: 0.12,
  isolationFeed: 120, isolationPlunge: 60, isolationRpm: 12000,
  drillSide: 'top', drillDepth: 1.8, drillStep: 0.6, drillFeed: 80, drillRpm: 12000,
  cutOutline: false, outlineDiameter: 1, outlineDepth: 1.8, outlineStep: 0.5,
  outlineFeed: 120, outlineRpm: 12000,
};

export function cncRange(name: string, value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name}: введите число от ${min} до ${max}.`);
}

export function validateCncSettings(s: CncSettings): void {
  if (!s || typeof s !== 'object') throw new Error('Не указаны параметры ЧПУ.');
  cncRange('Отступ X от рабочего нуля', s.originX, 0, 50);
  cncRange('Отступ Y от рабочего нуля', s.originY, 0, 50);
  cncRange('Безопасная высота Z', s.safeZ, 0.5, 50);
  cncRange('Диаметр фрезы для изоляции', s.toolDiameter, 0.1, 6);
  cncRange('Зазор до меди', s.clearance, 0, 2);
  cncRange('Глубина изоляции', s.isolationDepth, 0.01, 2);
  cncRange('Подача изоляции', s.isolationFeed, 1, 5000);
  cncRange('Подача врезания', s.isolationPlunge, 1, 5000);
  cncRange('Обороты для изоляции', s.isolationRpm, 100, 60000);
  if (s.drillSide !== 'top' && s.drillSide !== 'bottom')
    throw new Error('Сторона сверловки: выберите верх или низ.');
  cncRange('Глубина сверления', s.drillDepth, 0.1, 10);
  cncRange('Шаг сверления по Z', s.drillStep, 0.1, 10);
  cncRange('Подача сверления', s.drillFeed, 1, 5000);
  cncRange('Обороты для сверления', s.drillRpm, 100, 60000);
  if (typeof s.cutOutline !== 'boolean') throw new Error('Неизвестный режим вырезания контура.');
  if (s.cutOutline) {
    cncRange('Диаметр фрезы для контура', s.outlineDiameter, 0.1, 10);
    cncRange('Глубина контура', s.outlineDepth, 0.1, 10);
    cncRange('Шаг контура по Z', s.outlineStep, 0.1, 10);
    cncRange('Подача контура', s.outlineFeed, 1, 5000);
    cncRange('Обороты для контура', s.outlineRpm, 100, 60000);
  }
}

/** Оценка меди платы (без Clipper в UI): щели, островки, габарит. */
export interface CncBoardAnalysis {
  /** Максимальный отступ центра фрезы от меди, мм, при котором островки ещё не сливаются. */
  maxOffset: number;
  /** Самая узкая щель между островками ≈ 2×maxOffset. Infinity — узких щелей нет. */
  minGap: number;
  topIslands: number;
  bottomIslands: number;
  topHoles: number;
  bottomHoles: number;
  copper: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const mm3 = (v: number) => Math.round(v * 1000) / 1000;
const TOOLS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];

/** Отступ центра фрезы от края проектной меди. */
export function isolationOffset(s: Pick<CncSettings, 'toolDiameter' | 'clearance'>): number {
  return s.toolDiameter / 2 + s.clearance;
}

/** Ширина реза — полоса снятой фольги. */
export function isolationKerf(s: Pick<CncSettings, 'toolDiameter'>): number {
  return s.toolDiameter;
}

/** Минимальная щель между двумя дорожками, чтобы фреза прошла: рез + запас с двух сторон. */
export function isolationNeed(s: Pick<CncSettings, 'toolDiameter' | 'clearance'>): number {
  return s.toolDiameter + 2 * s.clearance;
}

export function isolationFits(s: Pick<CncSettings, 'toolDiameter' | 'clearance'>, a: CncBoardAnalysis): boolean {
  if (!Number.isFinite(a.maxOffset)) return true;
  return isolationOffset(s) <= a.maxOffset + 1e-4;
}

/** Подобрать фрезу и запас под самую узкую щель платы. */
export function suggestIsolation(maxOffset: number): { toolDiameter: number; clearance: number } {
  if (!Number.isFinite(maxOffset) || maxOffset >= 3)
    return { toolDiameter: DEFAULT_CNC_SETTINGS.toolDiameter, clearance: DEFAULT_CNC_SETTINGS.clearance };
  const budget = maxOffset * 0.92;
  let best = { toolDiameter: 0.1, clearance: 0 };
  for (const t of TOOLS) {
    const r = t / 2;
    if (r > budget + 1e-9) break;
    const clearance = Math.min(0.2, Math.max(0, Math.floor((budget - r) * 100) / 100));
    if (r + clearance <= maxOffset + 1e-9) best = { toolDiameter: t, clearance };
  }
  return best;
}

/** Минимальные отступы заготовки, чтобы контур фрезы не вылез за стол. */
export function suggestOrigin(
  doc: { w: number; h: number },
  offset: number,
  copper: CncBoardAnalysis['copper'],
  cutOutline: boolean,
  outlineDiameter: number,
): { originX: number; originY: number } {
  let needX = 0, needY = 0;
  if (copper) {
    needX = Math.max(0, offset - copper.minX, copper.maxX + offset - doc.w);
    needY = Math.max(0, offset - copper.minY, copper.maxY + offset - doc.h);
  } else {
    needX = offset;
    needY = offset;
  }
  if (cutOutline) {
    needX = Math.max(needX, outlineDiameter / 2);
    needY = Math.max(needY, outlineDiameter / 2);
  }
  const round = (v: number) => Math.min(50, Math.ceil(v * 10) / 10);
  return { originX: round(needX), originY: round(needY) };
}

/**
 * Сами зазоры под плату: уменьшает запас, если текущая фреза ещё проходит,
 * и поднимает отступы стола, если контур не влезает. Диаметр фрезы не трогает —
 * это физический инструмент.
 */
export function autoFitGaps(s: CncSettings, a: CncBoardAnalysis, doc: { w: number; h: number }): { settings: CncSettings; note: string } | null {
  const patch: Partial<CncSettings> = {};
  const notes: string[] = [];
  if (Number.isFinite(a.maxOffset)) {
    const radius = s.toolDiameter / 2;
    if (radius + s.clearance > a.maxOffset + 1e-6 && radius <= a.maxOffset + 1e-6) {
      const next = Math.max(0, mm3(a.maxOffset - radius));
      if (next < s.clearance - 1e-9) {
        patch.clearance = next;
        notes.push(`Запас до меди уменьшен до ${mm3(next)} мм, иначе фреза не пройдёт в щели этой платы (${mm3(2 * a.maxOffset)} мм).`);
      }
    }
  }
  const offset = isolationOffset({ toolDiameter: s.toolDiameter, clearance: patch.clearance ?? s.clearance });
  const origin = suggestOrigin(doc, offset, a.copper, s.cutOutline, s.outlineDiameter);
  if (origin.originX > s.originX + 1e-9) {
    patch.originX = origin.originX;
    notes.push(`Отступ слева увеличен до ${origin.originX} мм, чтобы фреза не вышла за заготовку.`);
  }
  if (origin.originY > s.originY + 1e-9) {
    patch.originY = origin.originY;
    notes.push(`Отступ снизу увеличен до ${origin.originY} мм, чтобы фреза не вышла за заготовку.`);
  }
  if (!Object.keys(patch).length) return null;
  return { settings: { ...s, ...patch }, note: notes.join(' ') };
}

/** Полный подбор под плату, включая диаметр фрезы. */
export function pickForBoard(s: CncSettings, a: CncBoardAnalysis, doc: { w: number; h: number }): CncSettings {
  const iso = suggestIsolation(a.maxOffset);
  const origin = suggestOrigin(doc, isolationOffset(iso), a.copper, s.cutOutline, s.outlineDiameter);
  return {
    ...s,
    ...iso,
    originX: Math.max(s.originX, origin.originX),
    originY: Math.max(s.originY, origin.originY),
  };
}
