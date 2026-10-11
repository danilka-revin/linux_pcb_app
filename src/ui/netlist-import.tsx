// Импорт электрических цепей из KiCad .net.
import { useMemo, useState } from 'react';
import type { Doc } from '../pcb/model';
import { mergeImportedNets, mapKicadNetlist, parseKicadNetlist, type KicadNetlist, type KicadNetlistImport } from '../pcb/kicad-netlist';
import { Modal } from './widgets';

export function NetlistImportDialog({ doc, onApply, onClose }: {
  doc: Doc;
  onApply: (result: KicadNetlistImport) => void;
  onClose: () => void;
}) {
  const [netlist, setNetlist] = useState<KicadNetlist | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mapped = useMemo(() => netlist ? mapKicadNetlist(netlist, doc) : null, [netlist, doc]);
  const merge = mapped ? mergeImportedNets(doc.nets ?? [], mapped.nets) : null;
  const load = async (file?: File): Promise<void> => {
    if (!file) return;
    setBusy(true); setError(''); setNetlist(null); setFileName(file.name);
    try { setNetlist(parseKicadNetlist(await file.text())); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось разобрать netlist KiCad.'); }
    finally { setBusy(false); }
  };
  const apply = (): void => {
    if (!mapped || !merge || !mapped.nets.length) return;
    onApply({ ...mapped, nets: merge.nets,
      warnings: [...mapped.warnings, ...(merge.removedManual.length
        ? [`Заменены ручные группы, пересекавшиеся с импортированными цепями: ${merge.removedManual.join(', ')}.`] : [])],
    });
  };

  return <Modal title="Импорт netlist KiCad" className="netlist-modal" onClose={onClose}
    foot={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!mapped?.nets.length || busy} onClick={apply}>Импортировать цепи</button></>}>
    <p>Выберите netlist <code>.net</code>, экспортированный из KiCad. Обозначения компонентов и номера выводов должны совпадать с теми, что сохранены в футпринтах платы.</p>
    <label className="netlist-file btn">
      Выбрать netlist…
      <input type="file" accept=".net,text/plain" onChange={(e) => void load(e.target.files?.[0])} />
    </label>
    {fileName && <span className="netlist-filename">{fileName}</span>}
    {busy && <p role="status">Читаем файл…</p>}
    {error && <div className="cloud-error" role="alert">{error}</div>}
    {mapped && <>
      <div className="netlist-summary">
        <div><b>{netlist?.components.length ?? 0}</b><span>компонентов в файле</span></div>
        <div><b>{mapped.matchedComponents}</b><span>сопоставлено</span></div>
        <div><b>{mapped.nets.length}</b><span>цепей с 2+ выводами</span></div>
        <div><b>{mapped.matchedPads}</b><span>выводов сопоставлено</span></div>
      </div>
      {mapped.nets.length > 0 && <div className="netlist-preview"><h3>Предпросмотр цепей</h3>
        <ul>{mapped.nets.slice(0, 10).map((net) => <li key={net.id}><b>{net.name}</b><span>{net.pads.length} площадок</span></li>)}</ul>
        {mapped.nets.length > 10 && <small>…и ещё {mapped.nets.length - 10}</small>}
      </div>}
      {!!mapped.warnings.length && <div className="netlist-warnings" role="status"><b>Что требует внимания</b>
        <ul>{mapped.warnings.slice(0, 12).map((warning, i) => <li key={i}>{warning}</li>)}</ul>
        {mapped.warnings.length > 12 && <small>…и ещё предупреждения</small>}
      </div>}
      {!mapped.nets.length && <div className="route-msg bad">Подходящие цепи не найдены. Проверьте обозначения, номера выводов и импортированные footprint-данные.</div>}
    </>}
  </Modal>;
}
