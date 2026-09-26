// 2D предпросмотр платы в разных цветах — реалистичные темы маски, медь, шелкография.
import { useEffect, useRef, useState, useMemo } from 'react';
import type { Doc, LayerId } from '../pcb/model';
import { zOrdered } from '../pcb/render';
import { expandDoc } from '../pcb/expand';

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
    name: 'Классика редактора (тёмная)',
    board: '#0f1115',
    boardEdge: '#232830',
    copperTop: '#2f80ed',
    copperBottom: '#35c46a',
    copperBoth: '#f0a63c',
    maskTop: 'rgba(15, 17, 21, 0.0)',
    maskBottom: 'rgba(15, 17, 21, 0.0)',
    silkTop: '#e5484d',
    silkBottom: '#e8c93e',
    outline: '#e9ecf1',
    hole: '#0f1115',
    bg: '#0f1115',
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

function drawBoard2D(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  theme: Board2DTheme,
  opts: {
    showTop: boolean;
    showBottom: boolean;
    showSilk: boolean;
    showOutline: boolean;
    showHoles: boolean;
    showMask: boolean;
    side: 'top' | 'bottom' | 'both';
    scale: number;
    offsetX: number;
    offsetY: number;
  }
) {
  const { showTop, showBottom, showSilk, showOutline, showHoles, showMask, side, scale, offsetX, offsetY } = opts;
  const flat = zOrdered(doc);
  // Transform helpers
  const sx = (x: number) => offsetX + x * scale;
  const sy = (y: number) => offsetY + (doc.h - y) * scale; // Y up

  // Clear bg
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Board substrate
  ctx.fillStyle = theme.board;
  ctx.strokeStyle = theme.boardEdge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(sx(0), sy(doc.h), doc.w * scale, doc.h * scale);
  ctx.fill();
  ctx.stroke();

  // Helper to draw entity with theme colors
  const drawEntThemed = (e: any) => {
    const kind = e.kind;
    const layer = e.layer as LayerId | undefined;

    // Determine visibility and color
    let color: string | null = null;
    let isTop = false, isBottom = false, isSilk = false, isOutline = false, isHole = false;

    if (kind === 'pad' || kind === 'via') {
      isTop = isBottom = true;
      if (side === 'top' && !showTop && !showBottom) return;
      if (side === 'bottom' && !showBottom && !showTop) return;
      // Both layers pads visible in both views
      color = theme.copperBoth;
    } else if (kind === 'hole') {
      isHole = true;
      if (!showHoles) return;
      color = theme.hole;
    } else if (layer) {
      if (layer === 'k1') { isTop = true; if (!showTop) return; color = theme.copperTop; }
      else if (layer === 'k2') { isBottom = true; if (!showBottom) return; color = theme.copperBottom; }
      else if (layer === 's1') { isSilk = true; if (!showSilk) return; color = theme.silkTop; }
      else if (layer === 's2') { isSilk = true; if (!showSilk) return; color = theme.silkBottom; }
      else if (layer === 'outline') { isOutline = true; if (!showOutline) return; color = theme.outline; }
    } else {
      return;
    }

    // Side filtering
    if (side === 'top' && isBottom && !isTop && kind !== 'pad' && kind !== 'via' && kind !== 'hole') {
      // In top view, bottom copper is not visible (unless both)
      if (layer === 'k2' || layer === 's2') return;
    }
    if (side === 'bottom' && isTop && !isBottom && kind !== 'pad' && kind !== 'via' && kind !== 'hole') {
      if (layer === 'k1' || layer === 's1') return;
    }

    if (!color) return;

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    // Draw based on kind
    switch (kind) {
      case 'pad': {
        const x = sx(e.x), y = sy(e.y), r = (e.size / 2) * scale;
        ctx.beginPath();
        if (e.shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
        else if (e.shape === 'oct') {
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        } else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (e.drill > 0 && showHoles) {
          ctx.fillStyle = theme.hole;
          ctx.beginPath();
          ctx.arc(x, y, Math.max((e.drill / 2) * scale, 1.5), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'via': {
        const x = sx(e.x), y = sy(e.y);
        ctx.beginPath();
        ctx.arc(x, y, (e.size / 2) * scale, 0, Math.PI * 2);
        ctx.fill();
        if (showHoles) {
          ctx.fillStyle = theme.hole;
          ctx.beginPath();
          ctx.arc(x, y, Math.max((e.drill / 2) * scale, 1), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'smd': {
        const rot = ((Math.round(e.rot) % 180) + 180) % 180;
        const w = (rot === 0 ? e.w : e.h) * scale;
        const h = (rot === 0 ? e.h : e.w) * scale;
        ctx.fillRect(sx(e.x) - w / 2, sy(e.y) - h / 2, w, h);
        break;
      }
      case 'track': {
        if (e.pts.length < 2) break;
        ctx.lineWidth = Math.max(e.w * scale, 1);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(sx(e.pts[0].x), sy(e.pts[0].y));
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(sx(e.pts[i].x), sy(e.pts[i].y));
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.lineWidth = Math.max(e.w * scale, 0.8);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx(e.x1), sy(e.y1));
        ctx.lineTo(sx(e.x2), sy(e.y2));
        ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.lineWidth = Math.max(e.w * scale, 0.8);
        ctx.beginPath();
        ctx.arc(sx(e.x), sy(e.y), e.r * scale, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'rect': {
        const x1 = sx(e.x), y1 = sy(e.y + e.h);
        const wpx = e.w * scale, hpx = e.h * scale;
        if (e.filled) ctx.fillRect(x1, y1, wpx, hpx);
        else {
          ctx.lineWidth = Math.max(e.th * scale, 0.8);
          ctx.strokeRect(x1, y1, wpx, hpx);
        }
        break;
      }
      case 'poly': {
        if (e.pts.length < 3) break;
        ctx.beginPath();
        ctx.moveTo(sx(e.pts[0].x), sy(e.pts[0].y));
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(sx(e.pts[i].x), sy(e.pts[i].y));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'text': {
        if (!e.text) break;
        ctx.save();
        ctx.translate(sx(e.x), sy(e.y));
        ctx.rotate((-e.rot * Math.PI) / 180);
        if (e.mirror) ctx.scale(-1, 1);
        const px = e.size * scale;
        ctx.font = `${px}px sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(e.text, 0, 0);
        ctx.restore();
        break;
      }
      case 'hole': {
        const x = sx(e.x), y = sy(e.y), r = (e.d / 2) * scale;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(r, 1.5), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  };

  // Draw order: bottom copper, top copper, silk, outline, holes on top
  // For realistic, we draw copper first, then mask overlay, then silk
  const copperEnts = flat.filter(e => e.kind === 'pad' || e.kind === 'via' || e.kind === 'smd' || e.kind === 'track' || (e as any).layer === 'k1' || (e as any).layer === 'k2');
  const silkEnts = flat.filter(e => (e as any).layer === 's1' || (e as any).layer === 's2' || e.kind === 'text' || e.kind === 'line' || e.kind === 'circle' || e.kind === 'rect' || e.kind === 'poly');
  const outlineEnts = flat.filter(e => (e as any).layer === 'outline');
  const holeEnts = flat.filter(e => e.kind === 'hole');

  // Copper
  for (const e of copperEnts) drawEntThemed(e);

  // Solder mask overlay (semi-transparent) for realistic themes
  if (showMask && (theme.maskTop !== 'rgba(255,255,255,0)' || theme.maskBottom !== 'rgba(255,255,255,0)')) {
    ctx.save();
    ctx.fillStyle = side === 'bottom' ? theme.maskBottom : side === 'top' ? theme.maskTop : theme.maskTop;
    if (side === 'both') {
      // For both view, show mask as slight overlay
      ctx.globalAlpha = 0.5;
    }
    ctx.fillRect(sx(0), sy(doc.h), doc.w * scale, doc.h * scale);
    // Cut out copper areas (so copper shines through mask openings)
    // For simplicity, we don't cut - we already drew copper, mask is transparent so copper shows
    ctx.restore();
  }

  // Silk
  if (showSilk) {
    for (const e of silkEnts) {
      const l = (e as any).layer;
      if (l && l !== 's1' && l !== 's2' && l !== 'outline' && e.kind !== 'text' && e.kind !== 'line' && e.kind !== 'circle' && e.kind !== 'rect' && e.kind !== 'poly') continue;
      // Only silk layers
      if (e.kind === 'pad' || e.kind === 'via' || e.kind === 'smd' || e.kind === 'track' || e.kind === 'hole') continue;
      if (l === 'k1' || l === 'k2') continue; // already drawn as copper
      drawEntThemed(e);
    }
  }

  // Outline
  if (showOutline) {
    for (const e of outlineEnts) drawEntThemed(e);
  }

  // Holes (drill) on top
  if (showHoles) {
    for (const e of holeEnts) drawEntThemed(e);
    // Also drill holes from pads/vias already drawn, but ensure hole color visible
  }
}

export function BoardPreview2D({
  doc,
  width = 800,
  height = 600,
}: {
  doc: Doc;
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [themeId, setThemeId] = useState<Board2DThemeId>('green');
  const [side, setSide] = useState<'top' | 'bottom' | 'both'>('top');
  const [showTop, setShowTop] = useState(true);
  const [showBottom, setShowBottom] = useState(true);
  const [showSilk, setShowSilk] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [showHoles, setShowHoles] = useState(true);
  const [showMask, setShowMask] = useState(true);
  const [scale, setScale] = useState(8);
  const [offset, setOffset] = useState({ x: 20, y: 20 });
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const theme = useMemo(() => BOARD_2D_THEMES.find(t => t.id === themeId) || BOARD_2D_THEMES[0], [themeId]);

  const fit = () => {
    const pad = 20;
    const s = Math.min((width - pad * 2) / doc.w, (height - pad * 2) / doc.h);
    setScale(Math.max(1, s));
    setOffset({ x: (width - doc.w * s) / 2, y: (height - doc.h * s) / 2 });
  };

  useEffect(() => { fit(); }, [doc.w, doc.h, width, height]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    cv.style.width = width + 'px';
    cv.style.height = height + 'px';
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBoard2D(ctx, doc, theme, {
      showTop,
      showBottom,
      showSilk,
      showOutline,
      showHoles,
      showMask,
      side,
      scale,
      offsetX: offset.x,
      offsetY: offset.y,
    });
  }, [doc, theme, showTop, showBottom, showSilk, showOutline, showHoles, showMask, side, scale, offset, width, height]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - offset.x) / scale;
    const wy = (my - offset.y) / scale;
    const ns = Math.max(0.5, Math.min(100, scale * factor));
    setScale(ns);
    setOffset({ x: mx - wx * ns, y: my - wy * ns });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
  };
  const onMouseUp = () => { isDragging.current = false; };

  return (
    <div className="board-preview-2d">
      <div className="bp2d-toolbar">
        <div className="bp2d-row">
          <label>Тема:
            <select value={themeId} onChange={e => setThemeId(e.target.value as Board2DThemeId)}>
              {BOARD_2D_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label>Вид:
            <select value={side} onChange={e => setSide(e.target.value as any)}>
              <option value="top">Верх K1</option>
              <option value="bottom">Низ K2</option>
              <option value="both">Обе стороны</option>
            </select>
          </label>
          <button className="btn" onClick={fit}>Вписать</button>
          <span className="bp2d-zoom">Масштаб: {Math.round(scale * 10)}%</span>
        </div>
        <div className="bp2d-row">
          <label className="chk"><input type="checkbox" checked={showTop} onChange={e => setShowTop(e.target.checked)} />K1 верх</label>
          <label className="chk"><input type="checkbox" checked={showBottom} onChange={e => setShowBottom(e.target.checked)} />K2 низ</label>
          <label className="chk"><input type="checkbox" checked={showSilk} onChange={e => setShowSilk(e.target.checked)} />Шелкография</label>
          <label className="chk"><input type="checkbox" checked={showOutline} onChange={e => setShowOutline(e.target.checked)} />Контур</label>
          <label className="chk"><input type="checkbox" checked={showHoles} onChange={e => setShowHoles(e.target.checked)} />Отверстия</label>
          <label className="chk"><input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} />Маска</label>
        </div>
      </div>
      <div className="bp2d-canvas-wrap" style={{ width, height }}>
        <canvas
          ref={canvasRef}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          style={{ cursor: isDragging.current ? 'grabbing' : 'grab', borderRadius: 8, border: '1px solid var(--line)' }}
        />
      </div>
      <div className="bp2d-legend">
        <span style={{ background: theme.copperTop }} className="bp2d-swatch" /> K1 медь
        <span style={{ background: theme.copperBottom }} className="bp2d-swatch" /> K2 медь
        <span style={{ background: theme.silkTop }} className="bp2d-swatch" /> Шелк
        <span style={{ background: theme.board }} className="bp2d-swatch" /> Плата
      </div>
    </div>
  );
}
