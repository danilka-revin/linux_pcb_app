// Панель ревью и редактор заметки, привязанной к координате платы.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, type BoardComment } from '../pcb/model';
import { Ic } from './icons';

export interface CommentDraft {
  id: string | null;
  x: number;
  y: number;
  text: string;
}

const singleLine = (text: string, limit = 74): string => {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

export function CommentsPanel({
  comments, activeId, onAdd, onPick, onEdit, onDelete, onToggleResolved,
}: {
  comments: BoardComment[];
  activeId: string | null;
  onAdd: () => void;
  onPick: (comment: BoardComment) => void;
  onEdit: (comment: BoardComment) => void;
  onDelete: (comment: BoardComment) => void;
  onToggleResolved: (comment: BoardComment) => void;
}) {
  const openCount = comments.filter((comment) => !comment.resolved).length;
  const rows = useMemo(() => [...comments].sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved)), [comments]);

  return (
    <div className="comments-pane">
      <h3>Комментарии ревью</h3>
      <div className="review-tools">
        <button type="button" className="btn primary" onClick={onAdd}>
          <Ic n="comment" size={15} /> Поставить метку
        </button>
      </div>
      <div className="review-summary" role="status">
        {comments.length
          ? `Всего: ${comments.length} · требуют правки: ${openCount}`
          : 'На плате пока нет заметок.'}
      </div>
      <div className="review-list" role="list" aria-label="Комментарии на плате">
        {rows.map((comment, index) => (
          <div key={comment.id} className={'review-item' + (activeId === comment.id ? ' active' : '')
            + (comment.resolved ? ' resolved' : '')} role="listitem">
            <button type="button" className="review-main" onClick={() => onPick(comment)}
              title={`Перейти к X ${fmt(comment.x)}; Y ${fmt(comment.y)} мм`}>
              <span className="review-pin">{comment.resolved ? <Ic n="check" size={13} /> : '!'}</span>
              <span className="review-copy">
                <b>{comment.resolved ? 'Готово' : 'Нужно перерисовать'} · {index + 1}</b>
                <span>{singleLine(comment.text) || 'Пустая заметка'}</span>
                <small>X {fmt(comment.x)} · Y {fmt(comment.y)} мм</small>
              </span>
            </button>
            <div className="review-actions">
              <button type="button" className="eye review-action" onClick={() => onToggleResolved(comment)}
                title={comment.resolved ? 'Вернуть в открытые' : 'Отметить выполненным'}
                aria-label={comment.resolved ? 'Вернуть комментарий в открытые' : 'Отметить комментарий выполненным'}>
                <Ic n={comment.resolved ? 'undo' : 'check'} size={14} />
              </button>
              <button type="button" className="eye review-action" onClick={() => onEdit(comment)}
                title="Изменить заметку" aria-label="Изменить заметку">
                <Ic n="edit" size={14} />
              </button>
              <button type="button" className="eye review-action danger" onClick={() => onDelete(comment)}
                title="Удалить заметку" aria-label="Удалить заметку">
                <Ic n="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="hint review-hint">
        Метки видны прямо на холсте. В инструменте «Выбор» перетащите значок, чтобы переместить заметку; щёлкните по карточке, чтобы изменить текст.
        Комментарии сохраняются в проекте JSON и облаке, но не входят в Gerber, ЧПУ и .lay6.
      </div>
    </div>
  );
}

export function CommentEditorDialog({
  draft, onSave, onDelete, onClose,
}: {
  draft: CommentDraft;
  onSave: (text: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(draft.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText(draft.text);
    area.current?.focus();
  }, [draft]);
  const save = (): void => {
    const clean = text.trim();
    if (clean) onSave(clean);
  };

  return (
    <div className="modal-bg comment-modal" role="dialog" aria-modal="true" aria-labelledby="comment-title"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal comment-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <h2 id="comment-title">{draft.id ? 'Комментарий ревью' : 'Новая заметка на плате'}</h2>
        <p>Опишите, что проверить или перерисовать. Текст появится карточкой у метки на плате.</p>
        <label className="comment-editor-label" htmlFor="review-comment-text">Заметка</label>
        <textarea
          ref={area}
          id="review-comment-text"
          className="txt comment-editor-text"
          rows={5}
          maxLength={2000}
          value={text}
          placeholder="Например: перерисовать дорожку — здесь слишком узкий зазор"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          }}
        />
        <div className="comment-coordinates">Метка: X {fmt(draft.x)} · Y {fmt(draft.y)} мм</div>
        <div className="foot">
          {onDelete && <button type="button" className="btn danger" onClick={onDelete}>Удалить</button>}
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            {draft.id ? 'Сохранить' : 'Добавить комментарий'}
          </button>
        </div>
      </form>
    </div>
  );
}
