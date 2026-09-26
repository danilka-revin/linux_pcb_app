// Предпросмотр хода станка: медь, канавка реза в масштабе, анимация фрезы по контуру.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc, Pt } from '../pcb/model';
import type { CncJob } from '../pcb/cnc';
import { isolationKerf, isolationNeed, type CncSettings } from '../pcb/cnc-settings';

const n = (v: number) => String(Number(v.toFixed(3)));
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

function svgPath(paths: Pt[][], closed = true): string {
  return paths.map((path) => {
    if (!path.length) return '';
    const d = `M${path.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}`;
    return closed ? `${d}Z` : d;
  }).join('');
}

function loopLen(path: Pt[]): number {
  if (path.length < 2) return 0;
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]);
  if (path.length > 2) L += dist(path[path.length - 1], path[0]);
  return L;
}

function atLen(path: Pt[], s: number): Pt {
  if (path.length === 1) return path[0];
  let rest = Math.max(0, s);
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i - 1], path[i]);
    if (rest <= d || i === path.length - 1) {
      const t = d > 0 ? Math.min(1, rest / d) : 0;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
      };
    }
    rest -= d;
  }
  return path[path.length - 1];
}

type Seg = { kind: 'cut' | 'rapid'; path: Pt[]; length: number; loop: number };

function segsOf(loops: Pt[][]): Seg[] {
  const segs: Seg[] = [];
  let last: Pt | null = null;
  let loop = 0;
  for (const raw of loops) {
    if (raw.length < 3) continue;
    const closed = [...raw, raw[0]];
    if (last) segs.push({ kind: 'rapid', path: [last, closed[0]], length: Math.max(dist(last, closed[0]), 0.001), loop });
    segs.push({ kind: 'cut', path: closed, length: Math.max(loopLen(raw), 0.001), loop });
    last = closed[0];
    loop++;
  }
  return segs;
}

function sample(segs: Seg[], d: number): { p: Pt; kind: 'cut' | 'rapid'; loop: number; cuts: number } {
  const total = segs.reduce((a, s) => a + s.length, 0);
  const cuts = segs.filter((s) => s.kind === 'cut').length;
  if (!segs.length || total <= 0) return { p: { x: 0, y: 0 }, kind: 'cut', loop: 0, cuts };
  let rest = ((d % total) + total) % total;
  for (const seg of segs) {
    if (rest <= seg.length) return { p: atLen(seg.path, rest), kind: seg.kind, loop: seg.loop, cuts };
    rest -= seg.length;
  }
  const last = segs[segs.length - 1];
  return { p: last.path[last.path.length - 1], kind: last.kind, loop: last.loop, cuts };
}

