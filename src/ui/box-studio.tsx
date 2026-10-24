// Студия коробок — каталог параметрических генераторов (28 типов, как
// box.laserbiz.ru): выбрал тип, подкрутил размеры, покрутил сборку в 3D,
// посмотрел раскладку на листе и забрал точный DXF.
//
// Всё считается локально в браузере: src/laser/boxes.ts строит детали с
// настоящими замками шип-паз, раскладка — та же, что для развёрток.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ic } from './icons';
import { Modal, NI, SI, TI } from './widgets';
import {
  BOX_FAMILIES, BOX_TYPES, boxThumbnail, buildBox, defaultBoxParams, layoutBoxParts,
  projectAssembly, type BoxFamily, type BoxParamDef, type BoxParamValues,
} from '../laser/boxes';
import { newLaserDoc, shapeToPolylines, type LaserDoc, type LaserGroup, type LaserShape } from '../laser/model';
import { exportLaserDxf, exportLaserSvg } from '../laser/export';
import { safeFileName } from '../laser/project';
import { download } from '../pcb/zip';

/** Миниатюры каталога считаем один раз и держим в кэше. */
const thumbCache = new Map<string, { paths: string[]; holes: string[] }>();
const thumbOf = (id: string): { paths: string[]; holes: string[] } => {
  let t = thumbCache.get(id);
  if (!t) {
    try {
      t = boxThumbnail(id, 68);
    } catch {
      t = { paths: [], holes: [] };
    }
    thumbCache.set(id, t);
  }
  return t;
};

/** Стандартные столы лазеров — для кнопки «подобрать лист». */
const SHEET_CHOICES: [number, number][] = [
  [320, 220], [420, 300], [600, 400], [900, 600], [1300, 900], [1600, 1000],
];

export interface BoxApplyPayload {
  shapes: LaserShape[];
  groups: LaserGroup[];
  title: string;
}

