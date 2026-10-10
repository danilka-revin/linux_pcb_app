// «Твоя первая дорожка» — практическое обучение прямо на интерфейсе.
// Никаких лекций: подсветка + короткая фраза, и ждём реального действия.
// Шаги: «Дорожка» → клик начала → клик конца → ПКМ/Esc. Ничего не блокируем
// (кроме своих кнопок) — учимся на настоящей плате.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Ключ localStorage: обучение пройдено или пропущено — само больше не всплывает. */
export const FIRST_TRACK_KEY = 'psbees.firstTrack.done';

export function firstTrackDone(): boolean {
  try { return globalThis.localStorage?.getItem(FIRST_TRACK_KEY) === '1'; } catch { return false; }
}

export function markFirstTrackDone(): void {
  try { globalThis.localStorage?.setItem(FIRST_TRACK_KEY, '1'); } catch { /* ignore */ }
}

const STEP_TOOL = 1;   // нажать инструмент «Дорожка»
const STEP_P1 = 2;     // первый клик — начало дорожки
const STEP_P2 = 3;     // второй клик — конец
const STEP_END = 4;    // ПКМ / Esc — зафиксировать
const STEP_DONE = 5;   // успех

/** Куда сейчас указываем: элемент интерфейса, точка на холсте или «в никуда». */
interface Spot { kind: 'el' | 'point' | 'none'; x: number; y: number; w: number; h: number }

export interface FirstTrackCoachProps {
  /** >0 — обучение активно; увеличение числа перезапускает его. */
  run: number;
  /** Активный инструмент редактора. */
  tool: string;
  /** Сколько точек в черновике дорожки (0 — черновика нет). */
  draftPts: number;
  /** Сколько дорожек уже на плате. */
  trackCount: number;
  /** Временно спрятаться (например, открыт диалог). */
  paused: boolean;
  /** Выход: true — дошли до конца, false — пропустили. */
  onExit: (done: boolean) => void;
}

const CONF_COLORS = ['#e9b63f', '#7ddc52', '#7ac0ff', '#e5484d', '#c792ea'];

