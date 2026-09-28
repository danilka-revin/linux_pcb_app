import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc, Pt } from '../pcb/model';
import type { CncJob } from '../pcb/cnc';
import type { CncSettings } from '../pcb/cnc-settings';
import { cncOriginRef } from '../pcb/cnc-settings';
import { cncMotion, sampleCncMotion } from '../pcb/cnc-motion';

const n = (v: number) => String(Number(v.toFixed(3)));
const svgPath = (paths: Pt[][]) => paths.map(path => path.length
  ? `M${path.map(p => `${n(p.x)} ${n(p.y)}`).join('L')}Z` : '').join('');

/** Видимая область предпросмотра в миллиметрах платы (viewBox SVG). */
type CncView = { x: number; y: number; w: number; h: number };
const ZOOM_OUT = 0.5; // × от вписанного вида
const ZOOM_IN = 400;

/** Точка платы под указателем с учётом preserveAspectRatio="xMidYMid meet". */
function cncUserPoint(view: CncView, rect: { left: number; top: number; width: number; height: number },
  clientX: number, clientY: number): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0) || !(view.w > 0) || !(view.h > 0)) return null;
  const scale = Math.min(rect.width / view.w, rect.height / view.h);
  return {
    x: view.x + (clientX - rect.left - (rect.width - view.w * scale) / 2) / scale,
    y: view.y + (clientY - rect.top - (rect.height - view.h * scale) / 2) / scale,
  };
}

/** Держит плату хотя бы частично в кадре при панорамировании. */
function cncClampView(view: CncView, fit: CncView): CncView {
  const axis = (v: number, size: number, lo: number, len: number) => {
    const keep = 0.12 * Math.min(size, len);
    const min = Math.min(lo + keep - size, lo + len - keep);
    const max = Math.max(lo + keep - size, lo + len - keep);
    return Math.min(Math.max(v, min), max);
  };
  return { ...view, x: axis(view.x, view.w, fit.x, fit.w), y: axis(view.y, view.h, fit.y, fit.h) };
}

/** Масштаб вокруг точки (px, py); factor > 1 — приближение. */
function cncZoomView(view: CncView, fit: CncView, factor: number, px: number, py: number): CncView {
  const w = Math.min(fit.w / ZOOM_OUT, Math.max(fit.w / ZOOM_IN, view.w / factor));
  const s = w / view.w;
  return cncClampView({ x: px - (px - view.x) * s, y: py - (py - view.y) * s, w, h: view.h * s }, fit);
}

export function CncPreview({ doc, settings, job, side = 'top' }: {
  doc: Doc; settings: CncSettings; job: CncJob; side?: 'top' | 'bottom';
}) {
  const files = job.files.filter(f => f.name.endsWith('.nc'));
  const [selected, setSelected] = useState(() => side === 'bottom'
    ? files.find(f => f.name.startsWith('02_'))?.name ?? files[0]?.name : files[0]?.name);
  const file = files.find(f => f.name === selected) ?? files[0];
  if (!file) return <div className="cnc-empty">Нет движений</div>;
  const label = (name: string) => name.startsWith('01_') ? 'Верх · K1'
    : name.startsWith('02_') ? 'Низ · K2 · зеркало X'
    : name.startsWith('99_') ? 'Вырезание · последним'
    : `Сверло Ø${n(job.drills.find(d => d.filename === name)?.diameter ?? 0)} · ${settings.drillSide === 'top' ? 'верх' : 'низ · зеркало X'}`;
  return <div className="cnc-walk">
    <label className="cnc-program">Операция
      <select className="txt" aria-label="Операция предпросмотра" value={file.name} onChange={e => setSelected(e.target.value)}>
        {files.map(f => <option key={f.name} value={f.name}>{label(f.name)}</option>)}
      </select>
    </label>
    <CncPlayer key={file.name} doc={doc} settings={settings} job={job} name={file.name} program={String(file.data)} />
  </div>;
}

