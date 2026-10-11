// Рендер и hit-test заметок ревью на холсте редактора.
// Они намеренно отделены от Entity: комментарии не влияют на DRC и производство.
import { uid, type BoardComment, type Pt } from './model';
import type { View } from './render';

export interface BoardCommentLayout {
  anchorX: number;
  anchorY: number;
  pinX: number;
  pinY: number;
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  lines: string[];
}

/** Проверка/миграция заметок из JSON проекта старой или повреждённой схемы. */
export function normalizeBoardComments(raw: unknown): BoardComment[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const comments: BoardComment[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<BoardComment>;
    if (typeof item.x !== 'number' || !Number.isFinite(item.x)
      || typeof item.y !== 'number' || !Number.isFinite(item.y)
      || typeof item.text !== 'string') continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    comments.push({ id, x: item.x, y: item.y, text: item.text.slice(0, 2000), resolved: !!item.resolved });
  }
  return comments;
}

const CARD_W = 196;
const CARD_GAP = 11;
const CARD_PAD_X = 9;
const CARD_TOP = 26;
const LINE_H = 15;
const MAX_LINES = 5;
const PIN_R = 8;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const source = (text || 'Пустая заметка').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  const addWord = (word: string): void => {
    let rest = word;
    while (rest && ctx.measureText(rest).width > maxWidth) {
      let cut = 1;
      while (cut < rest.length && ctx.measureText(rest.slice(0, cut + 1)).width <= maxWidth) cut++;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
  };

  for (const raw of source) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = '';
      }
      if (!line && ctx.measureText(word).width > maxWidth) addWord(word);
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }

  if (out.length <= MAX_LINES) return out;
  const clipped = out.slice(0, MAX_LINES);
  let last = clipped[MAX_LINES - 1];
  while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  clipped[MAX_LINES - 1] = `${last}…`;
  return clipped;
}

/** Геометрия заметки в экранных пикселях; карточка остаётся читаемой при любом zoom. */
export function boardCommentLayout(
  ctx: CanvasRenderingContext2D,
  view: View,
  comment: BoardComment,
  width: number,
  height: number,
): BoardCommentLayout {
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  const lines = wrapText(ctx, comment.text, CARD_W - CARD_PAD_X * 2);
  ctx.restore();
  const cardH = CARD_TOP + Math.max(1, lines.length) * LINE_H + 8;
  const anchorX = view.ox + comment.x * view.s * (view.mir ? -1 : 1);
  const anchorY = view.oy - comment.y * view.s;
  const right = anchorX + CARD_GAP + CARD_W <= width - 4;
  const rawX = right ? anchorX + CARD_GAP : anchorX - CARD_GAP - CARD_W;
  const cardX = Math.max(4, Math.min(width - CARD_W - 4, rawX));
  const rawY = anchorY - cardH / 2;
  const cardY = Math.max(4, Math.min(height - cardH - 4, rawY));
  const pinX = anchorX;
  const pinY = anchorY;
  return { anchorX, anchorY, pinX, pinY, cardX, cardY, cardW: CARD_W, cardH, lines };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Рисует метку и всплывающую карточку ревью поверх платы. */
export function drawBoardComment(
  ctx: CanvasRenderingContext2D,
  view: View,
  comment: BoardComment,
  size: { w: number; h: number },
  selected = false,
): BoardCommentLayout {
  const layout = boardCommentLayout(ctx, view, comment, size.w, size.h);
  const resolved = !!comment.resolved;
  const fill = resolved ? '#e8f1e9' : '#fff3c8';
  const ink = resolved ? '#294334' : '#47370c';
  const border = resolved ? '#78947d' : '#c29223';
  const centerY = layout.cardY + layout.cardH / 2;
  const cardEdge = layout.cardX > layout.anchorX
    ? layout.cardX
    : layout.cardX + layout.cardW;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = border;
  ctx.globalAlpha = 0.86;
  ctx.beginPath();
  ctx.moveTo(layout.anchorX, layout.anchorY);
  ctx.lineTo(cardEdge, centerY);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.shadowColor = 'rgba(0,0,0,.32)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetY = 2;
  roundedRect(ctx, layout.cardX, layout.cardY, layout.cardW, layout.cardH, 7);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = selected ? 2.2 : 1;
  ctx.strokeStyle = selected ? '#f0a22e' : border;
  ctx.stroke();

  ctx.fillStyle = border;
  ctx.font = '700 9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(resolved ? 'РЕШЕНО' : 'РЕВЬЮ · ПЕРЕРИСОВАТЬ', layout.cardX + CARD_PAD_X, layout.cardY + 7);
  ctx.fillStyle = ink;
  ctx.font = '12px system-ui, sans-serif';
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, layout.cardX + CARD_PAD_X, layout.cardY + CARD_TOP + i * LINE_H);
  });

  ctx.shadowColor = 'rgba(0,0,0,.3)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(layout.pinX, layout.pinY, PIN_R, 0, Math.PI * 2);
  ctx.fillStyle = border;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = selected ? '#fff' : fill;
  ctx.lineWidth = selected ? 2.2 : 1.4;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(resolved ? '✓' : '!', layout.pinX, layout.pinY + 0.5);
  ctx.restore();
  return layout;
}

/** Возвращает верхнюю заметку под экранным курсором (маркер или карточка). */
export function hitBoardComment(
  ctx: CanvasRenderingContext2D,
  view: View,
  comments: BoardComment[],
  px: number,
  py: number,
  width: number,
  height: number,
): BoardComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const b = boardCommentLayout(ctx, view, comment, width, height);
    const dx = px - b.pinX, dy = py - b.pinY;
    if (dx * dx + dy * dy <= (PIN_R + 4) ** 2
      || (px >= b.cardX - 2 && px <= b.cardX + b.cardW + 2
        && py >= b.cardY - 2 && py <= b.cardY + b.cardH + 2)) return comment;
  }
  return null;
}

/** Для тестов и кода перехода к заметке: координата её якоря в мире платы. */
export function boardCommentPoint(comment: Pick<BoardComment, 'x' | 'y'>): Pt {
  return { x: comment.x, y: comment.y };
}
