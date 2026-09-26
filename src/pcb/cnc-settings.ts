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
