// Мелкие UI-виджеты: числовое поле, диалог, кнопка с выпадающим меню.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fmt } from '../pcb/model';
import { Ic } from './icons';

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
  title, children, onClose, foot, className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  foot?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (className ? ' ' + className : '')} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {foot && <div className="foot">{foot}</div>}
      </div>
    </div>
  );
}

/** Пункт выпадающего меню тулбара (sep — разделитель) */
export interface MenuEntry {
  icon?: string;
  label?: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  sep?: boolean;
}

/**
 * Кнопка тулбара с выпадающим меню: компактно размещает группу редких
 * действий в один клик. Меню закрывается по Esc, клику мимо и после выбора.
 * Раскрывается порталом к <body> с фиксированным позиционированием — шапка
 * с overflow:hidden его не обрезает.
 */
export function MenuBtn({
  icon = 'more', title, items, align = 'left', active = false,
}: {
  icon?: string;
  title: string;
  items: MenuEntry[];
  align?: 'left' | 'right';
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && root.current) {
      const r = root.current.getBoundingClientRect();
      setPos(align === 'right'
        ? { top: r.bottom + 6, right: Math.max(6, window.innerWidth - r.right) }
        : { top: r.bottom + 6, left: Math.max(6, Math.min(r.left, window.innerWidth - 266)) });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    // подписываемся после текущего клика, чтобы он же меню не закрыл
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  return (
    <div className={'tb-menu' + (align === 'right' ? ' right' : '')} ref={root}>
      <button
        type="button"
        className={'tb-btn' + (open || active ? ' active' : '')}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Ic n={icon} />
      </button>
      {open && createPortal(
        <div className="tb-pop" role="menu" ref={pop}
          style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right }}>
          {items.map((it, i) => (it.sep ? (
            <div key={i} className="tb-pop-sep" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className="tb-pop-item"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}
            >
              {it.icon ? <Ic n={it.icon} size={16} /> : <span className="tb-pop-ico" />}
              <span className="tb-pop-label">{it.label}</span>
              {it.kbd && <span className="tb-pop-kbd">{it.kbd}</span>}
            </button>
          )))}
        </div>,
        document.body,
      )}
    </div>
  );
}
