// Предпросмотр документа: классический послойный вид и отдельный 3D-режим.
import { useState } from 'react';
import type { Doc } from '../pcb/model';
import { Modal } from './widgets';
import { BoardPreview2D } from './board-preview-2d';
import { BoardPreview3D } from './board-preview-3d';

export type PreviewTab = '2d' | '3d';

export function BoardPreviewDialog({ doc, initialTab = '2d', onClose }: {
  doc: Doc; initialTab?: PreviewTab; onClose: () => void;
}) {
  const [tab, setTab] = useState<PreviewTab>(initialTab);
  return <Modal title="Предпросмотр платы" className="board-preview-modal" onClose={onClose}
    foot={<><span className="muted">Только просмотр · Исходная плата не изменяется</span><button className="btn" onClick={onClose}>Закрыть</button></>}>
    <div className="preview-tabs">
      <div className="bp2d-segments" role="group" aria-label="Режим предпросмотра">
        <button className={'btn' + (tab === '2d' ? ' primary' : '')} aria-pressed={tab === '2d'} onClick={() => setTab('2d')}>2D · Sprint Layout</button>
        <button className={'btn' + (tab === '3d' ? ' primary' : '')} aria-pressed={tab === '3d'} onClick={() => setTab('3d')}>3D · Объёмный вид</button>
      </div>
      <span className="preview-document"><strong>{doc.name}</strong><span>{doc.w} × {doc.h} мм · {doc.entities.length} эл.</span></span>
    </div>
    {tab === '2d' ? <BoardPreview2D doc={doc} /> : <>
      <p className="hint">Вращение — ЛКМ, масштаб — колесо. Компоненты показаны условными корпусами.</p>
      <BoardPreview3D doc={doc} height={520} />
    </>}
  </Modal>;
}

export function BoardPreview2DDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  return <BoardPreviewDialog doc={doc} initialTab="2d" onClose={onClose} />;
}

export function BoardPreview3DDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  return <BoardPreviewDialog doc={doc} initialTab="3d" onClose={onClose} />;
}
