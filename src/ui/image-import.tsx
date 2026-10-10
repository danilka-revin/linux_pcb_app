// Импорт изображения (логотипа/картинки) на шелкографию: картинка векторизуется
// в залитые полигоны (с дырками) и ставится на плату как буфер вставки.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { facesToPolys, traceImage, type BitmapImage, type TraceResult } from '../pcb/imagetrace';
import { uid, type Poly, type Pt } from '../pcb/model';
import { Modal } from './widgets';

const MAX_LOAD = 1024; // сторона загружаемой сетки, больше не нужно — трассер уменьшит сам

interface Loaded {
  bitmap: BitmapImage;
  name: string;
}

function loadImageFile(file: File): Promise<Loaded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const done = (cv: HTMLCanvasElement) => {
      URL.revokeObjectURL(url);
      const ctx = cv.getContext('2d');
      if (!ctx) { reject(new Error('canvas недоступен')); return; }
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      resolve({ bitmap: { width: data.width, height: data.height, data: data.data }, name: file.name });
    };
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_LOAD / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * k));
      cv.height = Math.max(1, Math.round(img.height * k));
      const ctx = cv.getContext('2d');
      if (!ctx) { reject(new Error('canvas недоступен')); return; }
      // белый фон: прозрачные области логотипа не должны стать «краской»
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      done(cv);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не удалось прочитать изображение')); };
    img.src = url;
  });
}

/** Предпросмотр векторного результата: лица с дырками заливаются чет-нечет. */
function drawPreview(cv: HTMLCanvasElement, res: TraceResult | null): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!res || !res.faces.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const f of res.faces) {
    for (const p of f.outer) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    }
  }
  const w = Math.max(x2 - x1, 0.01), h = Math.max(y2 - y1, 0.01);
  const k = Math.min((cv.width - 16) / w, (cv.height - 16) / h);
  const ox = (cv.width - w * k) / 2, oy = (cv.height - h * k) / 2;
  const X = (x: number) => ox + (x - x1) * k;
  const Y = (y: number) => oy + (y2 - y) * k; // Y вверх → экран вниз
  for (const f of res.faces) {
    ctx.beginPath();
    const ring = (pts: Pt[]) => {
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.closePath();
    };
    ring(f.outer);
    for (const hole of f.holes) ring(hole);
    ctx.fillStyle = '#e5484d';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#e5484d';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function ImageImportDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  /** вставить готовые полигоны (после клика — как буфер вставки) */
  onInsert: (ents: Poly[]) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState(128);
  const [invert, setInvert] = useState(false);
  const [widthMm, setWidthMm] = useState(20);
  const [simplifyMm, setSimplifyMm] = useState(0.04);
  const [minAreaMm2, setMinAreaMm2] = useState(0.02);
  const [layer, setLayer] = useState<'s1' | 's2'>('s1');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);

  const res = useMemo<TraceResult | null>(() => {
    if (!loaded) return null;
    try {
      return traceImage(loaded.bitmap, { threshold, invert, widthMm, simplifyMm, minAreaMm2 });
    } catch {
      return null;
    }
  }, [loaded, threshold, invert, widthMm, simplifyMm, minAreaMm2]);

  useEffect(() => {
    if (cvRef.current) drawPreview(cvRef.current, res);
  }, [res]);

  const pick = useCallback((f: File | null | undefined) => {
    if (!f) return;
    setBusy(true);
    setError('');
    loadImageFile(f)
      .then((l) => setLoaded(l))
      .catch((e: Error) => setError(e.message || 'Не удалось прочитать изображение.'))
      .finally(() => setBusy(false));
  }, []);

  const insert = useCallback(() => {
    if (!res || !res.faces.length) return;
    const polys = facesToPolys(res.faces, layer, uid);
    onInsert(polys);
  }, [res, layer, onInsert]);

  return (
    <Modal
      title="Изображение → шелкография"
      onClose={onClose}
      className="imgimport-modal"
      foot={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={!res?.faces.length} onClick={insert}>
            Вставить на плату ({res?.faces.length ?? 0} {res?.faces.length === 1 ? 'фигура' : 'фигур'})
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Выберите картинку — логотип, знак, пиктограмму. Она станет векторным рисунком
        на шелкографии: залитые фигуры с дырками (буквы О, А). Используйте изображение,
        на которое у вас есть права; высокий контраст и простые формы дают лучший результат.
      </p>

      <div className="row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
        />
        <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Читаю…' : 'Выбрать изображение…'}
        </button>
        {loaded && <span className="sub">{loaded.name} · {loaded.bitmap.width}×{loaded.bitmap.height} px</span>}
      </div>
      {error && <div className="route-msg bad">{error}</div>}

      <div className="row" style={{ alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
        <canvas
          ref={cvRef}
          width={320}
          height={220}
          style={{ background: '#14181f', borderRadius: 6, border: '1px solid #2a313b', flex: '0 0 auto' }}
        />
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="chk">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            Светлый рисунок на тёмном фоне (инверсия)
          </label>
          <div className="sub">Порог яркости: {threshold}</div>
          <input
            type="range" min={1} max={255} value={threshold}
            style={{ width: '100%' }}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <div className="sub">Ширина рисунка, мм: {String(widthMm).replace('.', ',')}</div>
          <input
            type="range" min={2} max={120} step={1} value={widthMm}
            style={{ width: '100%' }}
            onChange={(e) => setWidthMm(Number(e.target.value))}
          />
          <div className="sub">Детализация контура, мм: {String(simplifyMm).replace('.', ',')}</div>
          <input
            type="range" min={0.01} max={0.3} step={0.01} value={simplifyMm}
            style={{ width: '100%' }}
            onChange={(e) => setSimplifyMm(Number(e.target.value))}
          />
          <div className="sub">Минимальный размер пятна, мм²: {String(minAreaMm2).replace('.', ',')}</div>
          <input
            type="range" min={0.005} max={1} step={0.005} value={minAreaMm2}
            style={{ width: '100%' }}
            onChange={(e) => setMinAreaMm2(Number(e.target.value))}
          />
          <div className="sub">Слой</div>
          <div className="row">
            <button className={'btn' + (layer === 's1' ? ' primary' : '')} onClick={() => setLayer('s1')}>Ш1 (верх)</button>
            <button className={'btn' + (layer === 's2' ? ' primary' : '')} onClick={() => setLayer('s2')}>Ш2 (низ)</button>
          </div>
        </div>
      </div>

      <div className="hint">
        {res
          ? `Готово: ${res.faces.length} фигур, ${res.pxWidth}×${res.pxHeight} px сетки, высота ${res.heightMm.toFixed(1).replace('.', ',')} мм${res.dropped ? `, отброшено мелких: ${res.dropped}` : ''}.`
          : loaded ? 'Не удалось построить контуры — попробуйте другой порог.' : 'Изображение не выбрано.'}
        {' '}«Вставить» кладёт рисунок в буфер: кликните по плате, чтобы поставить
        (R — повернуть, Esc — отмена). Дальше рисунок — обычные полигоны: их двигают,
        масштабируют составом и правят в свойствах. Если часть мелких деталей пропала —
        уменьшите «минимальный размер пятна» и «детализацию».
      </div>
    </Modal>
  );
}
