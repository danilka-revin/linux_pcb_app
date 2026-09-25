// Диалоги приложения.
import { useState } from 'react';
import { Modal, NI, TI } from './widgets';
import { ACCENT_PRESETS, THEME_BASE, type CustomColors } from './palette';
import type { ThemeId } from '../pcb/render';

export interface ExportPngOpts {
  layer: 'k1' | 'k2' | 's1' | 's2' | 'outline';
  mirror: boolean;
  drill: boolean;
  dpi: number;
}

export function NewBoardDialog({
  onOk, onClose,
}: {
  onOk: (name: string, w: number, h: number) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('Плата');
  const [w, setW] = useState(100);
  const [h, setH] = useState(80);
  return (
    <Modal
      title="Новая плата"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={() => onOk(name || 'Плата', w, h)}>Создать</button>
        </>
      }
    >
      <TI label="Название" value={name} on={setName} />
      <NI label="Ширина, мм" value={w} min={5} max={500} on={setW} />
      <NI label="Высота, мм" value={h} min={5} max={500} on={setH} />
      <p>На плате будет создан прямоугольный контур заданного размера. Начало координат — левый нижний угол.</p>
    </Modal>
  );
}

export function ExportDialog({
  onGerber, onPng, onLay6, onLmk, selCount, onClose,
}: {
  onGerber: () => void;
  onPng: (o: ExportPngOpts) => void;
  onLay6: () => void;
  onLmk: () => void;
  selCount: number;
  onClose: () => void;
}) {
  const [layer, setLayer] = useState<ExportPngOpts['layer']>('k2');
  const [mirror, setMirror] = useState(true);
  const [drill, setDrill] = useState(true);
  const [dpi, setDpi] = useState(600);
  return (
    <Modal
      title="Экспорт"
      onClose={onClose}
      foot={<button className="btn" onClick={onClose}>Закрыть</button>}
    >
      <h3 style={{ margin: '4px 0 6px', fontSize: 13 }}>Производство (Gerber + сверловка)</h3>
      <p>
        ZIP-архив: верхняя и нижняя медь (RS-274X), обе шелкографии, контур платы и файл
        сверловки Excellon. Подходит для заводов (JLCPCB и др.) и ЧПУ.
      </p>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn primary" onClick={() => { onGerber(); onClose(); }}>
          Скачать Gerber ZIP
        </button>
      </div>

      <div className="sect">
        <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Sprint-Layout</h3>
        <p>Совместимость с Sprint-Layout 6: плата целиком как .lay6, выделенные элементы — как макрос .lmk.</p>
        <div className="row" style={{ marginTop: 4, gap: 8 }}>
          <button className="btn primary" onClick={() => { onLay6(); onClose(); }}>
            Сохранить плату как .lay6
          </button>
          <button className="btn" disabled={!selCount} onClick={() => { onLmk(); onClose(); }}
            title={selCount ? `Выделено элементов: ${selCount}` : 'Сначала выделите элементы платy'}>
            Выделенное как .lmk{selCount ? ` (${selCount})` : ''}
          </button>
        </div>
      </div>

      <div className="sect">
        <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Печать 1:1 (ЛУТ / фотошаблон)</h3>
        <div className="radio-row">
          {([['k1', 'Верхняя медь (K1)'], ['k2', 'Нижняя медь (K2)'], ['s1', 'Шелк. верх'], ['s2', 'Шелк. низ'], ['outline', 'Контур']] as const).map(([v, t]) => (
            <label key={v}>
              <input type="radio" checked={layer === v} onChange={() => setLayer(v)} />
              {t}
            </label>
          ))}
        </div>
        <label className="chk">
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
          Зеркально (для ЛУТ)
        </label>
        <label className="chk">
          <input type="checkbox" checked={drill} onChange={(e) => setDrill(e.target.checked)} />
          Метки центров отверстий
        </label>
        <div className="radio-row" style={{ marginTop: 10 }}>
          {[300, 600, 1200].map((d) => (
            <label key={d}>
              <input type="radio" checked={dpi === d} onChange={() => setDpi(d)} />
              {d} dpi
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={() => { onPng({ layer, mirror, drill, dpi }); onClose(); }}
          >
            Скачать PNG
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function PanelizeDialog({
  defX, defY, onOk, onClose,
}: {
  defX: number;
  defY: number;
  onOk: (cols: number, rows: number, gx: number, gy: number) => void;
  onClose: () => void;
}) {
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(1);
  const [gx, setGx] = useState(defX);
  const [gy, setGy] = useState(defY);
  return (
    <Modal
      title="Размножить плату (панелизация)"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={() => onOk(cols, rows, gx, gy)}>Применить</button>
        </>
      }
    >
      <NI label="Колонок (по X)" value={cols} min={1} max={10} step={1} on={setCols} />
      <NI label="Рядов (по Y)" value={rows} min={1} max={10} step={1} on={setRows} />
      <NI label="Шаг по X, мм" value={gx} min={1} on={setGx} />
      <NI label="Шаг по Y, мм" value={gy} min={1} on={setGy} />
      <p>Все элементы платы будут продублированы сеткой колонки × ряды с заданным шагом.</p>
    </Modal>
  );
}

/** Кастомизация цветов интерфейса: акцент, фон, панели, текст. Живой предпросмотр. */
export function ColorsDialog({
  colors, theme, setColors, onClose,
}: {
  colors: CustomColors;
  theme: ThemeId;
  setColors: (c: CustomColors) => void;
  onClose: () => void;
}) {
  const base = THEME_BASE[theme];
  const set = (k: keyof CustomColors, v: string) => setColors({ ...colors, [k]: v });
  const reset = (k: keyof CustomColors) => {
    const next = { ...colors };
    delete next[k];
    setColors(next);
  };
  const fields: [keyof CustomColors, string][] = [
    ['page', 'Фон'],
    ['surface', 'Панели'],
    ['text', 'Текст'],
  ];
  return (
    <Modal
      title="Цвета интерфейса"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={() => setColors({})}>Сбросить всё</button>
          <button className="btn primary" onClick={onClose}>Готово</button>
        </>
      }
    >
      <h3 style={{ margin: '4px 0 6px', fontSize: 13 }}>Акцентный цвет</h3>
      <div className="swatches">
        <button
          className={'swatch auto' + (colors.accent ? '' : ' on')}
          title="Как в теме" onClick={() => reset('accent')}
        />
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.hex}
            className={'swatch' + (colors.accent?.toLowerCase() === p.hex ? ' on' : '')}
            title={p.name}
            style={{ background: p.hex }}
            onClick={() => set('accent', p.hex)}
          />
        ))}
        <label className="swatch custom" title="Свой цвет">
          <input
            type="color"
            value={colors.accent ?? base.accent}
            onChange={(e) => set('accent', e.target.value)}
          />
        </label>
      </div>

      <h3 style={{ margin: '16px 0 6px', fontSize: 13 }}>Фон, панели и текст</h3>
      <div className="color-fields">
        {fields.map(([k, label]) => (
          <span className="color-field" key={k}>
            <input
              type="color"
              value={colors[k] ?? base[k]}
              onChange={(e) => set(k, e.target.value)}
            />
            {label}
            {colors[k] && (
              <button className="color-reset" title="Вернуть цвет темы" onClick={() => reset(k)}>×</button>
            )}
          </span>
        ))}
      </div>
      <p>
        Изменения применяются сразу и сохраняются в браузере. «Сбросить всё»
        возвращает палитру текущей темы (тёмной или светлой).
      </p>
    </Modal>
  );
}