export function CncPreview({
  doc, settings, job, side,
}: {
  doc: Doc;
  settings: CncSettings;
  job: CncJob;
  side: 'top' | 'bottom';
}) {
  const loops = side === 'top' ? job.preview.top : job.preview.bottom;
  const copper = side === 'top' ? job.preview.copperTop : job.preview.copperBottom;
  const segs = useMemo(() => segsOf(loops ?? []), [loops]);
  const cutLen = useMemo(() => segs.filter((s) => s.kind === 'cut').reduce((a, s) => a + s.length, 0), [segs]);
  const totalLen = useMemo(() => segs.reduce((a, s) => a + s.length, 0), [segs]);
  const rapids = useMemo(() => segs.filter((s) => s.kind === 'rapid').map((s) => s.path), [segs]);
  const kerf = isolationKerf(settings);
  const need = isolationNeed(settings);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const distRef = useRef(0);
  const toolRef = useRef<SVGGElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const setStatus = (label: string) => { if (statusRef.current) statusRef.current.textContent = label; };

  const place = (d: number) => {
    if (!segs.length) return;
    const { p, kind, loop, cuts } = sample(segs, d);
    const g = toolRef.current;
    if (g) {
      g.setAttribute('transform', `translate(${p.x} ${p.y})`);
      g.setAttribute('data-phase', kind);
    }
    let walked = totalLen > 0 ? ((d % totalLen) + totalLen) % totalLen : 0;
    let cut = 0;
    for (const s of segs) {
      const take = Math.min(s.length, walked);
      if (s.kind === 'cut') cut += take;
      walked -= take;
      if (walked <= 0) break;
    }
    const pct = cutLen > 0 ? Math.min(100, (cut / cutLen) * 100) : 0;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    setStatus(kind === 'rapid'
      ? `Перелёт к контуру ${loop + 1} из ${cuts}`
      : `Режет контур ${loop + 1} из ${cuts} · ${n(cut)} мм из ${n(cutLen)} мм`);
  };

  useEffect(() => {
    distRef.current = 0;
    setPlaying(false);
    place(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сброс при смене стороны/контуров
  }, [side, loops, segs]);

  useEffect(() => {
    if (!playing || reduce || !segs.length) return;
    const mmPerSec = Math.max(12, (cutLen || 40) / 7) * speed;
    let last = performance.now();
    let id = 0;
    const tick = (now: number) => {
      distRef.current += ((now - last) / 1000) * mmPerSec;
      last = now;
      if (totalLen > 0 && distRef.current >= totalLen) {
        distRef.current = totalLen;
        place(distRef.current);
        setPlaying(false);
        setStatus('Проход закончен — можно просмотреть ещё раз.');
        return;
      }
      place(distRef.current);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, segs, cutLen, totalLen, reduce]);

  const start = () => {
    if (reduce) { setStatus('Анимация отключена (уменьшение движения). Контуры показаны целиком.'); return; }
    if (totalLen > 0 && distRef.current >= totalLen - 1e-6) distRef.current = 0;
    setPlaying(true);
  };

  const vbX = -settings.originX, vbY = -settings.originY;
  const vbW = doc.w + 2 * settings.originX, vbH = doc.h + 2 * settings.originY;
  const r = Math.max(0.05, settings.toolDiameter / 2);
  const first = loops?.[0]?.[0];

  return (
    <div className="cnc-walk">
      <div className="cnc-preview-stats" aria-live="polite">
        <span>Разделение меди <b>{n(need)} мм</b></span>
        <span>Рез <b>Ø{n(kerf)}</b></span>
        <span>Запас <b>{n(settings.clearance)} мм</b></span>
        <span>Ход <b>{n(cutLen)} мм</b> · {loops?.length ?? 0} конт.</span>
      </div>
      <svg className="cnc-preview" viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        role="img"
        aria-label={`Ход фрезы по ${side === 'top' ? 'верху' : 'зеркальному низу'}: медь, канавка реза и отверстия`}>
        <g transform={`translate(0 ${doc.h}) scale(1 -1)`}>
          <rect x={vbX} y={vbY} width={vbW} height={vbH} className="cnc-preview-stock" />
          <rect x={0} y={0} width={doc.w} height={doc.h} className="cnc-preview-board" />
          {copper && <path d={svgPath(copper)} fillRule="evenodd" className="cnc-preview-copper" />}
          {loops && loops.length > 0 && (
            <path d={svgPath(loops)} className="cnc-preview-kerf"
              strokeWidth={kerf} />
          )}
          {loops && <path d={svgPath(loops)} className="cnc-preview-path" />}
          {rapids.length > 0 && <path d={svgPath(rapids, false)} className="cnc-preview-rapid" />}
          {settings.drillSide === side && job.preview.drills.map((p, i) =>
            <circle key={i} cx={p.x} cy={p.y} r={Math.max(0.15, Math.min(doc.w, doc.h) / 140)} className="cnc-preview-hole" />)}
          {first && (
            <g ref={toolRef} className="cnc-walk-tool" transform={`translate(${first.x} ${first.y})`} data-phase="cut">
              <circle r={r} className="cnc-preview-tool-body" />
              <circle r={r} className="cnc-preview-tool-halo" />
              <line x1={-r * 1.6} x2={r * 1.6} y1={0} y2={0} className="cnc-preview-tool-cross" />
              <line y1={-r * 1.6} y2={r * 1.6} x1={0} x2={0} className="cnc-preview-tool-cross" />
            </g>
          )}
        </g>
      </svg>
      <div className="cnc-walk-bar" aria-hidden="true"><span ref={fillRef} className="cnc-walk-fill" /></div>
      <div className="cnc-walk-controls">
        <button type="button" className="btn primary cnc-walk-play" disabled={!segs.length} onClick={() => playing ? setPlaying(false) : start()}>
          {playing ? 'Пауза' : 'Старт — ход станка'}
        </button>
        <button type="button" className="btn" disabled={!segs.length} onClick={() => { setPlaying(false); distRef.current = 0; place(0); setStatus('Нажмите «Старт» — фреза пойдёт по контуру.'); }}>Сначала</button>
        <span className="cnc-walk-speed" role="group" aria-label="Скорость предпросмотра">
          <button type="button" className={'btn' + (speed === 0.5 ? ' primary' : '')} onClick={() => setSpeed(0.5)}>×0.5</button>
          <button type="button" className={'btn' + (speed === 1 ? ' primary' : '')} onClick={() => setSpeed(1)}>×1</button>
          <button type="button" className={'btn' + (speed === 2 ? ' primary' : '')} onClick={() => setSpeed(2)}>×2</button>
        </span>
        <span className="cnc-walk-status" ref={statusRef}>Нажмите «Старт» — фреза пойдёт по контуру.</span>
      </div>
      <div className="cnc-preview-legend">
        Жёлтое — оставляемая медь; тёмная полоса — канавка реза шириной Ø{n(kerf)} мм;
        голубая линия — центр фрезы; пунктир — перелёт; кружок с крестом — фреза;
        красные точки — сверловка. Разделение меди {n(need)} мм = рез + запас {n(settings.clearance)} мм с двух сторон.
      </div>
    </div>
  );
}
