// Интерактивные индикаторы для всего сайта: полоса прогресса (с этапами,
// подсказками и таймером) и полоса-диаграмма долей (для состава платы, квоты).
// Одинаковый вид и поведение везде: обновление, ЧПУ, трассировка, облако.
import { useState, type ReactNode } from 'react';

export type PbState = 'wait' | 'run' | 'done' | 'skip' | 'error';
export type PbTone = 'accent' | 'ok' | 'err' | 'cancel';

export interface PbStep {
  id: string;
  label: string;
  state: PbState;
  /** заполнение мини-полоски этапа, 0…1 */
  frac?: number;
  /** короткий статус справа (%, «готово», …) */
  right?: string;
  /** подсказка при наведении: «за что отвечает этот этап» */
  hint?: string;
  /** шаг можно нажать — перейти к нему (например, открыть нужную сторону превью) */
  onSelect?: () => void;
}

const STEP_ICON: Record<PbState, string> = { wait: '○', run: '', done: '✓', skip: '↷', error: '✕' };

/** Полоса прогресса: клик по проценту сворачивает/разворачивает этапы, шаги подсвечиваются. */
export function ProgressBar({
  label, pct, pctLabel, indeterminate = false, live = false, tone = 'accent',
  meta, steps, title, showSteps: showStepsInit = true, ticks = true, slim = false,
}: {
  label?: ReactNode;
  /** 0…100 */
  pct?: number;
  pctLabel?: ReactNode;
  indeterminate?: boolean;
  /** бегущие полосы во время работы */
  live?: boolean;
  tone?: PbTone;
  meta?: ReactNode;
  steps?: PbStep[];
  title?: string;
  showSteps?: boolean;
  /** метки границ между этапами на общей полосе */
  ticks?: boolean;
  /** тонкая полоса без заголовка и процентов — для встраивания в строки/карточки */
  slim?: boolean;
}) {
  const [open, setOpen] = useState(showStepsInit);
  const [hint, setHint] = useState<string | null>(null);
  const value = Math.max(0, Math.min(100, pct ?? 0));
  const indet = indeterminate || (live && pct == null);
  const cls = ['updp', slim ? 'updp-slim' : '', tone === 'ok' ? 'is-ok' : tone === 'err' ? 'is-err' : tone === 'cancel' ? 'is-cancel' : '']
    .filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {!slim && <div className="updp-head">
        <span className="updp-title" aria-live="polite">{label}</span>
        <button
          type="button"
          className={'updp-pct' + (steps?.length ? ' clickable' : '')}
          title={steps?.length ? (open ? 'Скрыть этапы' : 'Показать этапы') : undefined}
          aria-expanded={steps?.length ? open : undefined}
          disabled={!steps?.length}
          onClick={() => setOpen((v) => !v)}
        >{pctLabel ?? (indet ? '' : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`)}</button>
      </div>}
      <div
        className={'updp-track' + (indet ? ' indet' : '') + (live ? ' live' : '')}
        role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={indet ? undefined : Math.round(value)}
        title={title ?? steps?.map((s) => `${s.label}: ${s.state === 'skip' ? 'пропущено' : Math.round((s.frac ?? (s.state === 'done' ? 1 : 0)) * 100) + '%'}`).join('\n')}
      >
        {ticks && steps && steps.length > 1 && (() => {
          const sum = steps.reduce((a, s) => a + 1, 0) || 1;
          return steps.slice(0, -1).map((s, i) => (
            <span key={s.id} className="updp-tick" style={{ left: `${((i + 1) / sum) * 100}%` }} />
          ));
        })()}
        <div className="updp-fill" style={indet ? undefined : { width: `${value}%` }} />
      </div>
      {(!slim || meta) && <div className="updp-meta">
        <span className="updp-meta-main">{hint ?? <>{meta}</>}</span>
      </div>}
      {open && steps && steps.length > 0 && (
        <ol className="updp-steps">
          {steps.map((s) => (
            <li
              key={s.id}
              className={'updp-step s-' + s.state + (s.hint ? ' has-hint' : '') + (s.onSelect ? ' clickable' : '')}
              onMouseEnter={() => s.hint && setHint(s.hint)}
              onMouseLeave={() => setHint(null)}
              onFocus={() => s.hint && setHint(s.hint)}
              onBlur={() => setHint(null)}
              onClick={s.onSelect ? () => s.onSelect?.() : undefined}
              title={s.hint}
            >
              <span className="updp-ico">{s.state === 'run' ? <span className="updp-spin" /> : STEP_ICON[s.state]}</span>
              <span className="updp-lab">{s.label}</span>
              <span className="updp-mini">
                {s.state === 'run' && <span className="updp-mini-fill" style={{ width: `${Math.round((s.frac ?? 0) * 100)}%` }} />}
              </span>
              <span className="updp-st">
                {s.right ?? (s.state === 'run' ? `${Math.round((s.frac ?? 0) * 100)}%` : s.state === 'skip' ? 'кэш' : s.state === 'done' ? 'готово' : s.state === 'error' ? 'ошибка' : '')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export interface StatSegment {
  id: string;
  label: string;
  value: number;
  /** 'accent' | 'ok' | 'warn' | 'muted' | 'copper' | 'danger' */
  tone?: string;
  hint?: string;
}

/** Полоса долей: наведение/клик по сегменту показывает, что и сколько он означает. */
export function StatBar({ segments, caption, empty = 'нет данных' }: {
  segments: StatSegment[];
  caption?: ReactNode;
  empty?: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const active = segments.find((s) => s.id === sel) ?? null;
  return (
    <div className={'statbar' + (total ? '' : ' empty')}>
      <div className="statbar-track" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}>
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => (
          <button
            key={s.id}
            type="button"
            className={'statbar-seg' + (sel === s.id ? ' active' : '') + (s.tone ? ' tone-' + s.tone : '')}
            style={{ width: `${(Math.max(0, s.value) / total) * 100}%` }}
            title={s.hint ?? `${s.label}: ${s.value}`}
            onMouseEnter={() => setSel(s.id)}
            onMouseLeave={() => setSel(null)}
            onFocus={() => setSel(s.id)}
            onBlur={() => setSel(null)}
            onClick={() => setSel((v) => (v === s.id ? null : s.id))}
          ><span>{(Math.max(0, s.value) / total) >= 0.12 ? s.label : ''}</span></button>
        ))}
      </div>
      <div className="statbar-caption">
        {active
          ? <><b>{active.label}</b> — {active.value} ({Math.round((active.value / total) * 100)}%){active.hint ? ` · ${active.hint}` : ''}</>
          : <>{caption ?? <span className="muted">{total ? 'наведите на сегмент, чтобы увидеть долю' : empty}</span>}</>}
      </div>
    </div>
  );
}
