// Интерактивная схема в диалоге ЧПУ: SVG-чертёж + чипы-легенды.
// Наведение/клик на чип или на узел чертежа подсвечивает связанный элемент
// и показывает пояснение «за что отвечает этот параметр».
import { useEffect, useRef, useState } from 'react';
import type { BuiltScheme } from '../pcb/cnc-schemes';

export function Scheme({ built }: { built: BuiltScheme }) {
  const [hl, setHl] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const active = pinned ?? hl;
  const activePart = built.parts.find((p) => p.id === active) ?? null;

  // Подсветка узлов чертежа классами — работает и для динамических id (файлы .nc).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.querySelectorAll('[data-part].is-hl').forEach((n) => n.classList.remove('is-hl'));
    if (active) {
      const key = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(active) : active.replace(/"/g, '\\"');
      el.querySelectorAll(`[data-part="${key}"]`).forEach((n) => n.classList.add('is-hl'));
    }
  }, [active, built]);

  return (
    <figure
      className={'scheme' + (active ? ' has-hl' : '')}
      data-scheme={built.id}
      ref={root}
    >
      <figcaption className="scheme-title">{built.title}</figcaption>
      <div
        className="scheme-svg"
        // eslint-disable-next-line react/no-danger -- готовый SVG из чистого модуля cnc-schemes
        dangerouslySetInnerHTML={{ __html: built.svg }}
        onMouseOver={(e) => {
          const g = (e.target as Element | null)?.closest?.('[data-part]');
          const id = g?.getAttribute('data-part');
          if (id) setHl(id);
        }}
        onMouseLeave={() => setHl(null)}
      />
      <div className="scheme-legend" role="list" aria-label={`Параметры: ${built.title}`}>
        {built.parts.map((p) => (
          <button
            key={p.id}
            type="button"
            role="listitem"
            className={'scheme-chip' + (active === p.id ? ' active' : '')}
            title={p.hint}
            onMouseEnter={() => setHl(p.id)}
            onMouseLeave={() => setHl(null)}
            onFocus={() => setHl(p.id)}
            onBlur={() => setHl(null)}
            onClick={() => setPinned((v) => (v === p.id ? null : p.id))}
          >{p.label}</button>
        ))}
      </div>
      <p className="scheme-caption" aria-live="polite">
        {activePart ? <><b>{activePart.label}:</b> {activePart.hint}</> : built.caption}
      </p>
    </figure>
  );
}