export function AboutDialog({ version, onClose }: { version: string | null; onClose: () => void }) {
  return (
    <Modal
      title="О программе"
      onClose={onClose}
      foot={<button className="btn primary" onClick={onClose}>Закрыть</button>}
    >
      <div className="about-head">
        <span className="about-logo"><img src="/logo.png" alt="" /></span>
        <span>
          <b>PS<em>Bees</em></b>
          <small>PCB · LINUX · WINDOWS · SPRINT-LAYOUT</small>
        </span>
      </div>
      <p>
        <b>PSBees</b> — редактор разводки печатных плат для Linux и Windows в духе Sprint-Layout.
        Данные хранятся локально. Оформление — фирменный «пчелиный» стиль: две темы,
        тёмная (по умолчанию) и светлая, переключаются кнопкой в шапке, а цвета
        интерфейса (акцент, фон, панели, текст) настраиваются кнопкой палитры рядом.
      </p>
      <p style={{ fontSize: 12, opacity: 0.85 }}>
        {version
          ? `Версия сборки: ${version}.`
          : 'Версия: разработка (сборка без метки).'}
        {' '}На Linux обновления подтягиваются из GitHub при запуске; на Windows
        скачайте свежий установщик <code>PSBees-Setup.exe</code>.
      </p>
      <ul>
        <li>Дорожки с углами 45°/90°/свободно, автопереходы при смене слоя (клавиша L)</li>
        <li>Площадки (круг/квадрат/восьмиугольник) с металлизацией, SMD-площадки, переходы, отверстия</li>
        <li>Линии, прямоугольники, окружности, залитые полигоны (земля), текст на шелкографии</li>
        <li>2 слоя меди + 2 шелкографии + контур, вид снизу (зеркально)</li>
        <li>Библиотека компонентов в папках: выводные и SMD-корпуса, Arduino, ESP32/ESP8266</li>
        <li>Сетка 0.25…5.08 мм, координаты в мм и mil</li>
        <li>Отмена/повтор, копирование, дубль, поворот, перенос на другую сторону, панелизация</li>
        <li>Экспорт Gerber RS-274X + Excellon (ZIP), печать PNG 1:1 для ЛУТ</li>
      </ul>
      <p>
        Горячие клавиши: <span className="kbd">Ctrl+Z</span>/<span className="kbd">Ctrl+Y</span> отмена/повтор,
        <span className="kbd"> Del</span> удалить, <span className="kbd">R</span> повернуть,
        <span className="kbd"> M</span> на другую сторону, <span className="kbd">Ctrl+D</span> дубль,
        <span className="kbd">Ctrl+C</span>/<span className="kbd">Ctrl+V</span> копировать/вставить,
        <span className="kbd"> F</span> показать всё, <span className="kbd">Esc</span> отмена действия,
        <span className="kbd"> Alt</span> — временно без привязки к сетке.
      </p>
    </Modal>
  );
}
