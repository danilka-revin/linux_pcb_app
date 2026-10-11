// Визуальная проверка реального Gerber/Excellon-экспорта платы.
import { useMemo, useState } from 'react';
import type { Doc } from '../pcb/model';
import { productionFiles } from '../pcb/gerber';
import { parseExcellon, parseGerber, type DrillHit, type GerberLayerData, type GerberPrimitive } from '../pcb/gerber-viewer';
import { Modal } from './widgets';

interface CamLayer { id: string; name: string; color: string; data: GerberLayerData }
const COLORS = ['#ff553e', '#4ba8ff', '#f1cb47', '#8b6cff', '#55d99a', '#d28aff', '#f5f5f5'];
const fmt = (n: number): string => Number(n.toFixed(4)).toString();

function renderPrimitive(p: GerberPrimitive, index: number, bg: string, color: string): JSX.Element | null {
  const ink = p.polarity === 'clear' ? bg : color;
  const first = p.points[0];
  if (!first) return null;
  if (p.kind === 'flash') {
    if (p.aperture.shape === 'R') return <rect key={index}
      x={first.x - p.aperture.width / 2} y={-first.y - p.aperture.height / 2}
      width={p.aperture.width} height={p.aperture.height} fill={ink} />;
    if (p.aperture.shape === 'P') {
      const n = p.aperture.vertices ?? 6, a0 = ((p.aperture.rotation ?? 0) * Math.PI) / 180;
      const r = p.aperture.width / 2;
      const points = Array.from({ length: n }, (_, i) => {
        const a = a0 + i * 2 * Math.PI / n;
        return `${fmt(first.x + r * Math.cos(a))},${fmt(-first.y - r * Math.sin(a))}`;
      }).join(' ');
      return <polygon key={index} points={points} fill={ink} />;
    }
    return <circle key={index} cx={first.x} cy={-first.y} r={p.aperture.width / 2} fill={ink} />;
  }
  const d = p.points.map((point, i) => `${i ? 'L' : 'M'}${fmt(point.x)},${fmt(-point.y)}`).join(' ');
  return p.kind === 'region'
    ? <path key={index} d={d + ' Z'} fill={ink} fillRule="evenodd" />
    : <path key={index} d={d} fill="none" stroke={ink} strokeWidth={p.aperture.width} strokeLinecap="round" strokeLinejoin="round" />;
}