export function BoxStudio({
  doc,
  onApply,
  onClose,
  onMsg,
}: {
  doc: LaserDoc;
  onApply: (p: BoxApplyPayload) => void;
  onClose: () => void;
  onMsg: (m: { text: string; ok: boolean }) => void;
}) {
  const [typeId, setTypeId] = useState<string>(BOX_TYPES[0].id);
  const [family, setFamily] = useState<BoxFamily | 'all'>('all');
  const [store, setStore] = useState<Record<string, BoxParamValues>>({});
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [yaw, setYaw] = useState(34);
  const [pitch, setPitch] = useState(22);
  const [advanced, setAdvanced] = useState(false);
  const [sheetW, setSheetW] = useState(Math.max(100, doc.w));
  const [sheetH, setSheetH] = useState(Math.max(100, doc.h));
  const [gap, setGap] = useState(4);
  const [margin, setMargin] = useState(6);
  const [search, setSearch] = useState('');

  const def = BOX_TYPES.find((t) => t.id === typeId) ?? BOX_TYPES[0];

  // Толщину подставляем из материала листа, пока пользователь не задал свою
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !doc.materialThickness) return;
    seeded.current = true;
    const id = BOX_TYPES[0].id;
    setStore((s) => ({ ...s, [id]: { ...(s[id] ?? {}), thickness: doc.materialThickness } }));
  }, [doc.materialThickness]);

  const values = useMemo<BoxParamValues>(() => ({ ...defaultBoxParams(def), ...(store[def.id] ?? {}) }), [def, store]);
  const vKey = JSON.stringify(values);

  const built = useMemo(() => buildBox(def.id, values), [def.id, vKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const thickness = Math.max(0.5, Number(built.params.thickness) || 4);

  const layout = useMemo(
    () => layoutBoxParts(built.parts, { sheetW, sheetH, gap, margin }),
    [built, sheetW, sheetH, gap, margin]
  );
  const proj = useMemo(
    () => (view === '3d' ? projectAssembly(built.parts, yaw, pitch, thickness) : null),
    [built, view, yaw, pitch, thickness]
  );

  const patch = useCallback(
    (key: string, v: number | string | boolean) => {
      setStore((s) => ({ ...s, [def.id]: { ...(s[def.id] ?? {}), [key]: v } }));
    },
    [def.id]
  );

  const resetType = useCallback(() => {
    setStore((s) => {
      const next = { ...s };
      delete next[def.id];
      return next;
    });
    onMsg({ text: `Параметры «${def.name}» сброшены`, ok: true });
  }, [def, onMsg]);

  /** Временный документ для экспорта: тот же набор слоёв, что и в редакторе. */
  const tempDoc = useCallback((): LaserDoc => {
    const d = newLaserDoc(sheetW, sheetH, `${def.name} — PSBees`);
    return { ...d, layers: doc.layers, shapes: layout.shapes, groups: layout.groups, materialThickness: thickness };
  }, [sheetW, sheetH, def.name, doc.layers, layout, thickness]);

  const saveDxf = useCallback(() => {
    try {
      const text = exportLaserDxf(tempDoc());
      download(`${safeFileName(def.name)}.dxf`, new Blob([text], { type: 'application/dxf;charset=utf-8' }));
      onMsg({ text: `DXF сохранён: ${def.name}, ${layout.parts} дет., ${(text.length / 1024).toFixed(0)} КБ`, ok: true });
    } catch (e) {
      onMsg({ text: e instanceof Error ? e.message : 'Не удалось собрать DXF', ok: false });
    }
  }, [tempDoc, def.name, layout.parts, onMsg]);

  const saveSvg = useCallback(() => {
    try {
      const text = exportLaserSvg(tempDoc());
      download(`${safeFileName(def.name)}.svg`, new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
      onMsg({ text: `SVG сохранён: ${def.name}, ${layout.parts} дет.`, ok: true });
    } catch (e) {
      onMsg({ text: e instanceof Error ? e.message : 'Не удалось собрать SVG', ok: false });
    }
  }, [tempDoc, def.name, layout.parts, onMsg]);

  const apply = useCallback(() => {
    if (!layout.shapes.length) {
      onMsg({ text: 'Нечего помещать: проверьте параметры генератора', ok: false });
      return;
    }
    onApply({ shapes: layout.shapes, groups: layout.groups, title: `${def.name} (${layout.parts} дет.)` });
    onClose();
  }, [layout, def.name, onApply, onClose, onMsg]);

  const fitSheet = useCallback(() => {
    for (const [w, h] of SHEET_CHOICES) {
      const l = layoutBoxParts(built.parts, { sheetW: w, sheetH: h, gap, margin });
      if (l.fits) {
        setSheetW(w);
        setSheetH(h);
        onMsg({ text: `Подобран лист ${w}×${h} мм — все детали влезают`, ok: true });
        return;
      }
    }
    onMsg({ text: 'Детали крупнее любого стандартного листа — уменьшите размеры коробки', ok: false });
  }, [built, gap, margin, onMsg]);

  // ---------------- каталог ----------------

  const q = search.trim().toLowerCase();
  const list = useMemo(
    () =>
      BOX_TYPES.filter(
        (t) =>
          (family === 'all' || t.family === family) &&
          (!q || t.name.toLowerCase().includes(q) || t.id.includes(q) || t.desc.toLowerCase().includes(q))
      ),
    [family, q]
  );

  // ---------------- форма параметров ----------------

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, BoxParamDef[]>();
    for (const d of def.params) {
      if (d.advanced && !advanced) continue;
      const g = d.group ?? 'Параметры';
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(d);
    }
    return order.map((g) => ({ name: g, items: map.get(g)! }));
  }, [def, advanced]);

  const hasAdvanced = def.params.some((d) => d.advanced);

  const field = (d: BoxParamDef) => {
    const v = values[d.key];
    if (d.kind === 'boolean') {
      return (
        <label className="laser-check bs-check" key={d.key} title={d.hint}>
          <input type="checkbox" checked={!!v} onChange={(e) => patch(d.key, e.target.checked)} />
          {d.label}
        </label>
      );
    }
    if (d.kind === 'select') {
      return (
        <SI
          key={d.key}
          label={d.label}
          value={String(v ?? d.def)}
          options={(d.options ?? []).map((o) => [o.id, o.label] as [string, string])}
          on={(nv) => patch(d.key, nv)}
        />
      );
    }
    if (d.kind === 'text') {
      return <TI key={d.key} label={d.label} value={String(v ?? '')} on={(nv) => patch(d.key, nv)} />;
    }
    return (
      <NI
        key={d.key}
        label={d.unit ? `${d.label}, ${d.unit}` : d.label}
        value={Number(v ?? d.def)}
        min={d.min}
        max={d.max}
        step={d.step ?? 0.5}
        on={(nv) => patch(d.key, nv)}
      />
    );
  };

  // ---------------- предпросмотр ----------------

  const drag = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setYaw((y) => y + (e.clientX - drag.current!.x) * 0.55);
    setPitch((p) => Math.max(-85, Math.min(85, p - (e.clientY - drag.current!.y) * 0.45)));
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { drag.current = null; };

  const stats: [string, string][] = [
    ['Деталей', String(layout.parts)],
    ['Рез', `${(layout.cutLengthMm / 1000).toFixed(2)} м`],
    ['Биговка', `${(layout.scoreLengthMm / 1000).toFixed(2)} м`],
    ['Габарит', `${built.size.w.toFixed(0)}×${built.size.d.toFixed(0)}×${built.size.h.toFixed(0)} мм`],
    ['Лист', layout.fits ? `${sheetW}×${sheetH} мм` : `не влезает, ~${layout.sheets} л.`],
  ];

  return (
    <Modal
      title="Генератор коробок: каталог, параметры, раскладка и DXF"
      onClose={onClose}
      className="box-studio"
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>Закрыть</button>
          <button type="button" className="btn" onClick={saveSvg} title="SVG в масштабе 1:1 мм">
            <Ic n="png" size={14} /> SVG
          </button>
          <button type="button" className="btn" onClick={saveDxf} title="Точный DXF: контур, отверстия, биговка, подписи по слоям">
            <Ic n="gerber" size={14} /> DXF
          </button>
          <button type="button" className="btn primary" onClick={apply} disabled={!layout.shapes.length}>
            <Ic n="check" size={14} /> Поместить на лист
          </button>
        </>
      }
    >
      <div className="bs-body">
        {/* ---------------- каталог ---------------- */}
        <div className="bs-catalog">
          <input
            className="bs-search"
            type="text"
            placeholder="Поиск по каталогу…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="bs-families">
            <button type="button" className={family === 'all' ? 'on' : ''} onClick={() => setFamily('all')}>
              Все ({BOX_TYPES.length})
            </button>
            {BOX_FAMILIES.map((f) => (
              <button
                type="button"
                key={f.id}
                className={family === f.id ? 'on' : ''}
                onClick={() => setFamily(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="bs-grid">
            {list.map((t) => {
              const th = thumbOf(t.id);
              return (
                <button
                  type="button"
                  key={t.id}
                  className={'bs-card' + (t.id === typeId ? ' active' : '')}
                  title={t.desc}
                  onClick={() => setTypeId(t.id)}
                >
                  <svg viewBox="0 0 68 68" preserveAspectRatio="xMidYMid meet" aria-hidden>
                    {th.paths.map((d, i) => (
                      <polyline key={i} points={d} />
                    ))}
                    {th.holes.map((d, i) => (
                      <polyline key={`h${i}`} points={d} className="bs-thumb-hole" />
                    ))}
                  </svg>
                  <span>{t.name}</span>
                </button>
              );
            })}
            {!list.length && <p className="sub bs-empty">Ничего не найдено</p>}
          </div>
        </div>

        {/* ---------------- превью ---------------- */}
        <div className="bs-preview">
          <div className="bs-preview-head">
            <div className="bs-title">
              <b>{def.name}</b>
              <span>{def.desc}</span>
            </div>
            <div className="bs-viewswitch">
              <button type="button" className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>
                <Ic n="preview3d" size={14} /> Сборка
              </button>
              <button type="button" className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>
                <Ic n="preview2d" size={14} /> Раскладка
              </button>
            </div>
          </div>

          <div
            className="bs-canvas"
            onPointerDown={view === '3d' ? onDown : undefined}
            onPointerMove={view === '3d' ? onMove : undefined}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {view === '3d' && proj && (
              <svg
                viewBox={`${proj.bbox[0] - 8} ${proj.bbox[1] - 8} ${Math.max(4, proj.bbox[2] - proj.bbox[0] + 16)} ${Math.max(4, proj.bbox[3] - proj.bbox[1] + 16)}`}
                preserveAspectRatio="xMidYMid meet"
              >
                {[...proj.polys]
                  .sort((a, b) => a.depth - b.depth)
                  .map((p, i) => (
                    <polygon
                      key={i}
                      points={p.pts.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')}
                      fill={`rgba(255,194,51,${(0.1 + 0.45 * p.shade).toFixed(3)})`}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>{p.name}</title>
                    </polygon>
                  ))}
              </svg>
            )}
            {view === '2d' && (
              <svg viewBox={`0 0 ${sheetW} ${sheetH}`} preserveAspectRatio="xMidYMid meet">
                <rect x={0} y={0} width={sheetW} height={sheetH} className="bs-sheet" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {layout.shapes.map((s) =>
                  shapeToPolylines(s).map((pts, i) => (
                    <polyline
                      key={`${s.id}:${i}`}
                      points={pts.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')}
                      stroke={doc.layers[s.layer]?.color ?? '#ffc233'}
                      fill="none"
                      strokeWidth={1.2}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))
                )}
              </svg>
            )}
          </div>

          <div className="bs-stats">
            {stats.map(([k, v]) => (
              <div key={k}><span>{k}</span><b className={k === 'Лист' && !layout.fits ? 'bad' : ''}>{v}</b></div>
            ))}
          </div>

          {built.warnings.length > 0 && (
            <div className="bs-warn">
              {built.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}

          <div className="bs-nesting">
            <NI label="Зазор, мм" value={gap} min={0} max={40} step={0.5} on={setGap} />
            <NI label="Отступ от края, мм" value={margin} min={0} max={60} step={0.5} on={setMargin} />
            <NI label="Лист: ширина, мм" value={sheetW} min={50} max={4000} step={10} on={setSheetW} />
            <NI label="Лист: высота, мм" value={sheetH} min={50} max={4000} step={10} on={setSheetH} />
            <button type="button" className="btn" onClick={fitSheet} title="Подобрать наименьший стандартный лист, на котором всё влезает">
              <Ic n="fit" size={14} /> Подобрать лист
            </button>
          </div>
          {view === '3d' && <p className="sub bs-hint">Крутите сборку мышью. Серым показаны грани, золото — освещённость.</p>}
        </div>

        {/* ---------------- параметры ---------------- */}
        <div className="bs-params">
          <div className="bs-params-head">
            <b>Параметры</b>
            <button type="button" className="btn tiny" onClick={resetType} title="Вернуть значения по умолчанию">Сброс</button>
          </div>
          <div className="bs-params-scroll">
            {groups.map((g) => (
              <div className="bs-group" key={g.name}>
                <h4>{g.name}</h4>
                {g.items.map(field)}
                {g.items.some((d) => d.hint) && (
                  <p className="sub">{g.items.find((d) => d.hint)!.hint}</p>
                )}
              </div>
            ))}
            {hasAdvanced && (
              <button type="button" className="bs-more" onClick={() => setAdvanced((a) => !a)}>
                <Ic n="caret" size={14} />
                {advanced ? 'Скрыть тонкие настройки' : `Тонкие настройки (${def.params.filter((d) => d.advanced).length})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
