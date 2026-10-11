// BOM и файлы для сборки компонентов.
import { useMemo, useState } from 'react';
import type { Doc } from '../pcb/model';
import { assemblySvg, bomCsv, buildBom, componentRows, metadataPatch, pickPlaceCsv, type ComponentRow } from '../pcb/component-data';
import { download } from '../pcb/zip';
import { Modal } from './widgets';

const cleanName = (s: string): string => s.replace(/[^\wа-яА-ЯёЁ-]+/g, '_') || 'board';

export function ManufacturingDialog({ doc, onApply, onClose }: {
  doc: Doc;
  /** Одна атомарная правка истории для всей таблицы компонентов. */
  onApply: (rows: ComponentRow[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState(() => componentRows(doc));
  const bom = useMemo(() => buildBom(rows), [rows]);
  const [saved, setSaved] = useState(false);
  const refProblems = useMemo(() => {
    const refs = new Map<string, number>();
    for (const row of rows) {
      const ref = row.ref.trim().toLocaleUpperCase();
      if (ref) refs.set(ref, (refs.get(ref) ?? 0) + 1);
    }
    return [...new Set(rows.filter((row) => !row.ref.trim() || (refs.get(row.ref.trim().toLocaleUpperCase()) ?? 0) > 1)
      .map((row) => row.ref.trim() || '(пусто)'))];
  }, [rows]);
  const validRefs = refProblems.length === 0;
  const edit = (id: string, key: keyof ComponentRow, value: string): void => {
    setSaved(false);
    setRows((prev) => prev.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };
  const apply = (): void => { if (!validRefs) return; onApply(rows); setSaved(true); };
  const exportBom = (): void => {
    if (!validRefs) return;
    apply();
    download(`${cleanName(doc.name)}_BOM.csv`, new Blob(['\ufeff', bomCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  };
  const exportPickPlace = (): void => {
    if (!validRefs) return;
    apply();
    download(`${cleanName(doc.name)}_pick-and-place.csv`, new Blob(['\ufeff', pickPlaceCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  };
  const exportAssembly = (side: 'top' | 'bottom'): void => {
    if (!validRefs) return;
    apply();
    download(`${cleanName(doc.name)}_assembly_${side}.svg`, new Blob([assemblySvg(doc, rows, side)], { type: 'image/svg+xml;charset=utf-8' }));
  };

  return <Modal title="Комплект для сборки · BOM" className="manufacturing-modal" onClose={onClose}
    foot={<><button className="btn" onClick={onClose}>Закрыть</button><button className="btn primary" disabled={!validRefs} onClick={apply}>Сохранить данные компонентов</button></>}>
    <p>Заполните обозначения и данные закупки. BOM группирует одинаковые компоненты; pick-and-place выдаёт центры деталей в мм, начало координат — левый нижний угол платы.</p>
    {!rows.length ? <div className="empty-state">На плате пока нет установленных компонентов.</div> : <>
      <div className="mfg-table-wrap"><table className="mfg-table">
        <thead><tr><th>Ref</th><th>Номинал</th><th>Корпус</th><th>Производитель</th><th>MPN / артикул</th><th>Datasheet</th><th>Сторона</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td><input className="txt" aria-label={`Обозначение ${row.ref}`} value={row.ref} maxLength={40} onChange={(e) => edit(row.id, 'ref', e.target.value.toUpperCase())} /></td>
          <td><input className="txt" aria-label={`Номинал ${row.ref}`} value={row.value} maxLength={120} onChange={(e) => edit(row.id, 'value', e.target.value)} /></td>
          <td><input className="txt" aria-label={`Корпус ${row.ref}`} value={row.footprint} maxLength={160} onChange={(e) => edit(row.id, 'footprint', e.target.value)} /></td>
          <td><input className="txt" aria-label={`Производитель ${row.ref}`} value={row.manufacturer} maxLength={120} onChange={(e) => edit(row.id, 'manufacturer', e.target.value)} /></td>
          <td><input className="txt" aria-label={`MPN ${row.ref}`} value={row.mpn} maxLength={120} onChange={(e) => edit(row.id, 'mpn', e.target.value)} /></td>
          <td><input className="txt" aria-label={`Datasheet ${row.ref}`} value={row.datasheet} maxLength={500} onChange={(e) => edit(row.id, 'datasheet', e.target.value)} /></td>
          <td>{row.side === 'top' ? 'Верх' : 'Низ'}</td>
        </tr>)}</tbody>
      </table></div>
      <h3 className="mfg-subhead">Сводная спецификация · {bom.length} позиций · {rows.length} деталей</h3>
      <div className="mfg-table-wrap"><table className="mfg-table mfg-bom">
        <thead><tr><th>Номинал</th><th>Корпус</th><th>Кол-во</th><th>Обозначения</th><th>MPN</th></tr></thead>
        <tbody>{bom.map((item, i) => <tr key={`${item.value}-${item.footprint}-${i}`}>
          <td>{item.value || '—'}</td><td>{item.footprint || '—'}</td><td>{item.quantity}</td>
          <td>{item.references.join(', ')}</td><td>{item.mpn || '—'}</td>
        </tr>)}</tbody>
      </table></div>
      {!validRefs && <div className="cloud-error" role="alert">Исправьте пустые или повторяющиеся обозначения компонентов: {refProblems.join(', ')}.</div>}
      <div className="mfg-actions">
        <button className="btn primary" disabled={!validRefs} onClick={exportBom}>Скачать BOM CSV</button>
        <button className="btn" disabled={!validRefs} onClick={exportPickPlace}>Pick-and-place CSV</button>
        <button className="btn" disabled={!validRefs} onClick={() => exportAssembly('top')}>Сборочный SVG · верх</button>
        <button className="btn" disabled={!validRefs} onClick={() => exportAssembly('bottom')}>Сборочный SVG · низ</button>
      </div>
      <p className="hint">SVG открывается в браузере, Inkscape и большинстве CAD-программ. Поворот в pick-and-place для нижней стороны зеркально преобразуется. Данные производителя и MPN не запрашиваются у поставщиков автоматически.</p>
      {saved && <div className="cloud-success" role="status">Данные компонентов сохранены в проекте.</div>}
    </>}
  </Modal>;
}