export function GerberPreviewDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const source = useMemo(() => productionFiles(doc), [doc]);
  const [externalLayers, setExternalLayers] = useState<CamLayer[]>([]);
  const [externalHoles, setExternalHoles] = useState<DrillHit[]>([]);
  const [importError, setImportError] = useState('');
  const [importNote, setImportNote] = useState('');
  const layers = useMemo(() => [
    ...source.filter((file) => !/\.xln$/i.test(file.name)).map((file, i) => ({
      id: `generated:${file.name}`, name: file.name, color: COLORS[i % COLORS.length], data: parseGerber(file.data),
    })),
    ...externalLayers,
  ], [source, externalLayers]);
  const drillFile = source.find((file) => /\.xln$/i.test(file.name));
  const holes = useMemo(() => [...(drillFile ? parseExcellon(drillFile.data) : []), ...externalHoles], [drillFile, externalHoles]);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [drillsVisible, setDrillsVisible] = useState(true);
  const importFiles = async (files: File[]): Promise<void> => {
    setImportError(''); setImportNote('');
    const nextLayers: CamLayer[] = [], nextHoles: DrillHit[] = [], errors: string[] = [];
    for (const file of files) {
      try {
        if (file.size > 40 * 1024 * 1024) throw new Error('превышен лимит 40 МБ');
        const text = await file.text();
        const drill = /\.(?:xln|drl|drd|exc|tap)$/i.test(file.name)
          || /^\s*(?:M48\b|INCH(?:,|\b)|METRIC(?:,|\b))/im.test(text);
        if (drill) {
          const hits = parseExcellon(text);
          if (!hits.length) throw new Error('не найдено ни одного сверления Excellon');
          nextHoles.push(...hits);
        } else {
          const data = parseGerber(text);
          if (!data.primitives.length) throw new Error('не найдена геометрия RS-274X');
          nextLayers.push({
            id: `external:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}:${nextLayers.length}`,
            name: file.name, color: COLORS[(source.length + externalLayers.length + nextLayers.length) % COLORS.length], data,
          });
        }
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : 'не удалось прочитать файл'}`);
      }
    }
    if (nextLayers.length) setExternalLayers((old) => [...old, ...nextLayers]);
    if (nextHoles.length) setExternalHoles((old) => [...old, ...nextHoles]);
    if (errors.length) setImportError(errors.join(' · '));
    if (nextLayers.length || nextHoles.length) setImportNote(`Добавлено: ${nextLayers.length} Gerber-слоёв, ${nextHoles.length} сверлений.${nextLayers.some((layer) => layer.data.truncated) ? ' Для плотного слоя достигнут безопасный лимит предпросмотра.' : ''}`);
  };
  const clearImported = (): void => { setExternalLayers([]); setExternalHoles([]); setImportError(''); setImportNote(''); };
  const on = (id: string): boolean => visible[id] ?? true;
  const bounds = useMemo(() => {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const layer of layers) if (on(layer.id)) {
      const q = layer.data.bounds;
      b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]);
    }
    for (const hole of drillsVisible ? holes : []) {
      b[0] = Math.min(b[0], hole.x - hole.diameter / 2); b[1] = Math.min(b[1], hole.y - hole.diameter / 2);
      b[2] = Math.max(b[2], hole.x + hole.diameter / 2); b[3] = Math.max(b[3], hole.y + hole.diameter / 2);
    }
    if (!Number.isFinite(b[0])) return [0, 0, Math.max(1, doc.w), Math.max(1, doc.h)] as [number, number, number, number];
    return b;
  }, [layers, holes, drillsVisible, visible, doc.w, doc.h]);
  const pad = Math.max(1, Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.04);
  const vb = `${fmt(bounds[0] - pad)} ${fmt(-bounds[3] - pad)} ${fmt(Math.max(1, bounds[2] - bounds[0] + 2 * pad))} ${fmt(Math.max(1, bounds[3] - bounds[1] + 2 * pad))}`;
  const background = '#121820';
  const visiblePrimitives = layers.filter((l) => on(l.id));
  const primitiveCount = visiblePrimitives.reduce((sum, layer) => sum + layer.data.primitives.length, 0);

  return <Modal title={`CAM · Gerber и сверловка · ${doc.name}`} className="gerber-preview-modal" onClose={onClose}
    foot={<><span className="cam-meta">{primitiveCount} операций · {drillsVisible ? holes.length : 0} отверстий · мм</span><button className="btn" onClick={onClose}>Закрыть</button></>}>
    <p>Предпросмотр разобран из экспортируемых или загруженных Gerber RS-274X и Excellon. Он помогает проверить слои и сверловку, но не заменяет CAM-проверку производителя.</p>
    <div className="cam-import-row">
      <label className="btn cam-import-file">Добавить Gerber / Excellon…
        <input type="file" multiple accept=".gbr,.ger,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gm1,.gko,.g1,.g2,.xln,.drl,.drd,.exc,.tap,.txt"
          onChange={(e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; void importFiles(files); }} />
      </label>
      {(externalLayers.length > 0 || externalHoles.length > 0) && <button className="btn" onClick={clearImported}>Убрать загруженные</button>}
      <span className="cam-meta">Можно выбрать несколько отдельных файлов; ZIP пока не поддерживается.</span>
    </div>
    {importNote && <div className="cloud-success" role="status">{importNote}</div>}
    {importError && <div className="cloud-error" role="alert">{importError}</div>}
    <div className="cam-layout">
      <aside className="cam-layers" aria-label="Видимость слоёв CAM">
        <h3>Слои</h3>
        {layers.map((layer) => <label key={layer.id} className="cam-layer-toggle">
          <input type="checkbox" checked={on(layer.id)} onChange={(e) => setVisible((p) => ({ ...p, [layer.id]: e.target.checked }))} />
          <i style={{ background: layer.color }} /><span title={layer.name}>{layer.name}</span><small title={layer.data.truncated ? 'Достигнут безопасный лимит геометрии' : undefined}>{layer.data.primitives.length}{layer.data.truncated ? '+' : ''}</small>
        </label>)}
        <label className="cam-layer-toggle"><input type="checkbox" checked={drillsVisible} onChange={(e) => setDrillsVisible(e.target.checked)} />
          <i className="cam-drill-swatch" /><span>Сверловка Excellon</span><small>{holes.length}</small></label>
        <div className="hint">Кликните слой, чтобы скрыть/показать его. Наведите на имя для полного имени файла.</div>
      </aside>
      <div className="cam-canvas-wrap">
        {primitiveCount === 0 && (!drillsVisible || !holes.length) ? <div className="empty-state">В экспорте пока нет объектов.</div> : <svg className="cam-canvas" viewBox={vb} role="img" aria-label="Предпросмотр Gerber-слоёв и сверловки">
          <rect x={bounds[0] - pad} y={-bounds[3] - pad} width={bounds[2] - bounds[0] + 2 * pad} height={bounds[3] - bounds[1] + 2 * pad} fill={background} />
          {visiblePrimitives.map((layer, li) => <g key={layer.id} style={{ color: layer.color }}>
            {layer.data.primitives.map((primitive, index) => <g key={index} fill={primitive.polarity === 'clear' ? background : layer.color}>
              {renderPrimitive(primitive, index + li * 1_000_000, background, layer.color)}
            </g>)}
          </g>)}
          {drillsVisible && <g fill="none" stroke="#f6f7fa" strokeWidth={Math.max(0.025, (bounds[2] - bounds[0]) / 900)}>
            {holes.map((hole, index) => <g key={index}><circle cx={hole.x} cy={-hole.y} r={hole.diameter / 2} />
              <path d={`M${fmt(hole.x - hole.diameter * 0.7)} ${fmt(-hole.y)}H${fmt(hole.x + hole.diameter * 0.7)}M${fmt(hole.x)} ${fmt(-hole.y - hole.diameter * 0.7)}V${fmt(-hole.y + hole.diameter * 0.7)}`} /></g>)}
          </g>}
        </svg>}
      </div>
    </div>
    <div className="hint">Файлы проекта: {source.map((f) => f.name).join(' · ')}{externalLayers.length || externalHoles.length ? ` · загружено: ${[...externalLayers.map((l) => l.name), `${externalHoles.length} внешних отверстий`].join(' · ')}` : ''}. Линия V-cut в отдельном guide-файле требует подтверждения параметров у изготовителя.</div>
  </Modal>;
}
