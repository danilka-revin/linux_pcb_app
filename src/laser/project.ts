// Файл проекта лазерного редактора (.pslaser) и черновик в хранилище браузера.
// Логика отделена от интерфейса, чтобы её можно было проверять без DOM.

import {
  DEFAULT_LASER_LAYERS,
  LAYER_PALETTE,
  LAYER_ROLES,
  MATERIAL_PRESETS,
  makeLaserLayer,
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
 * правки JSON и неполные слои не должны ронять редактор. Слои у документа
 * свои — сохраняются все, что есть в файле, вместе с их порядком.
 */
export function normalizeLaserDoc(raw: unknown): LaserDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<LaserDoc> & Record<string, unknown>;
  if (!Array.isArray(d.shapes)) return null;
  const base = newLaserDoc();

  const layers: Record<string, LaserLayerConfig> = {};
  const found: string[] = [];
  if (d.layers && typeof d.layers === 'object') {
    const saved = d.layers as Record<string, Partial<LaserLayerConfig>>;
    for (const [id, l] of Object.entries(saved)) {
      if (!id || !l || typeof l !== 'object') continue;
      const fallback =
        DEFAULT_LASER_LAYERS[id] ??
        makeLaserLayer(
          id,
          typeof l.short === 'string' && l.short.trim() ? l.short : `Слой ${found.length + 1}`,
          LAYER_PALETTE[found.length % LAYER_PALETTE.length],
          l.mode ?? 'cut'
        );
      layers[id] = { ...fallback, ...l, id };
      found.push(id);
    }
  }

  // Порядок: свой список из файла, затем исторические роли, затем остальные.
  const savedOrder = Array.isArray(d.layerOrder)
    ? (d.layerOrder as unknown[]).filter((x): x is string => typeof x === 'string' && !!layers[x])
    : [];
  const layerOrder = [
    ...savedOrder,
    ...LAYER_ROLES.filter((id) => layers[id] && !savedOrder.includes(id)),
    ...found.filter((id) => !savedOrder.includes(id)),
  ];
  if (!layerOrder.length) {
    layers[base.layerOrder![0]] = base.layers[base.layerOrder![0]];
    layerOrder.push(base.layerOrder![0]);
  }

  const w = Number(d.w);
  const h = Number(d.h);
  const thickness = Number(d.materialThickness);
  const first = layerOrder[0];
  const shapes = (d.shapes as LaserDoc['shapes'])
    .filter((s) => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.kind === 'string')
    // объект на отсутствующем слое не теряется — переносим на первый существующий
    .map((s) => (layers[s.layer] ? s : { ...s, layer: first }));

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
    layerOrder,
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
