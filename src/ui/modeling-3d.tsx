// Экран раздела «3D моделирование» («Скоро в разработке») в фирменном стиле PSBees.

import { Ic } from './icons';
import { ModeSwitcher, type WorkspaceMode } from './mode-switcher';
import type { ThemeId } from '../pcb/render';

export function Modeling3DView({
  mode,
  onModeChange,
  theme,
  onToggleTheme,
  onOpenPcb3DPreview,
  onCloseApp,
  boardName,
  boardW,
  boardH,
}: {
  mode: WorkspaceMode;
  onModeChange: (next: WorkspaceMode) => void;
  theme: ThemeId;
  onToggleTheme: () => void;
  onOpenPcb3DPreview: () => void;
  onCloseApp: () => void;
  boardName: string;
  boardW: number;
  boardH: number;
}) {
  return (
    <>
      <div className="toolbar">
        <div className="brand">
          <span className="brandmark">
            <img src="/logo.png" alt="" width={32} height={32} draggable={false} />
          </span>
          <span className="brandtext">
            <b>PS<em>Bees</em></b>
            <small>3D CAD · КОРПУСА · МОДЕЛИРОВАНИЕ</small>
          </span>
        </div>

        <ModeSwitcher mode={mode} onChange={onModeChange} />

        <div style={{ flex: 1 }} />

        <div className="tb-group">
          <button
            type="button"
            className="tb-btn wide"
            title="Открыть 3D-предпросмотр текущей печатной платы"
            onClick={onOpenPcb3DPreview}
          >
            <Ic n="preview3d" />
            <span>3D-вид платы «{boardName}»</span>
          </button>
        </div>

        <div className="tb-group">
          <button
            type="button"
            className="tb-btn"
            title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            onClick={onToggleTheme}
          >
            <Ic n={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>

        <div className="tb-group toolbar-exit" aria-label="Выход">
          <button
            type="button"
            className="tb-btn close-app"
            title="Закрыть приложение / сайт"
            aria-label="Закрыть приложение или вкладку"
            onClick={onCloseApp}
          >
            <Ic n="close" />
          </button>
        </div>
      </div>

      <div className="main modeling-3d-main">
        <div className="modeling-3d-card">
          <div className="modeling-3d-hero">
            <div className="modeling-3d-graphic" aria-hidden="true">
              <svg viewBox="0 0 220 200" width="190" height="172" fill="none">
                {/* Фоновые соты PSBees */}
                <polygon
                  points="110,16 178,55 178,133 110,172 42,133 42,55"
                  stroke="var(--accent)"
                  strokeOpacity="0.22"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
                <polygon
                  points="110,32 164,63 164,125 110,156 56,125 56,63"
                  fill="var(--accent-soft)"
                  stroke="var(--accent)"
                  strokeOpacity="0.45"
                  strokeWidth="1.6"
                />
                {/* Изометрический 3D-корпус с печатной платой внутри */}
                <path
                  d="M110 46 L156 72 L156 118 L110 144 L64 118 L64 72 Z"
                  fill="var(--surface-2)"
                  stroke="var(--accent)"
                  strokeWidth="2.4"
                  strokeLinejoin="round"
                />
                <path
                  d="M64 72 L110 98 L156 72 M110 98 L110 144"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Внутренний контур платы и размерные засечки */}
                <path
                  d="M78 74 L110 56 L142 74 L110 92 Z"
                  fill="rgba(34, 197, 94, 0.18)"
                  stroke="#22c55e"
                  strokeWidth="1.6"
                />
                <circle cx="110" cy="46" r="4" fill="var(--accent)" />
                <circle cx="156" cy="72" r="4" fill="var(--accent)" />
                <circle cx="64" cy="72" r="4" fill="var(--accent)" />
                <circle cx="110" cy="98" r="4.5" fill="var(--accent)" />
                <circle cx="110" cy="144" r="4" fill="var(--accent)" />
              </svg>
            </div>

            <div className="modeling-3d-copy">
              <div className="modeling-3d-badge">
                <span className="pulse" />
                <span>СКОРО В РАЗРАБОТКЕ</span>
              </div>
              <h1>3D-моделирование корпусов и деталей</h1>
              <p className="modeling-3d-lead">
                Полноценная среда 3D-моделирования скоро появится в PSBees — раздел сейчас находится в активной разработке.
                Здесь вы сможете проектировать объёмные корпуса под ваши печатные платы ({boardW}×{boardH} мм),
                складывать плоские развёртки из редактора чертежей в 3D-сборку и экспортировать модели для 3D-печати.
              </p>

              <div className="modeling-3d-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => onModeChange('laser')}
                >
                  <Ic n="bezier" size={16} />
                  <span>Открыть редактор чертежей и развёртки</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={onOpenPcb3DPreview}
                >
                  <Ic n="preview3d" size={16} />
                  <span>3D-предпросмотр текущей платы</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onModeChange('pcb')}
                >
                  <Ic n="board" size={16} />
                  <span>Вернуться к редактору плат</span>
                </button>
              </div>
            </div>
          </div>

          <div className="modeling-3d-grid">
            <div className="modeling-3d-feature">
              <div className="modeling-3d-feat-head">
                <Ic n="cube" size={18} />
                <b>Твердотельное 3D-моделирование</b>
                <span className="feat-tag">В разработке</span>
              </div>
              <p>
                Параметрические эскизы, выдавливание (Extrude), вырезы, фаски, скругления, бобышки под винты M2/M2.5/M3 и защёлки корпусов.
              </p>
            </div>

            <div className="modeling-3d-feature">
              <div className="modeling-3d-feat-head">
                <Ic n="unfold" size={18} />
                <b>Сборка 3D из развёрток</b>
                <span className="feat-tag">Интеграция</span>
              </div>
              <p>
                Автоматическое сгибание листовых развёрток и сборка шиповых коробок из раздела «Лазерный» с проверкой пересечений стенок.
              </p>
            </div>

            <div className="modeling-3d-feature">
              <div className="modeling-3d-feat-head">
                <Ic n="board" size={18} />
                <b>Примерка платы внутри корпуса</b>
                <span className="feat-tag">Синхронизация</span>
              </div>
              <p>
                Прямая подгрузка 3D-модели вашей печатной платы со всеми компонентами и разъёмами для точной подгонки окон в корпусе.
              </p>
            </div>

            <div className="modeling-3d-feature">
              <div className="modeling-3d-feat-head">
                <Ic n="gerber" size={18} />
                <b>Экспорт STL · STEP · 3MF · OBJ</b>
                <span className="feat-tag">3D-печать и ЧПУ</span>
              </div>
              <p>
                Готовые файлы для слайсеров 3D-принтеров (BambuStudio, PrusaSlicer, Cura) и твердотельный обмен с CAD-системами.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="status">
        <span>Режим: <b>3D моделирование</b></span>
        <span>Статус: <b style={{ color: 'var(--accent-text)' }}>Скоро в разработке</b></span>
        <span className="sp" />
        <span>Связанная плата: <b>{boardName} ({boardW}×{boardH} мм)</b></span>
      </div>
    </>
  );
}
