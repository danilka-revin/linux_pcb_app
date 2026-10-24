// Переключатель режимов рабочего пространства PSBees в шапке программы:
// 1. «Платы» — редактор печатных плат (Sprint-Layout / Gerber / ЧПУ)
// 2. «Лазерный» — векторный редактор развёрток и лазерной резки (в стиле CorelDRAW + LightBurn)
// 3. «3D моделирование» — раздел твердотельного 3D-моделирования («Скоро в разработке»)

import { Ic } from './icons';

export type WorkspaceMode = 'pcb' | 'laser' | '3d';

export const WORKSPACE_MODE_KEY = 'psbees.workspace.mode';

export function loadWorkspaceMode(): WorkspaceMode {
  try {
    const v = localStorage.getItem(WORKSPACE_MODE_KEY);
    if (v === 'pcb' || v === 'laser' || v === '3d') return v;
  } catch { /* ignore */ }
  return 'pcb';
}

export function saveWorkspaceMode(mode: WorkspaceMode): void {
  try {
    localStorage.setItem(WORKSPACE_MODE_KEY, mode);
  } catch { /* ignore */ }
}

export function ModeSwitcher({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
}) {
  return (
    <div className="tb-group mode-switcher" role="tablist" aria-label="Режим работы PSBees">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'pcb'}
        className={'mode-tab' + (mode === 'pcb' ? ' active' : '')}
        title="Редактор печатных плат (дорожки, компоненты, автотрассировка, Gerber, фрезеровка ЧПУ)"
        onClick={() => onChange('pcb')}
      >
        <Ic n="board" size={16} />
        <span>Платы</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'laser'}
        className={'mode-tab' + (mode === 'laser' ? ' active' : '')}
        title="Лазерный станок и развёртка (векторный редактор в стиле CorelDRAW, генератор развёрток, экспорт DXF / SVG / G-Code)"
        onClick={() => onChange('laser')}
      >
        <Ic n="laser" size={16} />
        <span>Лазерный</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === '3d'}
        className={'mode-tab' + (mode === '3d' ? ' active' : '')}
        title="3D-моделирование корпусов и деталей (скоро в разработке)"
        onClick={() => onChange('3d')}
      >
        <Ic n="cube" size={16} />
        <span>3D моделирование</span>
        <em className="mode-soon-badge">скоро</em>
      </button>
    </div>
  );
}
