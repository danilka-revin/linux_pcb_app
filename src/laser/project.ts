// Файл проекта лазерного редактора (.pslaser) и черновик в хранилище браузера.
// Логика отделена от интерфейса, чтобы её можно было проверять без DOM.

import {
  DEFAULT_LASER_LAYERS,
  LASER_LAYER_ORDER,
  MATERIAL_PRESETS,
  newLaserDoc,
  type LaserDoc,
  type LaserLayerConfig,
} from './model';

export const LASER_PROJECT_APP = 'psbees';
export const LASER_PROJECT_KIND = 'laser';
export const LASER_PROJECT_VERSION = 1;

export function laserDraftKey(userId?: string): string {
  return userId ? `psbees.laser.draft.${userId}` : 'psbees.laser.draft';
}

/** Имя файла без опасных символов (как в библиотеке деталей). */
export function safeFileName(name: string): string {
  return (
    (name.trim() || 'razvyortka')
      .replace(/[^\w\dа-яА-ЯёЁ ._-]+/g, '_')
      .replace(/\s+/g, '_')
      // «Корпус /прибора» → «Корпус_прибора», а не «Корпус__прибора»
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'razvyortka'
  );
}

/**
 * Приведение загруженного проекта к рабочей структуре: старые файлы, ручные
 * правки JSON и неполные слои не должны ронять редактор.
 */
export function normalizeLaserDoc(raw: unknown): LaserDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<LaserDoc> & Record<string, unknown>;
  if (!Array.isArray(d.shapes)) return null;
  const base = newLaserDoc();

  const layers = { ...base.layers };
  if (d.layers && typeof d.layers === 'object') {
    const saved = d.layers as Record<string, Partial<LaserLayerConfig>>;
    for (const id of LASER_LAYER_ORDER) {
      const l = saved[id];
      if (l && typeof l === 'object') layers[id] = { ...DEFAULT_LASER_LAYERS[id], ...l, id };
    }
  }

  const w = Number(d.w);
  const h = Number(d.h);
  const thickness = Number(d.materialThickness);
  const shapes = (d.shapes as LaserDoc['shapes']).filter(
    (s) => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.kind === 'string'
  );

  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name.slice(0, 120) : base.name,
    w: Number.isFinite(w) && w >= 20 ? Math.min(5000, w) : base.w,
    h: Number.isFinite(h) && h >= 20 ? Math.min(5000, h) : base.h,
    materialThickness: Number.isFinite(thickness) && thickness > 0 ? Math.min(100, thickness) : base.materialThickness,
    materialPresetId:
      typeof d.materialPresetId === 'string' && MATERIAL_PRESETS.some((m) => m.id === d.materialPresetId)
        ? d.materialPresetId
        : base.materialPresetId,
    layers,
    shapes,
    groups: Array.isArray(d.groups) ? (d.groups as LaserDoc['groups']) : [],
  };
}

/** Полный файл проекта. */
export function serializeLaserProject(doc: LaserDoc): string {
  return JSON.stringify(
    { app: LASER_PROJECT_APP, kind: LASER_PROJECT_KIND, version: LASER_PROJECT_VERSION, doc },
    null,
    2
  );
}

/** Чтение файла проекта; null — это не проект PSBees Laser. */
export function parseLaserProject(text: string): LaserDoc | null {
  try {
    const parsed = JSON.parse(text) as { doc?: unknown; kind?: unknown };
    if (parsed && parsed.kind && parsed.kind !== LASER_PROJECT_KIND) return null;
    return normalizeLaserDoc(parsed?.doc ?? parsed);
  } catch {
    return null;
  }
}

/** Черновик из хранилища браузера (sessionStorage для общего сервера). */
export function loadLaserDraft(userId?: string): LaserDoc | null {
  try {
    const store = typeof sessionStorage !== 'undefined' && userId ? sessionStorage : localStorage;
    const raw = store?.getItem(laserDraftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { doc?: unknown };
    return normalizeLaserDoc(parsed?.doc ?? parsed);
  } catch {
    return null;
  }
}

/** Сохранение черновика; ошибки хранилища (приватный режим) не мешают работе. */
export function saveLaserDraft(doc: LaserDoc, userId?: string): boolean {
  try {
    const store = userId && typeof sessionStorage !== 'undefined' ? sessionStorage : localStorage;
    store?.setItem(laserDraftKey(userId), JSON.stringify({ doc, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
