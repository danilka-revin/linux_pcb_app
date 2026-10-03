// Производительность: адаптивное качество отрисовки под слабые устройства.
//
// Уровни качества (профили):
//   high     — максимум детализации: холсты в DPR до 2, эффекты, сглаживание 3D;
//   balanced — середина: DPR до 1.5, эффекты остаются;
//   low      — слабые машины: DPR 1, без backdrop-filter и декоративных анимаций,
//              без сглаживания в 3D и с более крупным шагом сетки в тяжёлых видах.
//
// Режим по умолчанию — «авто»: стартовый уровень оценивается по железу (ядра,
// память, плотность пикселей, тач-ввод), а затем уточняется по реальному времени
// кадров, которое сообщают холсты редактора и 3D-просмотр (perf.noteFrame).
// Если машина тянет — уровень поднимается обратно (медленно, чтобы не мигало),
// если кадры стабильно тяжёлые — опускается (быстро).
//
// Пользователь может зафиксировать уровень: «Конструктор интерфейса» → «Качество
// отрисовки» (хранится в localStorage 'psbees.perf').
//
// Модуль не тянет React на себя: логика доступна и в воркерах/тестах. Хук
// usePerfProfile и панель выбора уровня — в src/ui/perf.tsx.

export type PerfLevel = 'high' | 'balanced' | 'low';
export type PerfMode = 'auto' | PerfLevel;

export const PERF_KEY = 'psbees.perf';

/** Профиль качества: что именно меняется при переходе на уровень. */
export interface PerfProfile {
  level: PerfLevel;
  /** Предел devicePixelRatio для холстов (меньше пикселей — быстрее кадр). */
  dpr: number;
  /** CSS-эффекты: backdrop-filter, декоративные анимации, тени. */
  effects: boolean;
  /** Сглаживание WebGL (MSAA) в 3D-просмотре. */
  antialias: boolean;
  /** Как часто (мс) допускается пересчитывать «живые» подсказки (DRC под курсором). */
  liveMs: number;
}

const LEVELS: PerfLevel[] = ['low', 'balanced', 'high'];

const PROFILES: Record<PerfLevel, PerfProfile> = {
  high: { level: 'high', dpr: 2, effects: true, antialias: true, liveMs: 0 },
  balanced: { level: 'balanced', dpr: 1.5, effects: true, antialias: true, liveMs: 60 },
  low: { level: 'low', dpr: 1, effects: false, antialias: false, liveMs: 160 },
};

export const PERF_LEVELS = LEVELS;
export const PERF_PROFILES = PROFILES;

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

function readMode(): PerfMode {
  if (!isBrowser) return 'auto';
  try {
    const raw = localStorage.getItem(PERF_KEY);
    if (raw === 'high' || raw === 'balanced' || raw === 'low' || raw === 'auto') return raw;
  } catch { /* приватный режим / SSR */ }
  return 'auto';
}

/** Грубая оценка железа: чем выше балл, тем мощнее машина. */
function deviceScore(): number {
  if (!isBrowser) return 0;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 4;
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0; // ГБ, только Chromium
  const dpr = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
  let score = 0;
  if (cores <= 2) score -= 2; else if (cores <= 4) score -= 1; else if (cores >= 8) score += 1;
  if (mem) { if (mem <= 2) score -= 2; else if (mem <= 4) score -= 1; else if (mem >= 8) score += 1; }
  // Больше пикселей на кадр (Retina/4K) — дороже заливка холстов.
  if (dpr >= 3) score -= 2; else if (dpr >= 2) score -= 1;
  // Тач-устройства обычно слабее и экономнее по батарее.
  try { if (window.matchMedia('(pointer: coarse)').matches) score -= 1; } catch { /* нет matchMedia */ }
  return score;
}

function detectLevel(): PerfLevel {
  const score = deviceScore();
  if (score <= -2) return 'low';
  if (score <= 0) return 'balanced';
  return 'high';
}

let mode: PerfMode = readMode();
/** Потолок для режима «авто»: выше стартовой оценки не поднимаемся. */
let ceiling: PerfLevel = mode === 'auto' ? detectLevel() : mode;
let profile: PerfProfile = PROFILES[mode === 'auto' ? ceiling : mode];
const listeners = new Set<() => void>();

