// Предпросмотр без изменения геометрии документа.
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { entBBox, type Doc, type Entity, type LayerId } from '../pcb/model';
import { drawEnt, zOrdered } from '../pcb/render';

export type Board2DThemeId = 'green' | 'blue' | 'red' | 'black' | 'white' | 'purple' | 'yellow' | 'classic-dark' | 'classic-light' | 'mono';

export interface Board2DTheme {
  id: Board2DThemeId;
  name: string;
  board: string; // подложка
  boardEdge: string;
  copperTop: string;
  copperBottom: string;
  copperBoth: string;
  maskTop: string; // с прозрачностью для реалистичности
  maskBottom: string;
  silkTop: string;
  silkBottom: string;
  outline: string;
  hole: string;
  bg: string;
}

export const BOARD_2D_THEMES: Board2DTheme[] = [
  {
    id: 'green',
    name: 'Зелёная маска (реалистичная)',
    board: '#0f2a18',
    boardEdge: '#1a3d24',
    copperTop: '#d4af37',
    copperBottom: '#c19a2e',
    copperBoth: '#e8c24a',
    maskTop: 'rgba(16, 68, 32, 0.78)',
    maskBottom: 'rgba(16, 68, 32, 0.82)',
    silkTop: '#ffffff',
    silkBottom: '#e0e0e0',
    outline: '#a0b0a0',
    hole: '#0a0a0a',
    bg: '#0e1115',
  },
  {
    id: 'blue',
    name: 'Синяя плата',
    board: '#0d1b2a',
    boardEdge: '#1a2f4a',
    copperTop: '#d4af37',
    copperBottom: '#c19a2e',
    copperBoth: '#e8c24a',
    maskTop: 'rgba(13, 43, 89, 0.82)',
    maskBottom: 'rgba(13, 43, 89, 0.86)',
    silkTop: '#ffffff',
    silkBottom: '#e0e0e0',
    outline: '#8aa0c0',
    hole: '#0a0a0a',
    bg: '#0e1115',
  },
  {
    id: 'red',
    name: 'Красная плата',
    board: '#2a1212',
    boardEdge: '#4a1a1a',
    copperTop: '#d4af37',
    copperBottom: '#c19a2e',
    copperBoth: '#e8c24a',
    maskTop: 'rgba(120, 20, 20, 0.82)',
    maskBottom: 'rgba(120, 20, 20, 0.86)',
    silkTop: '#ffffff',
    silkBottom: '#e0e0e0',
    outline: '#c0a0a0',
    hole: '#0a0a0a',
    bg: '#0e1115',
  },
  {
    id: 'black',
    name: 'Чёрная плата',
    board: '#101010',
    boardEdge: '#202020',
    copperTop: '#d4af37',
    copperBottom: '#c19a2e',
    copperBoth: '#e8c24a',
    maskTop: 'rgba(10, 10, 10, 0.88)',
    maskBottom: 'rgba(10, 10, 10, 0.92)',
    silkTop: '#ffffff',
    silkBottom: '#c0c0c0',
    outline: '#808080',
    hole: '#000000',
    bg: '#0a0a0a',
  },
  {
    id: 'white',
    name: 'Белая плата',
    board: '#f0f0f0',
    boardEdge: '#d0d0d0',
    copperTop: '#b8860b',
    copperBottom: '#a67c00',
    copperBoth: '#d4a017',
    maskTop: 'rgba(245, 245, 245, 0.92)',
    maskBottom: 'rgba(245, 245, 245, 0.96)',
    silkTop: '#000000',
    silkBottom: '#202020',
    outline: '#404040',
    hole: '#101010',
    bg: '#e8e8e8',
  },
  {
    id: 'purple',
    name: 'Фиолетовая',
    board: '#1a102a',
    boardEdge: '#2a1a4a',
    copperTop: '#d4af37',
    copperBottom: '#c19a2e',
    copperBoth: '#e8c24a',
    maskTop: 'rgba(50, 20, 90, 0.84)',
    maskBottom: 'rgba(50, 20, 90, 0.88)',
    silkTop: '#ffffff',
    silkBottom: '#e0e0e0',
    outline: '#a080c0',
    hole: '#0a0a0a',
    bg: '#0e1115',
  },
  {
    id: 'yellow',
    name: 'Жёлтая (без маски)',
    board: '#c9a800',
    boardEdge: '#a88a00',
    copperTop: '#8b4513',
    copperBottom: '#654321',
    copperBoth: '#a0522d',
    maskTop: 'rgba(201, 168, 0, 0.15)',
    maskBottom: 'rgba(201, 168, 0, 0.15)',
    silkTop: '#000000',
    silkBottom: '#202020',
    outline: '#000000',
    hole: '#000000',
    bg: '#f5f0c0',
  },
  {
    id: 'classic-dark',
    name: 'Sprint Layout — классический',
    board: '#000000',
    boardEdge: '#667078',
    copperTop: '#4088ff',
    copperBottom: '#00cf64',
    copperBoth: '#f4ce46',
    maskTop: 'rgba(15, 17, 21, 0.0)',
    maskBottom: 'rgba(15, 17, 21, 0.0)',
    silkTop: '#e5484d',
    silkBottom: '#e8c93e',
    outline: '#e9ecf1',
    hole: '#000000',
    bg: '#000000',
  },
  {
    id: 'classic-light',
    name: 'Классика (светлая)',
    board: '#eef1f4',
    boardEdge: '#bcc3cc',
    copperTop: '#2f80ed',
    copperBottom: '#2aa35c',
    copperBoth: '#e08e00',
    maskTop: 'rgba(238, 241, 244, 0.0)',
    maskBottom: 'rgba(238, 241, 244, 0.0)',
    silkTop: '#d93a3f',
    silkBottom: '#c9930a',
    outline: '#232a34',
    hole: '#eef1f4',
    bg: '#eef1f4',
  },
  {
    id: 'mono',
    name: 'Монохром (ч/б для печати)',
    board: '#ffffff',
    boardEdge: '#000000',
    copperTop: '#000000',
    copperBottom: '#000000',
    copperBoth: '#000000',
    maskTop: 'rgba(255,255,255,0)',
    maskBottom: 'rgba(255,255,255,0)',
    silkTop: '#000000',
    silkBottom: '#000000',
    outline: '#000000',
    hole: '#ffffff',
    bg: '#ffffff',
  },
];

