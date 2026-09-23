import { useMemo, useState } from 'react';
import { boardInventory, type PadStock } from '../pcb/inventory';
import { fmt, type Doc } from '../pcb/model';
import { Modal } from './widgets';

const num = (n: number) => fmt(n).replace('.', ',');
const typeName = (p: PadStock) => p.kind === 'via' ? 'Переход' : p.kind === 'smd' ? 'SMD-площадка' : 'Пятачок';
const shapeName = (p: PadStock) => ({ round: 'Круглый', square: 'Квадратный', oct: 'Восьмиугольный', smd: 'Прямоугольный' })[p.shape];
const sizeName = (p: PadStock) => p.shape === 'round' || p.shape === 'oct' ? `Ø${num(p.w)}` : `${num(p.w)} × ${num(p.h)}`;

export function InventoryDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const data = useMemo(() => boardInventory(doc.entities), [doc.entities]);
  const [tab, setTab] = useState<'pads' | 'drills'>('pads');
  const t = data.totals;
  return <Modal title="Перечень площадок и отверстий" onClose={onClose} className="inventory-modal"
    foot={<button className="btn primary" autoFocus onClick={onClose}>Закрыть</button>}>
    <p className="inventory-board">{doc.name} · {num(doc.w)} × {num(doc.h)} мм</p>
    <div className="inventory-totals">
      <div><b>{t.pads}</b><span>пятачков</span></div>
      <div><b>{t.smd}</b><span>SMD-площадок</span></div>
      <div><b>{t.vias}</b><span>переходов</span></div>
      <div><b>{t.holes}</b><span>отверстий всего</span></div>
    </div>
    <div className="inventory-tabs" role="tablist" aria-label="Вид перечня">
      <button id="inventory-pads-tab" role="tab" aria-selected={tab === 'pads'} aria-controls="inventory-pads" className={'btn' + (tab === 'pads' ? ' primary' : '')} onClick={() => setTab('pads')}>Площадки по размерам</button>
      <button id="inventory-drills-tab" role="tab" aria-selected={tab === 'drills'} aria-controls="inventory-drills" className={'btn' + (tab === 'drills' ? ' primary' : '')} onClick={() => setTab('drills')}>Сверловка по диаметрам</button>
    </div>
    {tab === 'pads' ? <div role="tabpanel" id="inventory-pads" aria-labelledby="inventory-pads-tab">
      {data.pads.length ? <div className="inventory-table-wrap"><table className="inventory-table">
        <thead><tr><th scope="col">Тип / форма</th><th scope="col">Размер, мм</th><th scope="col">Кол-во, шт.</th></tr></thead>
        <tbody>{data.pads.map((p) => <tr key={p.key}>
          <th scope="row"><span className={'stock-shape ' + p.shape} aria-hidden="true" />{typeName(p)}<small>{shapeName(p)}</small>
            {p.drills.length > 0 && <small>Сверло: {p.drills.map((d) => `${d.diameter > 0 ? 'Ø' + num(d.diameter) + ' мм' : 'без отверстия'} — ${d.count} шт.`).join('; ')}</small>}
          </th>
          <td>{sizeName(p)}</td><td className="inventory-qty">{p.count}</td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row" colSpan={2}>Всего площадок, включая переходы</th><td className="inventory-qty">{t.pads + t.smd + t.vias}</td></tr></tfoot>
      </table></div> : <p className="inventory-empty">На плате пока нет площадок и переходов.</p>}
      <p>Одинаковые размеры и формы объединены. Разные свёрла указаны внутри строки; переходы и SMD считаются отдельно.</p>
    </div> : <div role="tabpanel" id="inventory-drills" aria-labelledby="inventory-drills-tab">
      {data.drills.length ? <div className="inventory-table-wrap"><table className="inventory-table">
        <thead><tr><th scope="col">Сверло, мм</th><th scope="col">В пятачках</th><th scope="col">В переходах</th><th scope="col">Монтажные</th><th scope="col">Всего, шт.</th></tr></thead>
        <tbody>{data.drills.map((d) => <tr key={d.diameter}><th scope="row">Ø{num(d.diameter)}</th><td>{d.pads || '—'}</td><td>{d.vias || '—'}</td><td>{d.mounting || '—'}</td><td className="inventory-qty">{d.count}</td></tr>)}</tbody>
        <tfoot><tr><th scope="row" colSpan={4}>Всего отверстий</th><td className="inventory-qty">{t.holes}</td></tr></tfoot>
      </table></div> : <p className="inventory-empty">На плате пока нет отверстий для сверления.</p>}
      <p>Включены отверстия в пятачках, переходах и монтажные отверстия без меди ({t.mounting} шт.). Площадки без сверления не учитываются.</p>
    </div>}
    <div className="hint">Вся плата, включая скрытые слои и выводы внутри компонентов и макросов. Двусторонний пятачок считается один раз. Совпадающие объекты не объединяются. Размеры округлены до 0,001 мм.</div>
  </Modal>;
}
