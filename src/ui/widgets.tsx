// Мелкие UI-виджеты: числовое поле, диалог, кнопка с выпадающим меню.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

/** Позиция всплывающего меню: портал к <body>, координаты фиксированные */
interface MenuPos { top: number; left?: number; right?: number }

/**
 * Общее состояние выпадающего меню кнопки тулбара: измерение места под
 * кнопкой, закрытие по Esc, клику мимо и после выбора пункта.
 */
function useMenuPos() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos>({ top: 0 });
  const root = useRef<HTMLDivElement>(null);
  // обычный мутабельный ref: html-элемент меню приходит из callback-ref
  const pop = useRef<HTMLDivElement | null>(null);

  // align: меню прижато к левому краю кнопки ('left') или к правому ('right')
  const place = (align: 'left' | 'right') => {
    if (root.current) {
      const r = root.current.getBoundingClientRect();
      setPos(align === 'right'
        ? { top: r.bottom + 6, right: Math.max(6, window.innerWidth - r.right) }
        : { top: r.bottom + 6, left: Math.max(6, Math.min(r.left, window.innerWidth - 266)) });
    }
    setOpen((o) => !o);
  };

  // Меню у правого края окна упирается в него: измеряем ширину при появлении
  // (до отрисовки кадра) и сдвигаем влево — иначе правая часть списка не видна.
  const attachPop = useCallback((el: HTMLDivElement | null) => {
    pop.current = el;
    if (!el) return;
    const maxLeft = Math.max(6, window.innerWidth - el.getBoundingClientRect().width - 6);
    setPos((p) => (p.left === undefined || p.left <= maxLeft ? p : { ...p, left: maxLeft }));
  }, []);

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

  return { open, setOpen, pos, root, attachPop, place };
}

/** Список пунктов меню — один на все кнопки тулбара. */
function PopMenu({ items, pos, attach, onPick }: {
  items: MenuEntry[];
  pos: MenuPos;
  attach: (el: HTMLDivElement | null) => void;
  onPick: () => void;
}) {
  return createPortal(
    <div className="tb-pop" role="menu" ref={attach}
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
          onClick={() => { onPick(); it.onClick?.(); }}
        >
          {it.icon ? <Ic n={it.icon} size={16} /> : <span className="tb-pop-ico" />}
          <span className="tb-pop-label">{it.label}</span>
          {it.kbd && <span className="tb-pop-kbd">{it.kbd}</span>}
        </button>
      )))}
    </div>,
    document.body,
  );
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
  const menu = useMenuPos();
  const { open } = menu;

  return (
    <div className={'tb-menu' + (align === 'right' ? ' right' : '')} ref={menu.root}>
      <button
        type="button"
        className={'tb-btn' + (open || active ? ' active' : '')}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => menu.place(align)}
      >
        <Ic n={icon} />
      </button>
      {open && <PopMenu items={items} pos={menu.pos} attach={menu.attachPop} onPick={() => menu.setOpen(false)} />}
    </div>
  );
}

/**
 * Кнопка с боковым переключателем: основная часть выполняет главное действие
 * (для предпросмотра платы — открыть окно в последнем режиме), узкая стрелка
 * раскрывает список режимов. Внешне — одна кнопка, но оба режима доступны
 * за один клик, как и раньше двумя отдельными кнопками.
 */
export function SplitBtn({
  icon, title, menuTitle, onClick, items, active = false,
}: {
  icon: string;
  title: string;
  menuTitle: string;
  onClick: () => void;
  items: MenuEntry[];
  active?: boolean;
}) {
  const menu = useMenuPos();
  const { open } = menu;

  return (
    <div className="tb-split" ref={menu.root}>
      <button
        type="button"
        className={'tb-btn split-main' + (active ? ' active' : '')}
        title={title}
        onClick={onClick}
      >
        <Ic n={icon} />
      </button>
      <button
        type="button"
        className={'tb-btn split-caret' + (open ? ' active' : '')}
        title={menuTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => menu.place('left')}
      >
        <Ic n="caret" size={12} />
      </button>
      {open && <PopMenu items={items} pos={menu.pos} attach={menu.attachPop} onPick={() => menu.setOpen(false)} />}
    </div>
  );
}
