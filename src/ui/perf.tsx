// React-часть адаптивного качества: хук подписки и панель выбора уровня.
// Логика — в src/perf.ts (без React), здесь только представление.

import { useSyncExternalStore } from 'react';
import {
  perfProfile, setPerfMode, subscribePerf, perfMode,
  type PerfLevel, type PerfMode, type PerfProfile,
} from '../perf';

/** Текущий профиль качества; компонент перерисуется при смене уровня. */
export function usePerfProfile(): PerfProfile {
  return useSyncExternalStore(subscribePerf, perfProfile, perfProfile);
}

const LEVEL_LABEL: Record<PerfMode, { name: string; hint: string }> = {
  auto: {
    name: 'Авто',
    hint: 'Подбирать качество по устройству и по реальной скорости кадров. Рекомендуется.',
  },
  high: {
    name: 'Высокое',
    hint: 'Полная детализация: холсты в полном разрешении, эффекты, сглаживание 3D.',
  },
  balanced: {
    name: 'Среднее',
    hint: 'Компромисс: разрешение холстов до 1.5×, эффекты остаются. Помогает на ноутбуках с 4 ядрами.',
  },
  low: {
    name: 'Низкое',
    hint: 'Для слабых машин и экономии батареи: разрешение холстов 1×, без размытий и декоративных анимаций.',
  },
};

/** Панель «Качество отрисовки» для «Конструктора интерфейса». */
export function PerfBuilder() {
  const profile = usePerfProfile();
  const mode: PerfMode = perfMode();
  const levels: PerfMode[] = ['auto', 'high', 'balanced', 'low'];
  return (
    <div className="uib perf-sect">
      <div className="uib-sect-title">Качество отрисовки</div>
      <p style={{ margin: '4px 0 8px' }}>
        Сейчас: <b>{LEVEL_LABEL[mode].name}</b>
        {mode === 'auto' && <> · уровень «{LEVEL_LABEL[profile.level].name.toLowerCase()}»</>}
        {!profile.effects && ' · эффекты отключены'}
      </p>
      <div className="perf-levels" role="group" aria-label="Качество отрисовки">
        {levels.map((id) => (
          <button
            key={id}
            type="button"
            className={'btn' + (mode === id ? ' primary' : '')}
            title={LEVEL_LABEL[id].hint}
            onClick={() => setPerfMode(id)}
          >{LEVEL_LABEL[id].name}</button>
        ))}
      </div>
      <p className="perf-hint">{LEVEL_LABEL[mode].hint}</p>
      <ul className="perf-facts">
        <li>Разрешение холстов: {profile.dpr === 1 ? '1×' : `${profile.dpr}×`} от плотности экрана</li>
        <li>Эффекты интерфейса: {profile.effects ? 'включены' : 'выключены'}</li>
        <li>Сглаживание 3D: {profile.antialias ? 'включено' : 'выключено'}</li>
      </ul>
    </div>
  );
}

export type { PerfLevel };
