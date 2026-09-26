// Объединённый диалог предпросмотра платы: 2D в разных цветах и 3D на сайте.
import { useState } from 'react';
import type { Doc } from '../pcb/model';
import { Modal } from './widgets';
import { BoardPreview2D } from './board-preview-2d';
import { BoardPreview3D } from './board-preview-3d';

export type PreviewTab = '2d' | '3d';

export function BoardPreviewDialog({
  doc,
  initialTab = '2d',
  onClose,
}: {
  doc: Doc;
  initialTab?: PreviewTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PreviewTab>(initialTab);

  return (
    <Modal title="Предпросмотр платы — 2D и 3D" className="board-preview-modal" onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Закрыть</button>
        <button className="btn" onClick={() => {
          // Открыть 2D в отдельном окне как PNG? Просто подсказка
          const a = document.createElement('a');
          a.href = '#';
          a.textContent = '';
        }}>Подсказка: колесо — масштаб, перетаскивание — панорама</button>
      </>}>
      <div className="preview-tabs">
        <button className={'btn' + (tab === '2d' ? ' primary' : '')} onClick={() => setTab('2d')}>2D — цвета и слои</button>
        <button className={'btn' + (tab === '3d' ? ' primary' : '')} onClick={() => setTab('3d')}>3D — объёмная плата</button>
        <span style={{ flex: 1 }} />
        <span className="muted">Плата «{doc.name}» {doc.w}×{doc.h} мм, элементов: {doc.entities.length}</span>
      </div>

      {tab === '2d' ? (
        <>
          <p className="hint">2D предпросмотр в разных цветах: реалистичные темы маски (зелёная, синяя, красная, чёрная, белая), классика редактора, монохром для печати. Переключайте слои, маску, шелкографию. Колесо — масштаб, ЛКМ — панорама.</p>
          <BoardPreview2D doc={doc} width={780} height={520} />
        </>
      ) : (
        <>
          <p className="hint">3D предпросмотр прямо на сайте: плата с толщиной, медью и деталями. Вращайте, приближайте. Темы маски синхронизированы с 2D. Детали — упрощённые боксы. Работает на WebGL (Three.js).</p>
          <BoardPreview3D doc={doc} width={780} height={520} />
        </>
      )}

      <div className="preview-info">
        <h4>Что показывает предпросмотр:</h4>
        <ul>
          <li><b>2D:</b> реалистичные цвета платы (зелёный, синий, красный, чёрный, белый, фиолетовый, жёлтый), медь (золото), маска с прозрачностью, шелкография, контур, отверстия. Вид сверху/снизу/обе стороны.</li>
          <li><b>3D:</b> объёмная плата с толщиной 0.8–3.0 мм, текстуры меди и шелкографии, компоненты как боксы, тени, сетка, OrbitControls (вращение/панорама/масштаб).</li>
          <li>Оба режима не блокируют работу — можно держать открытыми и сразу править плату.</li>
        </ul>
      </div>
    </Modal>
  );
}

// Отдельные диалоги для быстрого открытия из тулбара
export function BoardPreview2DDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  return (
    <Modal title="2D предпросмотр — цвета платы" className="board-preview-modal" onClose={onClose}
      foot={<button className="btn" onClick={onClose}>Закрыть</button>}>
      <BoardPreview2D doc={doc} width={780} height={520} />
    </Modal>
  );
}

export function BoardPreview3DDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  return (
    <Modal title="3D предпросмотр — объёмная плата" className="board-preview-modal" onClose={onClose}
      foot={<button className="btn" onClick={onClose}>Закрыть</button>}>
      <BoardPreview3D doc={doc} width={780} height={520} />
    </Modal>
  );
}
