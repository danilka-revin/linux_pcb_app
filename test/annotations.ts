import assert from 'node:assert/strict';
import type { BoardComment } from '../src/pcb/model';
import { lockedByLayer } from '../src/pcb/locking';
import { boardCommentLayout, drawBoardComment, hitBoardComment, normalizeBoardComments } from '../src/pcb/board-comments';
import type { View } from '../src/pcb/render';

const ctx = new Proxy({} as Record<string, unknown>, {
  get: (_target, property: string) => property === 'measureText'
    ? (text: string) => ({ width: [...text].length * 6 })
    : () => undefined,
  set: () => true,
}) as unknown as CanvasRenderingContext2D;

const view: View = { s: 10, ox: 100, oy: 200, mir: false };
const comment: BoardComment = {
  id: 'review-1', x: 5, y: 5,
  text: 'Перерисовать дорожку: здесь слишком узкий зазор до площадки.',
};
const layout = boardCommentLayout(ctx, view, comment, 640, 480);
assert.equal(layout.anchorX, 150);
assert.equal(layout.anchorY, 150);
assert.ok(layout.lines.length > 1, 'заметка разбита на читаемые строки');
assert.ok(layout.cardX > layout.anchorX, 'карточка размещается справа от метки');
assert.equal(hitBoardComment(ctx, view, [comment], layout.anchorX, layout.anchorY, 640, 480)?.id, comment.id,
  'маркер выбирается мышью');
assert.equal(hitBoardComment(ctx, view, [comment], layout.cardX + 12, layout.cardY + 12, 640, 480)?.id, comment.id,
  'карточка заметки тоже интерактивна');
assert.equal(hitBoardComment(ctx, view, [comment], 630, 470, 640, 480), null, 'пустое место не выбирает метку');
const mirrored = boardCommentLayout(ctx, { ...view, mir: true }, comment, 640, 480);
assert.equal(mirrored.anchorX, 50, 'якорь учитывает зеркальный вид снизу');
drawBoardComment(ctx, view, comment, { w: 640, h: 480 }, true);
drawBoardComment(ctx, view, { ...comment, resolved: true }, { w: 640, h: 480 });

const normalized = normalizeBoardComments([
  comment,
  { ...comment, text: 'Дубликат id' },
  { id: 'bad', x: Number.NaN, y: 2, text: 'битая координата' },
  { id: 'bad-text', x: 0, y: 0, text: 7 },
]);
assert.equal(normalized.length, 2, 'невалидные заметки отбрасываются');
assert.notEqual(normalized[0].id, normalized[1].id, 'id заметок уникальны');
assert.equal(normalizeBoardComments(undefined).length, 0, 'старые проекты без комментариев поддерживаются');

const track = { id: 't', kind: 'track', pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }], w: 0.5, layer: 'k1' } as const;
assert.equal(lockedByLayer(track, new Set(['k1'])), true);
assert.equal(lockedByLayer(track, new Set(['k2'])), false);
const pad = { id: 'p', kind: 'pad', x: 0, y: 0, shape: 'round', size: 2, drill: 1 } as const;
assert.equal(lockedByLayer(pad, new Set(['k2'])), true, 'сквозная площадка блокируется замком любой стороны меди');
const comp = {
  id: 'c', kind: 'comp', lib: '', name: 'J1', x: 0, y: 0, rot: 0, side: 'top', bl: [-2, -2, 2, 2],
  ents: [{ id: 'inside', kind: 'line', x1: 0, y1: 0, x2: 1, y2: 0, w: 0.2, layer: 's1' }],
} as const;
assert.equal(lockedByLayer(comp, new Set(['s1'])), true, 'компонент блокируется целиком, если в слое есть его примитив');

process.stdout.write('ANNOTATIONS OK: review-note layout/hit-test/persistence and object/layer lock rules\n');