function CncPlayer({ doc, settings, job, name, program }: {
  doc: Doc; settings: CncSettings; job: CncJob; name: string; program: string;
}) {
  const motion = useMemo(() => cncMotion(program, settings.safeZ), [program, settings.safeZ]);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(.1, (now - last) / 1000); last = now;
      setProgress(p => Math.min(1, p + elapsed * speed / 30));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed]);
  useEffect(() => { if (progress >= 1) setPlaying(false); }, [progress]);
  const sample = sampleCncMotion(motion, progress);
  const bottom = name.startsWith('02_') || (name.startsWith('sverlo_') && settings.drillSide === 'bottom');
  const drilling = name.startsWith('sverlo_');
  const diameter = drilling ? job.drills.find(d => d.filename === name)?.diameter ?? 1
    : name.startsWith('99_') ? settings.outlineDiameter : settings.toolDiameter;
  const geometry = useMemo(() => {
    const ref = cncOriginRef(doc, settings.origin ?? 'bottom-left');
    const toBoard = (mx: number, my: number) => {
      if (bottom) {
        // bottom: mx = ox + (w - bx - ref.x) => bx = w - (mx - ox + ref.x)
        const bx = doc.w - (mx - settings.originX + ref.x);
        const by = my - settings.originY + ref.y;
        return { x: bx, y: by };
      } else {
        const bx = mx - settings.originX + ref.x;
        const by = my - settings.originY + ref.y;
        return { x: bx, y: by };
      }
    };
    const line = (rapid: boolean) => motion.moves.filter(m => m.rapid === rapid && (m.from.x !== m.to.x || m.from.y !== m.to.y))
      .map(m => {
        const a = toBoard(m.from.x, m.from.y);
        const b = toBoard(m.to.x, m.to.y);
        return `M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}`;
      }).join('');
    const copper = bottom ? job.preview.copperBottom : job.preview.copperTop;
    return <>
      <rect width={doc.w} height={doc.h} className="cnc-preview-board" />
      <path d={svgPath(copper)} fillRule="evenodd" className="cnc-preview-copper" />
      <path d={line(false)} strokeWidth={diameter} className="cnc-preview-kerf" />
      <path d={line(false)} className="cnc-preview-path" />
      <path d={line(true)} className="cnc-preview-rapid" />
      {drilling && motion.moves.filter(m => !m.rapid && m.to.z < 0 && m.pass === 1).map((m, i) => {
        const p = toBoard(m.to.x, m.to.y);
        return <circle key={i} cx={p.x} cy={p.y} r={diameter / 2} className="cnc-preview-hole" />;
      })}
    </>;
  }, [motion, settings.originX, settings.originY, settings.origin, bottom, job, doc.w, doc.h, diameter, drilling]);
  const pad = Math.max(10, diameter, 2) + Math.max(diameter, 1);
  const fit = useMemo<CncView>(() => ({ x: -pad, y: -pad, w: doc.w + 2 * pad, h: doc.h + 2 * pad }), [pad, doc.w, doc.h]);
  const [view, setView] = useState<CncView>(() => ({ ...fit }));
  // Новая операция или пересчёт открывают общий вид.
  useEffect(() => { setPlaying(false); setProgress(0); setView({ ...fit }); }, [motion, fit]);
  useEffect(() => {
    const area = areaRef.current, svg = svgRef.current;
    if (!area || !svg) return;
    // React слушает wheel пассивно — вешаем свой обработчик, чтобы колесо масштабировало, а не скроллило окно.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const rate = e.ctrlKey ? 0.02 : 0.0025; // touchpad-щипок (ctrlKey) и обычное колесо
      const factor = Math.min(1.5, Math.max(1 / 1.5, Math.exp(-(Number.isFinite(dy) ? dy : 0) * rate)));
      setView(v => {
        const u = cncUserPoint(v, rect, e.clientX, e.clientY) ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
        return cncZoomView(v, fit, factor, u.x, u.y);
      });
    };
    area.addEventListener('wheel', wheel, { passive: false });
    return () => area.removeEventListener('wheel', wheel);
  }, [fit]);
  const zoomAt = (factor: number) => setView(v => cncZoomView(v, fit, factor, v.x + v.w / 2, v.y + v.h / 2));
  const panBy = (fx: number, fy: number) => setView(v => cncClampView({ ...v, x: v.x + v.w * fx, y: v.y + v.h * fy }, fit));
  const resetView = () => setView({ ...fit });
  const ref = cncOriginRef(doc, settings.origin ?? 'bottom-left');
  const toBoardPos = (mx: number, my: number) => {
    if (bottom) {
      return { x: doc.w - (mx - settings.originX + ref.x), y: my - settings.originY + ref.y };
    }
    return { x: mx - settings.originX + ref.x, y: my - settings.originY + ref.y };
  };
  const pos = toBoardPos(sample?.position.x ?? settings.originX, sample?.position.y ?? settings.originY);
  const x = pos.x;
  const y = pos.y;
  const z = sample?.position.z ?? settings.safeZ;
  const r = Math.max(diameter / 2, Math.min(doc.w, doc.h) / 100);
  const maxDepth = motion.depths[motion.depths.length - 1] ?? 1;
  // Schematic Z axis: reserve enough space for shallow copper passes to stay legible.
  const depthY = (value: number) => value >= 0 ? 28 + (1 - value / settings.safeZ) * 52 : 80 - value / maxDepth * 114;
  return <>
    <div className="cnc-preview-stats" aria-live={playing ? 'off' : 'polite'}>
      <span>Проход <b>{sample?.move.pass || '—'} / {motion.depths.length}</b></span>
      <span>Z <b>{n(z)} мм</b></span><span>Фреза / сверло <b>Ø{n(diameter)}</b></span>
      <span>{progress === 1 ? 'Готово' : sample?.move.rapid ? 'Холостой ход' : drilling ? 'Сверление' : 'Резание'}</span>
    </div>
    <div className="cnc-simulation">
      <div className="cnc-preview-area" ref={areaRef}>
        <svg ref={svgRef} className={'cnc-preview' + (panning ? ' is-panning' : '')}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img" aria-label="Движения станка из G-code, вид сверху"
          tabIndex={0} onDoubleClick={resetView}
          onKeyDown={e => {
            if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.2); }
            else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(1 / 1.2); }
            else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); resetView(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(-.08, 0); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); panBy(.08, 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); panBy(0, -.08); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); panBy(0, .08); }
          }}
          onPointerDown={e => {
            if (e.button !== 0 && e.button !== 1) return;
            e.preventDefault();
            if (typeof e.currentTarget.focus === 'function') e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
            setPanning(true);
          }}
          onPointerMove={e => {
            const last = drag.current;
            if (!last || last.id !== e.pointerId) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setView(v => {
              const a = cncUserPoint(v, rect, last.x, last.y);
              const b = cncUserPoint(v, rect, e.clientX, e.clientY);
              if (!a || !b) return v;
              return cncClampView({ ...v, x: v.x - (b.x - a.x), y: v.y - (b.y - a.y) }, fit);
            });
            drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          }}
          onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); drag.current = null; setPanning(false); }}
          onPointerCancel={() => { drag.current = null; setPanning(false); }}
          onLostPointerCapture={() => { drag.current = null; setPanning(false); }}>
          <g transform={`translate(0 ${doc.h}) scale(1 -1)`}>
            {geometry}
            <g className="cnc-walk-tool" data-phase={sample?.move.rapid ? 'rapid' : 'cut'} transform={`translate(${x} ${y})`}>
              <circle r={r} className="cnc-preview-tool-body" />
              <circle r={r} className="cnc-preview-tool-halo" />
              <path d={`M${-r * 1.6} 0H${r * 1.6}M0 ${-r * 1.6}V${r * 1.6}`} className="cnc-preview-tool-cross" />
            </g>
          </g>
        </svg>
        <div className="cnc-zoom" role="group" aria-label="Масштаб демонстрации">
          <button type="button" className="btn" aria-label="Отдалить" title="Отдалить (−)" onClick={() => zoomAt(1 / 1.3)}>−</button>
          <span className="cnc-zoom-level" title="Масштаб относительно вписанного вида">{Math.round(fit.w / view.w * 100)}%</span>
          <button type="button" className="btn" aria-label="Приблизить" title="Приблизить (+)" onClick={() => zoomAt(1.3)}>+</button>
          <button type="button" className="btn" onClick={resetView} title="Вписать плату (Home, 0 или двойной щелчок)">Вписать</button>
        </div>
        <span className="cnc-preview-hint">Колесо — масштаб · Перетаскивание — панорама · Двойной щелчок — вписать</span>
      </div>
      <svg className="cnc-depth" viewBox="0 0 120 220" role="img" aria-label={`Глубина Z ${n(z)} мм, ${motion.depths.length} проходов`}>
        <text x="10" y="14">Z · схема</text>
        <text x="12" y="31">+{n(settings.safeZ)}</text>
        <rect x="8" y={depthY(0)} width="104" height={204 - depthY(0)} fill="#304454" />
        <line x1="8" x2="112" y1={depthY(0)} y2={depthY(0)} stroke="#f2c254" />
        <text x="12" y={depthY(0) - 5}>0</text>
        {motion.depths.map((d, i) => <g key={d}>
          <line x1="8" x2="112" y1={depthY(-d)} y2={depthY(-d)} stroke={sample?.move.pass === i + 1 ? '#72e8f4' : '#6b7b8b'} />
          {motion.depths.length <= 6 && <text x="12" y={depthY(-d) - 3}>{n(-d)}</text>}
        </g>)}
        <path d={`M75 20V${depthY(z)}l-5 -7m5 7l5 -7`} fill="none" stroke="#72e8f4" strokeWidth="3" />
      </svg>
    </div>
    <input className="cnc-scrub" type="range" min="0" max="1000" value={Math.round(progress * 1000)} aria-label="Ход демонстрации"
      onChange={e => { setPlaying(false); setProgress(Number(e.target.value) / 1000); }} />
    <div className="cnc-walk-controls">
      <button type="button" className="btn primary cnc-walk-play" disabled={!motion.moves.length} onClick={() => {
        if (progress >= 1) setProgress(0); setPlaying(p => !p);
      }}>{playing ? 'Пауза' : '▶ Демонстрация'}</button>
      <button type="button" className="btn" onClick={() => { setPlaying(false); setProgress(0); }}>Сначала</button>
      <select className="txt cnc-speed" aria-label="Скорость демонстрации" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
        {[.5, 1, 2, 4].map(s => <option key={s} value={s}>×{s}</option>)}
      </select>
      <span className="cnc-walk-status">{Math.round(progress * 100)}%</span>
    </div>
    <div className="cnc-preview-legend">Медь · траектория · пунктир: холостой ход</div>
  </>;
}
