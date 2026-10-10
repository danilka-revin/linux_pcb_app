// Статистика платы: габарит, длина дорожек, площадь меди и процент заполнения,
// число отверстий и состав элементов.
import { useMemo } from 'react';
import { boardStats } from '../pcb/stats';
import { fmt, type Doc } from '../pcb/model';
import { Modal } from './widgets';
import { StatBar } from './progress';

const num = (n: number, d = 2): string => fmt(n, d).replace('.', ',');

export function StatsDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const st = useMemo(() => boardStats(doc), [doc]);
  return (
    <Modal
      title="Статистика платы"
      onClose={onClose}
      className="inventory-modal"
      foot={<button className="btn primary" autoFocus onClick={onClose}>Закрыть</button>}
    >
      <p className="inventory-board">{doc.name}</p>

      <div className="inventory-totals">
        <div><b>{num(st.width)} × {num(st.height)}</b><span>габарит, мм</span></div>
        <div><b>{num(st.trackLen, 1)}</b><span>дорожек всего, мм</span></div>
        <div><b>{num(st.copperArea, 1)}</b><span>меди, мм²</span></div>
        <div><b>{num(st.fillPct, 1)}%</b><span>заполнение</span></div>
      </div>

      <StatBar
        caption={<span className="muted">Заполнение медью: доля площади платы, занятой медью (оба слоя).</span>}
        segments={[
          {
            id: 'k1', label: 'медь K1',
            value: Math.round(st.k1.area * 10) / 10,
            tone: 'copper',
            hint: `верхний слой: ${num(st.k1.area, 1)} мм², дорожек ${st.k1.tracks} (длина ${num(st.k1.trackLen, 1)} мм)`,
          },
          {
            id: 'k2', label: 'медь K2',
            value: Math.round(st.k2.area * 10) / 10,
            tone: 'ok',
            hint: `нижний слой: ${num(st.k2.area, 1)} мм², дорожек ${st.k2.tracks} (длина ${num(st.k2.trackLen, 1)} мм)`,
          },
          {
            id: 'free', label: 'без меди',
            value: Math.max(0, Math.round((st.boardArea - st.copperArea) * 10) / 10),
            tone: 'muted',
            hint: `свободная площадь подложки: ${num(Math.max(0, st.boardArea - st.copperArea), 1)} мм²`,
          },
        ]}
      />

      <div className="inventory-table-wrap">
        <table className="inventory-table">
          <thead>
            <tr><th scope="col">Показатель</th><th scope="col">K1 (верх)</th><th scope="col">K2 (низ)</th><th scope="col">Всего</th></tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Длина дорожек, мм</th>
              <td>{num(st.k1.trackLen, 1)}</td><td>{num(st.k2.trackLen, 1)}</td>
              <td className="inventory-qty"><b>{num(st.trackLen, 1)}</b></td>
            </tr>
            <tr>
              <th scope="row">Площадь меди, мм²{st.k1.approx || st.k2.approx ? ' *' : ''}</th>
              <td>{num(st.k1.area, 1)}</td><td>{num(st.k2.area, 1)}</td>
              <td className="inventory-qty"><b>{num(st.copperArea, 1)}</b></td>
            </tr>
            <tr>
              <th scope="row">Дорожек, шт.</th>
              <td>{st.k1.tracks}</td><td>{st.k2.tracks}</td>
              <td className="inventory-qty"><b>{st.k1.tracks + st.k2.tracks}</b></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="inventory-totals">
        <div><b>{st.pads}</b><span>пятачков</span></div>
        <div><b>{st.smd}</b><span>SMD</span></div>
        <div><b>{st.vias}</b><span>переходов</span></div>
        <div><b>{st.holes}</b><span>отверстий</span></div>
      </div>
      <div className="inventory-totals">
        <div><b>{st.comps}</b><span>компонентов</span></div>
        <div><b>{st.texts}</b><span>текстов</span></div>
        <div><b>{st.dims}</b><span>размеров</span></div>
        <div><b>{st.polys}</b><span>полигонов</span></div>
      </div>

      <div className="hint">
        Габарит — по замкнутому контуру платы (иначе рабочее поле {num(doc.w)} × {num(doc.h)} мм);
        площадь подложки {num(st.boardArea, 1)} мм² с вычетом вырезов.
        Длиннейшая дорожка: {num(st.longestTrack, 1)} мм.
        {(st.k1.approx || st.k2.approx) && ' * Площадь меди посчитана приблизительно — плата слишком сложная для точного объединения.'}
        {' '}Перечень размеров площадок и свёрл — «Перечень площадок и отверстий».
      </div>
    </Modal>
  );
}
