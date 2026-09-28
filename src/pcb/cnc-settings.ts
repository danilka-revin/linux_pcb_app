// Параметры станка и их проверка отдельно от геометрии: UI не загружает Clipper.
export type CncSide = 'top' | 'bottom';
export type CncOrigin =
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'top-left'
  | 'top-center'
  | 'top-right';

export interface CncSettings {
  /** Где находится рабочий ноль на плате. */
  origin: CncOrigin;
  /** Координата выбранного нуля в системе станка, мм. */
  originX: number;
  originY: number;
  /** Безопасный подъём над поверхностью платы (Z=0), мм. */
  safeZ: number;
  toolDiameter: number;
  clearance: number;
  isolationDepth: number;
  isolationPasses?: number;
  isolationFeed: number;
  isolationPlunge: number;
  isolationRpm: number;
  drillSide: CncSide;
  drillDepth: number;
  drillStep: number;
  drillPasses?: number;
  drillFeed: number;
  drillRpm: number;
  cutOutline: boolean;
  outlineDiameter: number;
  outlineDepth: number;
  outlineStep: number;
  outlinePasses?: number;
  outlineFeed: number;
  outlineRpm: number;
}

/** Отправные значения, не универсальный режим резания: оператор обязан сверить их со станком. */
export const DEFAULT_CNC_SETTINGS: CncSettings = {
  origin: 'bottom-left',
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

export const CNC_ORIGINS: CncOrigin[] = [
  'bottom-left', 'bottom-center', 'bottom-right',
  'center-left', 'center', 'center-right',
  'top-left', 'top-center', 'top-right',
];

export const CNC_ORIGIN_LABEL: Record<CncOrigin, string> = {
  'bottom-left': 'Слева снизу',
  'bottom-center': 'Снизу по центру',
  'bottom-right': 'Справа снизу',
  'center-left': 'Слева по центру',
  'center': 'По центру платы',
  'center-right': 'Справа по центру',
  'top-left': 'Слева сверху',
  'top-center': 'Сверху по центру',
  'top-right': 'Справа сверху',
};

export function cncOriginRef(doc: { w: number; h: number }, origin: CncOrigin): { x: number; y: number } {
  const w = doc.w, h = doc.h;
  switch (origin) {
    case 'bottom-left': return { x: 0, y: 0 };
    case 'bottom-center': return { x: w / 2, y: 0 };
    case 'bottom-right': return { x: w, y: 0 };
    case 'center-left': return { x: 0, y: h / 2 };
    case 'center': return { x: w / 2, y: h / 2 };
    case 'center-right': return { x: w, y: h / 2 };
    case 'top-left': return { x: 0, y: h };
    case 'top-center': return { x: w / 2, y: h };
    case 'top-right': return { x: w, y: h };
  }
}

export function validateCncSettings(s: CncSettings): void {
  if (!s || typeof s !== 'object') throw new Error('Не указаны параметры ЧПУ.');
  if (!CNC_ORIGINS.includes(s.origin as CncOrigin)) throw new Error('Некорректное положение нуля.');
  for (const [label, count] of [['Проходы изоляции', s.isolationPasses], ['Проходы сверления', s.drillPasses],
    ['Проходы контура', s.outlinePasses]] as const) {
    if (count !== undefined) {
      cncRange(label, count, 1, 100);
      if (!Number.isInteger(count)) throw new Error(`${label}: введите целое число.`);
    }
  }
  cncRange('Координата нуля X', s.originX, -100, 500);
  cncRange('Координата нуля Y', s.originY, -100, 500);
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

/** Минимальные координаты нуля, чтобы фреза не вылезла за стол, с учётом положения нуля. */
export function suggestOrigin(
  doc: { w: number; h: number },
  offset: number,
  copper: CncBoardAnalysis['copper'],
  cutOutline: boolean,
  outlineDiameter: number,
  origin: CncOrigin = 'bottom-left',
): { originX: number; originY: number } {
  const ref = cncOriginRef(doc, origin);
  let needX = ref.x + offset;
  let needY = ref.y + offset;
  if (copper) {
    // медь может выходить за край платы (редко), учитываем
    const minLocalX = Math.min(copper.minX, doc.w - copper.maxX);
    const minLocalY = copper.minY; // Y не зеркалится
    const maxLocalX = Math.max(copper.maxX, doc.w - copper.minX);
    const maxLocalY = copper.maxY;
    // требуем чтобы медь с отступом не уходила в минус
    const needMinX = ref.x + offset - minLocalX;
    const needMinY = ref.y + offset - minLocalY;
    // и чтобы не вылезала за правый/верхний край с запасом
    const needMaxX = ref.x - (doc.w - maxLocalX) + offset;
    const needMaxY = ref.y - (doc.h - maxLocalY) + offset;
    needX = Math.max(needX, needMinX, needMaxX);
    needY = Math.max(needY, needMinY, needMaxY);
  }
  if (cutOutline) {
    // контур режется снаружи платы на полдиаметра
    const extra = outlineDiameter / 2;
    needX = Math.max(needX, ref.x + extra, ref.x + extra + (doc.w - (doc.w)) );
    needY = Math.max(needY, ref.y + extra);
    // для центра и правых/верхних нулей нужен запас с другой стороны тоже,
    // но origin уже включает ref, а заготовка считается как w+2*margin,
    // поэтому достаточно ref+extra
    needX = Math.max(needX, ref.x + extra);
    needY = Math.max(needY, ref.y + extra);
  }
  const round = (v: number) => Math.min(500, Math.ceil(v * 10) / 10);
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
  const origin = suggestOrigin(doc, offset, a.copper, s.cutOutline, s.outlineDiameter, s.origin);
  if (origin.originX > s.originX + 1e-9) {
    patch.originX = origin.originX;
    notes.push(`Координата нуля X увеличена до ${origin.originX} мм, чтобы фреза не вышла за заготовку.`);
  }
  if (origin.originY > s.originY + 1e-9) {
    patch.originY = origin.originY;
    notes.push(`Координата нуля Y увеличена до ${origin.originY} мм, чтобы фреза не вышла за заготовку.`);
  }
  if (!Object.keys(patch).length) return null;
  return { settings: { ...s, ...patch }, note: notes.join(' ') };
}

/** Полный подбор под плату, включая диаметр фрезы. */
export function pickForBoard(s: CncSettings, a: CncBoardAnalysis, doc: { w: number; h: number }): CncSettings {
  const iso = suggestIsolation(a.maxOffset);
  const origin = suggestOrigin(doc, isolationOffset(iso), a.copper, s.cutOutline, s.outlineDiameter, s.origin);
  return {
    ...s,
    ...iso,
    originX: Math.max(s.originX, origin.originX),
    originY: Math.max(s.originY, origin.originY),
  };
}

/** Explicit counts split the final depth evenly. Old saved step-based settings remain valid. */
export function cncDepths(depth: number, step: number, count?: number): number[] {
  const passes = count ?? Math.ceil(depth / step - 1e-9);
  return Array.from({ length: passes }, (_, i) => count !== undefined
    ? depth * (i + 1) / passes : Math.min(depth, (i + 1) * step));
}