export type PreviewSide = 'top' | 'bottom' | 'both';
export interface BoardPreviewOptions {
  side: PreviewSide;
  hidden: Set<LayerId>;
  showHoles: boolean;
  showMask: boolean;
  showGrid: boolean;
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** Общая фильтрация для всех примитивов, включая развёрнутые компоненты. */
export function previewVisible(e: Entity, side: PreviewSide, hidden: Set<LayerId>): boolean {
  if (e.kind === 'pad' || e.kind === 'via') {
    return (side !== 'bottom' && !hidden.has('k1')) || (side !== 'top' && !hidden.has('k2'));
  }
  if ('layer' in e) {
    if (hidden.has(e.layer)) return false;
    if (side === 'top' && (e.layer === 'k2' || e.layer === 's2')) return false;
    if (side === 'bottom' && (e.layer === 'k1' || e.layer === 's1')) return false;
  }
  return true;
}

export function drawBoard2D(ctx: CanvasRenderingContext2D, doc: Doc, flat: Entity[], theme: Board2DTheme, opts: BoardPreviewOptions) {
  const { scale: s, offsetX: x, offsetY: y, width, height, side, hidden } = opts;
  const bw = doc.w * s, bh = doc.h * s;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = theme.board;
  ctx.fillRect(x, y, bw, bh);

  ctx.save();
  // Зеркалим весь рисунок, а не только координаты центров площадок.
  if (side === 'bottom') { ctx.translate(2 * x + bw, 0); ctx.scale(-1, 1); }
  if (opts.showGrid) {
    let step = 1;
    while (step * s < 12) step *= 5;
    const x0 = Math.max(0, Math.ceil((side === 'bottom' ? x + bw - width : -x) / s / step));
    const x1 = Math.min(Math.floor(doc.w / step), Math.ceil((side === 'bottom' ? x + bw : width - x) / s / step));
    const y0 = Math.max(0, Math.ceil((y + bh - height) / s / step));
    const y1 = Math.min(Math.floor(doc.h / step), Math.ceil((y + bh) / s / step));
    ctx.fillStyle = theme.id === 'classic-dark' ? '#41484f' : theme.boardEdge;
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      ctx.fillRect(x + ix * step * s, y + bh - iy * step * s, 1, 1);
    }
  }
  const visible = flat.filter(e => previewVisible(e, side, hidden));
  const view = { s, ox: x, oy: y + bh, mir: false };
  const colors = { k1: theme.copperTop, k2: theme.copperBottom, s1: theme.silkTop, s2: theme.silkBottom, outline: theme.outline };
  const draw = (e: Entity) => drawEnt(ctx, view, e, {
    tint: 'layer' in e ? colors[e.layer] : theme.copperBoth, omitDrills: true,
  });
  // Порядок слоёв не зависит от порядка создания объектов в документе.
  for (const layer of ['k2', 'k1'] as const) {
    const copper = visible.filter(e => 'layer' in e && e.layer === layer && e.kind !== 'smd');
    for (const e of copper.filter(e => e.kind === 'poly' || (e.kind === 'rect' && e.filled))) draw(e);
    for (const e of copper.filter(e => e.kind !== 'poly' && !(e.kind === 'rect' && e.filled))) draw(e);
  }
  // Маска закрывает проводники, но не контактные площадки и сверловку.
  if (opts.showMask && !theme.id.startsWith('classic') && theme.id !== 'mono') {
    ctx.fillStyle = side === 'bottom' ? theme.maskBottom : theme.maskTop;
    ctx.fillRect(x, y, bw, bh);
  }
  for (const e of visible) if (e.kind === 'pad' || e.kind === 'via' || e.kind === 'smd') draw(e);
  for (const layer of ['s2', 's1', 'outline'] as const) {
    for (const e of visible) if ('layer' in e && e.layer === layer) draw(e);
  }
  // Последний проход: дорожки и шелкография никогда не перекрывают отверстия.
  if (opts.showHoles) {
    ctx.fillStyle = theme.hole;
    for (const e of flat) {
      const d = e.kind === 'hole' ? e.d : e.kind === 'pad' || e.kind === 'via' ? e.drill : 0;
      if (d > 0 && 'x' in e && 'y' in e) {
        ctx.beginPath();
        ctx.arc(x + e.x * s, y + bh - e.y * s, d * s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
  if (!hidden.has('outline')) {
    ctx.strokeStyle = theme.boardEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, bw, bh);
  }
  // Размеры остаются читаемыми при просмотре снизу.
  ctx.fillStyle = theme.id === 'mono' || theme.id === 'classic-light' || theme.id === 'white' || theme.id === 'yellow' ? '#53606d' : '#9aa7b4';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  if (y + bh + 22 < height) ctx.fillText(`${doc.w} мм`, x + bw / 2, y + bh + 22);
  if (x > 28) {
    ctx.save();
    ctx.translate(x - 18, y + bh / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${doc.h} мм`, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Include imported objects outside the nominal board without changing the document. */
export function previewBounds(doc: Doc, flat: Entity[]): [number, number, number, number] {
  const bounds: [number, number, number, number] = [0, 0, doc.w, doc.h];
  for (const e of flat) {
    const b = entBBox(e);
    bounds[0] = Math.min(bounds[0], b[0]); bounds[1] = Math.min(bounds[1], b[1]);
    bounds[2] = Math.max(bounds[2], b[2]); bounds[3] = Math.max(bounds[3], b[3]);
  }
  return bounds;
}

export function BoardPreview2D({ doc, width = 960, height = 520 }: { doc: Doc; width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width, height });
  const [themeId, setThemeId] = useState<Board2DThemeId>('classic-dark');
  const [side, setSide] = useState<PreviewSide>('both');
  const [hidden, setHidden] = useState<Set<LayerId>>(new Set());
  const [showHoles, setShowHoles] = useState(true);
  const [showMask, setShowMask] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [view, setView] = useState({ scale: 8, x: 40, y: 40 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const flat = useMemo(() => zOrdered(doc), [doc]);
  const theme = BOARD_2D_THEMES.find(t => t.id === themeId)!;
  const bounds = useMemo(() => previewBounds(doc, flat), [doc, flat]);
  const [x1, y1, x2, y2] = bounds;
  const outside = x1 < -0.5 || y1 < -0.5 || x2 > doc.w + 0.5 || y2 > doc.h + 0.5;
  const fitScale = Math.max(0.001, Math.min((size.width - 80) / Math.max(x2 - x1, 0.1), (size.height - 80) / Math.max(y2 - y1, 0.1)));
  const fit = useCallback(() => {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    setView({ scale: fitScale, x: size.width / 2 - (side === 'bottom' ? doc.w - cx : cx) * fitScale, y: size.height / 2 - (doc.h - cy) * fitScale });
  }, [fitScale, size, doc.w, doc.h, side, x1, x2, y1, y2]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => setSize({ width: wrap.clientWidth, height: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { fit(); }, [fit]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.width * dpr);
    cv.height = Math.round(size.height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBoard2D(ctx, doc, flat, theme, { side, hidden, showHoles, showMask, showGrid, scale: view.scale, offsetX: view.x, offsetY: view.y, ...size });
  }, [doc, flat, theme, side, hidden, showHoles, showMask, showGrid, view, size]);

  const zoom = useCallback((factor: number, mx = size.width / 2, my = size.height / 2) => {
    setView(v => {
      const scale = Math.max(fitScale / 4, Math.min(Math.max(200, fitScale * 16), v.scale * factor));
      return { scale, x: mx - (mx - v.x) * scale / v.scale, y: my - (my - v.y) * scale / v.scale };
    });
  }, [size, fitScale]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    cv.addEventListener('wheel', wheel, { passive: false });
    return () => cv.removeEventListener('wheel', wheel);
  }, [zoom]);
  const toggleLayer = (layer: LayerId) => setHidden(old => {
    const next = new Set(old);
    if (next.has(layer)) next.delete(layer); else next.add(layer);
    return next;
  });
  const layers: [LayerId, string, string][] = [
    ['k1', 'K1 · Медь сверху', theme.copperTop], ['k2', 'K2 · Медь снизу', theme.copperBottom],
    ['s1', 'Ш1 · Шелк сверху', theme.silkTop], ['s2', 'Ш2 · Шелк снизу', theme.silkBottom],
    ['outline', 'Контур', theme.outline],
  ];
  return <div className="board-preview-2d">
    <div className="bp2d-toolbar">
      <div className="bp2d-row">
        <div className="bp2d-segments" role="group" aria-label="Сторона платы">
          {([['both', 'Все слои'], ['top', 'Верх · K1'], ['bottom', 'Низ · K2 ↔']] as const).map(([value, label]) =>
            <button key={value} className={'btn' + (side === value ? ' primary' : '')} aria-pressed={side === value} onClick={() => setSide(value)}>{label}</button>)}
        </div>
        <label className="bp2d-theme">Оформление
          <select aria-label="Оформление платы" value={themeId} onChange={e => setThemeId(e.target.value as Board2DThemeId)}>
            {[...BOARD_2D_THEMES].sort((a, b) => Number(b.id === 'classic-dark') - Number(a.id === 'classic-dark')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <div className="bp2d-row bp2d-layers">
        {layers.map(([layer, label, color]) => {
          const disabled = (side === 'top' && (layer === 'k2' || layer === 's2')) || (side === 'bottom' && (layer === 'k1' || layer === 's1'));
          return <label key={layer} className={'chk' + (disabled ? ' is-disabled' : '')}>
            <input type="checkbox" checked={!hidden.has(layer)} disabled={disabled} onChange={() => toggleLayer(layer)} />
            <i className="bp2d-swatch" style={{ background: color }} />{label}
          </label>;
        })}
      </div>
    </div>
    <div className="bp2d-canvas-wrap" ref={wrapRef} style={{ height: `min(${height}px, 50vh)` }}>
      <canvas ref={canvasRef} aria-label={`Предпросмотр платы ${doc.name}. ${side === 'bottom' ? 'Нижняя сторона, зеркально' : side === 'top' ? 'Верхняя сторона' : 'Все слои'}`} tabIndex={0}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        onDoubleClick={fit}
        onKeyDown={e => {
          if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.2); }
          if (e.key === '-') { e.preventDefault(); zoom(1 / 1.2); }
          if (e.key === '0' || e.key === 'Home') { e.preventDefault(); fit(); }
        }}
        onPointerDown={e => {
          if (e.button !== 0 && e.button !== 1) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; setDragging(true);
        }}
        onPointerMove={e => {
          const last = drag.current;
          if (!last || last.id !== e.pointerId) return;
          const dx = e.clientX - last.x, dy = e.clientY - last.y;
          drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }}
        onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      />
      <span className="bp2d-view-label">{side === 'bottom' ? 'K2 / ВИД СНИЗУ · ЗЕРКАЛЬНО' : side === 'top' ? 'K1 / ВИД СВЕРХУ' : '2D / ВСЕ СЛОИ'}</span>
      <div className="bp2d-navigation">
        <button className="btn" aria-label="Уменьшить" onClick={() => zoom(1 / 1.2)}>−</button>
        <span title="Масштаб относительно вписанной платы">{Math.round(view.scale / fitScale * 100)}%</span>
        <button className="btn" aria-label="Увеличить" onClick={() => zoom(1.2)}>+</button>
        <button className="btn" onClick={fit} title="Вписать плату (Home или двойной щелчок)">Вписать</button>
      </div>
    </div>
    {outside && <div className="bp2d-warning" role="status">Есть элементы за границами платы {doc.w} × {doc.h} мм. Показан весь чертёж; размеры платы не изменены.</div>}
    <div className="bp2d-status">
      <label className="chk"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />Сетка</label>
      <label className="chk"><input type="checkbox" checked={showHoles} onChange={e => setShowHoles(e.target.checked)} />Сверловка</label>
      {!themeId.startsWith('classic') && themeId !== 'mono' && <label className="chk"><input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} />Маска</label>}
      <span className="bp2d-help">Колесо — масштаб · Перетаскивание — панорама</span>
    </div>
  </div>;
}
