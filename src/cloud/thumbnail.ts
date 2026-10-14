// Превью платы для списка облачных проектов: вся плата целиком, как на 2D-предпросмотре.
// Рисуем тем же кодом, что и окно предпросмотра, но в закрытый canvas, без показа на экране.
import type { Doc } from '../pcb/model';
import { zOrdered } from '../pcb/render';
import { BOARD_2D_THEMES, drawBoard2D, previewBounds } from '../ui/board-preview-2d';

export const THUMB_WIDTH = 360;
export const THUMB_HEIGHT = 225;

/** JPEG data-URL с платой, вписанной в кадр с полями. Документ не меняется. */
export function renderBoardThumbnail(doc: Doc): string {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось создать превью: холст недоступен.');
  const flat = zOrdered(doc);
  const [x1, y1, x2, y2] = previewBounds(doc, flat);
  const pad = 14;
  const scale = Math.max(0.001, Math.min(
    (THUMB_WIDTH - pad * 2) / Math.max(x2 - x1, 0.1),
    (THUMB_HEIGHT - pad * 2) / Math.max(y2 - y1, 0.1),
  ));
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  // Зелёная плата с маской — самый узнаваемый вид; совпадает с первой темой предпросмотра.
  const theme = BOARD_2D_THEMES.find((t) => t.id === 'green') ?? BOARD_2D_THEMES[0];
  drawBoard2D(ctx, doc, flat, theme, {
    side: 'top', hidden: new Set(), showHoles: true, showMask: true, showGrid: false,
    scale, offsetX: THUMB_WIDTH / 2 - cx * scale, offsetY: THUMB_HEIGHT / 2 - (doc.h - cy) * scale,
    width: THUMB_WIDTH, height: THUMB_HEIGHT,
  });
  return canvas.toDataURL('image/jpeg', 0.85);
}