export function FirstTrackCoach(props: FirstTrackCoachProps) {
  const { run, tool, draftPts, trackCount, paused, onExit } = props;
  const [step, setStep] = useState(STEP_TOOL);
  const [spot, setSpot] = useState<Spot>({ kind: 'none', x: 0, y: 0, w: 0, h: 0 });
  /** Дорожек на плате на старте: успехом считаем только новую. */
  const baseRef = useRef(trackCount);

  // Перезапуск (в т.ч. повторный проход из настроек).
  useLayoutEffect(() => {
    if (run > 0) { setStep(STEP_TOOL); baseRef.current = trackCount; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // Автопереходы — только по реальным действиям пользователя.
  useEffect(() => {
    if (run === 0) return;
    // Дорожка появилась — сразу успех (в т.ч. двойным кликом раньше подсказки).
    if (step >= STEP_P1 && step <= STEP_END && trackCount > baseRef.current) { setStep(STEP_DONE); return; }
    // Ушёл с «Дорожки» и черновик пропал — возвращаем к инструменту.
    if (step >= STEP_P1 && step <= STEP_END && tool !== 'track') { setStep(STEP_TOOL); return; }
    if (step === STEP_TOOL && tool === 'track') { setStep(STEP_P1); return; }
    if (step === STEP_P1 && draftPts >= 1) { setStep(STEP_P2); return; }
    if (step === STEP_P2 && draftPts >= 2) { setStep(STEP_END); return; }
  }, [run, step, tool, draftPts, trackCount]);

  // Следим за положением цели: ресайз, скролл, плюс периодический пересчёт
  // (панели и док могут перестроиться, а событий об этом нет).
  useEffect(() => {
    if (run === 0 || paused) return;
    const measure = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      if (step === STEP_TOOL) {
        const el = document.querySelector('[data-tool-id="track"]') as HTMLElement | null;
        if (el) {
          const r = el.getBoundingClientRect();
          setSpot({ kind: 'el', x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
        } else {
          setSpot({ kind: 'none', x: vw / 2, y: 110, w: 0, h: 0 });
        }
        return;
      }
      if (step === STEP_P1 || step === STEP_P2 || step === STEP_END) {
        const cv = document.querySelector('.canvas-over') as HTMLElement | null;
        const r = cv ? cv.getBoundingClientRect() : { left: 0, top: 0, width: vw, height: vh };
        const px = r.left + r.width * 0.42;
        const py = r.top + r.height * (step === STEP_END ? 0.66 : 0.45);
        setSpot({ kind: step === STEP_END ? 'none' : 'point', x: px, y: py, w: 0, h: 0 });
        return;
      }
      setSpot({ kind: 'none', x: vw / 2, y: vh * 0.42, w: 0, h: 0 });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const iv = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.clearInterval(iv);
    };
  }, [run, step, paused]);

  const confetti = useMemo(() => Array.from({ length: 26 }, (_, i) => ({
    left: (i * 37 + 13) % 100,
    delay: ((i * 53) % 90) / 55,
    dur: 2.4 + ((i * 29) % 100) / 80,
    color: CONF_COLORS[i % CONF_COLORS.length],
    size: 6 + (i % 3) * 3,
    rot: (i * 47) % 180,
  })), []);

  if (typeof document === 'undefined' || run === 0 || paused) return null;

  const vw = window.innerWidth, vh = window.innerHeight;
  const toolBtnVisible = spot.kind === 'el';

  // Позиция подсказки рядом с целью (не вылезая за экран).
  const bubble = ((): { left: number; top: number; tx: number; ty: number; arrow: 'left' | 'right' | 'none' } => {
    if (spot.kind === 'el') {
      const right = spot.x + spot.w + 20;
      if (right + 300 <= vw) return { left: right, top: spot.y + spot.h / 2, tx: 0, ty: -50, arrow: 'left' };
      return { left: spot.x - 20, top: spot.y + spot.h / 2, tx: -100, ty: -50, arrow: 'right' };
    }
    if (spot.kind === 'point') {
      const top = Math.max(70, Math.min(vh - 150, spot.y - 26));
      if (spot.x + 44 + 300 <= vw) return { left: spot.x + 44, top, tx: 0, ty: 0, arrow: 'left' };
      return { left: spot.x - 44, top, tx: -100, ty: 0, arrow: 'right' };
    }
    return { left: vw / 2, top: Math.min(vh - 150, Math.max(90, spot.y)), tx: -50, ty: 0, arrow: 'none' };
  })();

  const skipBtn = (
    <button type="button" className="coach-skip" title="Пропустить обучение" onClick={() => onExit(false)}>✕</button>
  );

  if (step === STEP_DONE) {
    return createPortal(
      <div className="coach-root" aria-label="Обучение: первая дорожка пройдена">
        <div className="coach-confetti" aria-hidden="true">
          {confetti.map((c, i) => (
            <i
              key={i}
              style={{
                left: `${c.left}%`, width: c.size, height: c.size * 0.6, background: c.color,
                animationDelay: `${c.delay}s`, animationDuration: `${c.dur}s`, transform: `rotate(${c.rot}deg)`,
              }}
            />
          ))}
        </div>
        <div className="coach-card" style={{ left: vw / 2, top: vh * 0.42 }}>
          <div className="coach-card-emoji">🎉</div>
          <h3>Готово! Первая дорожка твоя</h3>
          <p>Клики ведут дорожку, ПКМ — конец. Тренируйся!</p>
          <div className="coach-card-btns">
            <button type="button" className="btn primary" onClick={() => onExit(true)}>Рисовать дальше →</button>
          </div>
          <small className="coach-card-hint">2 — дорожка · Ctrl+Z — отмена</small>
        </div>
      </div>,
      document.body,
    );
  }

  const texts: Record<number, { big: ReactNode; small?: ReactNode }> = {
    [STEP_TOOL]: toolBtnVisible
      ? { big: 'Нажми «Дорожка»', small: <>инструмент слева · или клавиша <kbd>2</kbd></> }
      : { big: <>Нажми клавишу <kbd>2</kbd></>, small: 'это инструмент «Дорожка»' },
    [STEP_P1]: { big: 'Кликни по огоньку', small: 'это начало дорожки' },
    [STEP_P2]: { big: 'Веди мышь — кликни ещё раз', small: 'хочешь длиннее — кликай дальше' },
    [STEP_END]: { big: 'ПКМ или Esc — готово', small: 'двойной клик тоже работает' },
  };

  return createPortal(
    <div className="coach-root" aria-label="Обучение: первая дорожка">
      {spot.kind === 'el' && (
        <div className="coach-spot" style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }} />
      )}
      {spot.kind === 'point' && (
        <>
          <div
            className="coach-spot coach-spot-round"
            style={{ left: spot.x - 28, top: spot.y - 28, width: 56, height: 56 }}
          />
          <div className="coach-marker" style={{ left: spot.x, top: spot.y }} aria-hidden="true">
            <span className="coach-marker-ring" />
            <span className="coach-marker-core" />
          </div>
        </>
      )}
      <div
        className={`coach-bubble arrow-${bubble.arrow}`}
        style={{ left: bubble.left, top: bubble.top, transform: `translate(${bubble.tx}%, ${bubble.ty}%)` }}
        role="status"
      >
        {skipBtn}
        <div className="coach-big">{texts[step].big}</div>
        {texts[step].small && <div className="coach-small">{texts[step].small}</div>}
        <div className="coach-dots" aria-hidden="true">
          {[STEP_TOOL, STEP_P1, STEP_P2, STEP_END].map((s) => (
            <span key={s} className={'coach-dot' + (s === step ? ' on' : '') + (s < step ? ' done' : '')} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