function applyProfile(next: PerfProfile): void {
  const changed = next.level !== profile.level;
  profile = next;
  if (!isBrowser) return;
  // Признак для CSS: html[data-perf="low"] отключает тяжёлые эффекты.
  document.documentElement.dataset.perf = profile.level;
  document.documentElement.dataset.perfEffects = profile.effects ? 'on' : 'off';
  if (changed) for (const cb of Array.from(listeners)) { try { cb(); } catch { /* подписчик упал — не мешаем остальным */ } }
}

/** Старт: применить уровень и, в режиме «авто», следить за кадрами. */
export function initPerf(): PerfProfile {
  mode = readMode();
  ceiling = mode === 'auto' ? detectLevel() : mode;
  applyProfile(PROFILES[mode === 'auto' ? ceiling : mode]);
  return profile;
}

export function perfProfile(): PerfProfile { return profile; }

export function perfMode(): PerfMode { return mode; }

/** Предел DPR для холстов редактора (без учёта window.devicePixelRatio). */
export function perfDprCap(): number { return profile.dpr; }

/** Реальный DPR холста: системный, но не выше предела профиля. */
export function perfDpr(): number {
  if (!isBrowser) return 1;
  const sys = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.min(sys, profile.dpr);
}

export function subscribePerf(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setLevel(level: PerfLevel): void {
  if (profile.level === level) return;
  applyProfile(PROFILES[level]);
}

/** Ручная фиксация режима (null = авто). */
export function setPerfMode(next: PerfMode): void {
  mode = next;
  try { localStorage.setItem(PERF_KEY, next); } catch { /* приватный режим */ }
  if (next === 'auto') {
    ceiling = detectLevel();
    setLevel(ceiling);
  } else {
    ceiling = next;
    setLevel(next);
  }
  for (const cb of Array.from(listeners)) { try { cb(); } catch { /* см. выше */ } }
}

// ---------------- адаптация по реальному времени кадров ----------------
// Сэмплы приходят из уже существующих кадров (движение мыши, панорама, 3D),
// поэтому собственную петлю requestAnimationFrame мы не заводим: на слабых
// устройствах лишний постоянный цикл сам по себе стоит батареи и CPU.

const WINDOW = 48;
const SLOW_MS = 22;   // кадр дольше — уже заметно (меньше 45 fps)
const FAST_MS = 12;   // кадр короче — запас есть
const PROMOTE_WINDOWS = 4; // столько «быстрых» окон подряд нужно для подъёма уровня

let slow = 0;
let fast = 0;
let goodWindows = 0;

/**
 * Сообщить длительность кадра отрисовки (мс). Вызывается холстами редактора
 * и 3D-просмотром. В режиме «авто» по накопленным кадрам уровень опускается
 * (если кадры тяжёлые) или возвращается к стартовой оценке (если есть запас).
 */
export function noteFrame(ms: number): void {
  if (mode !== 'auto' || !(ms >= 0) || ms > 2000) return;
  if (ms > SLOW_MS) { slow++; goodWindows = 0; }
  else if (ms < FAST_MS) fast++;
  const total = slow + fast;
  if (total < WINDOW) return;
  const slowShare = slow / total;
  slow = 0; fast = 0;
  const idx = LEVELS.indexOf(profile.level);
  if (slowShare >= 0.5 && idx > 0) {
    // Больше половины кадров тяжёлые — опускаемся на шаг вниз.
    goodWindows = 0;
    setLevel(LEVELS[idx - 1]);
    return;
  }
  const ceilIdx = LEVELS.indexOf(ceiling);
  if (slowShare <= 0.1 && idx < ceilIdx) {
    // Кадры стабильно быстрые — не спешим: ждём несколько окон подряд.
    goodWindows++;
    if (goodWindows >= PROMOTE_WINDOWS) { goodWindows = 0; setLevel(LEVELS[idx + 1]); }
  } else if (slowShare > 0.1) {
    goodWindows = 0;
  }
}

/** Сбросить накопленную статистику (например, при смене проекта). */
export function resetPerfSamples(): void {
  slow = 0; fast = 0; goodWindows = 0;
}
