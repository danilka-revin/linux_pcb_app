// Мелкие UI-виджеты: числовое поле, диалог.
import { useEffect, useState, type ReactNode } from 'react';
import { fmt } from '../pcb/model';

/** Числовое поле (мм) */
export function NI({
  label, value, on, step = 0.1, min, max,
}: {
  label: string;
  value: number;
  on: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [s, setS] = useState(fmt(value));
  useEffect(() => setS(fmt(value)), [value]);
  const commit = () => {
    const v = parseFloat(s.replace(',', '.'));
    if (isFinite(v)) {
      let r = v;
      if (min !== undefined) r = Math.max(min, r);
      if (max !== undefined) r = Math.min(max, r);
      on(r);
      setS(fmt(r));
    } else setS(fmt(value));
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="txt"
        value={s}
        step={step}
        onChange={(e) => setS(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        }}
      />
    </div>
  );
}

/** Текстовое поле */
export function TI({
  label, value, on,
}: {
  label: string;
  value: string;
  on: (v: string) => void;
}) {
  const [s, setS] = useState(value);
  useEffect(() => setS(value), [value]);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="txt"
        value={s}
        onChange={(e) => { setS(e.target.value); on(e.target.value); }}
      />
    </div>
  );
}

/** Выпадающий список */
export function SI({
  label, value, options, on,
}: {
  label: string;
  value: string;
  options: [string, string][];
  on: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => on(e.target.value)}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>{t}</option>
        ))}
      </select>
    </div>
  );
}

/** Модальный диалог */
export function Modal({
  title, children, onClose, foot,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  foot?: ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{title}</h2>
        {children}
        {foot && <div className="foot">{foot}</div>}
      </div>
    </div>
  );
}
