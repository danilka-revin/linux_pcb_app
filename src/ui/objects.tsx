// Панель объектов (левая колонка, вкладка «Объекты»): дерево всего, что лежит
// на плате, — как список слоёв, только до каждого объекта.
//
// Что умеет строка:
//   • клик — выделить объект (или всю группу/раздел) и перевести к нему вид;
//   • «глаз» — скрыть объект с холста (у раздела и типа — всех внутри);
//   • «замок» — заблокировать: объект видно, но его нельзя выбрать и сдвинуть.
//
// Поиск ищет по подписи, типу, координатам и надписям: «R1», «дорожка», «12,5».
// Найденные строки раскрываются сами — до конкретного объекта.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { LAYERS, type Doc, type LayerId } from '../pcb/model';
import {
  buildObjectTree, countNodes, filterObjectTree, flagState,
  type ObjNode, type ObjTone,
} from '../pcb/objtree';
import { Ic } from './icons';

const toneColor = (t: ObjTone): string => {
  if (t === 'both') return '#f0a63c';
  if (t === 'comp') return 'var(--accent)';
  return LAYERS.find((l) => l.id === t)?.color ?? 'var(--muted)';
};

/** Строка дерева с отступом по уровню вложенности. */
interface FlatRow {
  node: ObjNode;
  depth: number;
  /** есть ли у строки дети (для стрелки раскрытия) */
  hasKids: boolean;
  /** раскрыта ли строка */
  open: boolean;
}

export function ObjectPanel({
  doc, sel, hiddenEnts, lockedEnts, hiddenLayers,
  onPick, onToggleHidden, onToggleLocked, onShowAll, onUnlockAll, onFocusSearch,
}: {
  doc: Doc;
  /** текущее выделение — строка подсвечивается */
  sel: Set<string>;
  /** объекты, скрытые с холста */
  hiddenEnts: Set<string>;
  /** заблокированные объекты: не выбираются мышью */
  lockedEnts: Set<string>;
  /** скрытые слои (для кнопки «Показать всё» и подсказки) */
  hiddenLayers: Set<LayerId>;
  onPick: (node: ObjNode) => void;
  onToggleHidden: (ids: string[], hide: boolean) => void;
  onToggleLocked: (ids: string[], lock: boolean) => void;
  onShowAll: () => void;
  onUnlockAll: () => void;
  /** меняется при вызове из горячей клавиши — вернуть фокус в строку поиска */
  onFocusSearch?: number;
}) {
  const [query, setQuery] = useState('');
  // закрытые пользователем строки (по умолчанию дерево раскрыто целиком)
  const [open, setOpen] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onFocusSearch === undefined) return;
    input.current?.focus();
    input.current?.select();
  }, [onFocusSearch]);

  const full = useMemo(() => buildObjectTree(doc), [doc]);
  const tree = useMemo(() => filterObjectTree(full, query), [full, query]);
  const searching = !!query.trim();

  // Дерево раскрыто целиком (это список всего на плате), а закрытые строки
  // помним отдельно: при поиске показываем найденное раскрытым до объекта.
  const isOpen = (node: ObjNode): boolean => {
    if (searching) return true;
    return !open.has('closed:' + node.id);
  };
  const toggle = (node: ObjNode): void => {
    if (!node.children?.length) return;
    setOpen((prev) => {
      const n = new Set(prev);
      const key = 'closed:' + node.id;
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const rows = useMemo((): FlatRow[] => {
    const out: FlatRow[] = [];
    const walk = (list: ObjNode[], depth: number): void => {
      for (const node of list) {
        const kids = node.children ?? [];
        const hasKids = kids.length > 0;
        const opened = isOpen(node);
        out.push({ node, depth, hasKids, open: opened });
        if (hasKids && opened) walk(kids, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
    // isOpen зависит от sel/searching/open — перечисляем явно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, sel, searching, open]);

  const total = countNodes(tree);
  const hiddenCount = hiddenEnts.size;
  const lockedCount = lockedEnts.size;

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, row: FlatRow): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(row.node);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.hasKids && ((e.key === 'ArrowRight') !== row.open)) toggle(row.node);
    }
  };

  const status = searching
    ? (total ? `Найдено объектов: ${total}` : 'Ничего не найдено — проверьте написание или введите тип: «дорожка», «текст».')
    : (doc.entities.length
      ? `Объектов: ${doc.entities.length}${hiddenCount ? ` · скрыто ${hiddenCount}` : ''}${lockedCount ? ` · заблокировано ${lockedCount}` : ''}`
      : 'Плата пуста — поставьте первый объект инструментом слева.');

  return (
    <div className="objects-pane">
      <h3>Объекты</h3>
      <div className="obj-search">
        <Ic n="search" size={15} />
        <input
          ref={input}
          className="txt"
          value={query}
          placeholder="Найти объект: R1, дорожка, текст…"
          aria-label="Поиск объекта на плате"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // клавиши в поле не уходят редактору (иначе Del/R удалят плату)
            e.stopPropagation();
            if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); }
          }}
          onKeyUp={(e) => e.stopPropagation()}
        />
        {query && (
          <button type="button" className="obj-clear" title="Очистить поиск (Esc)" aria-label="Очистить поиск"
            onClick={() => { setQuery(''); input.current?.focus(); }}>
            ×
          </button>
        )}
      </div>

      <div className="obj-tools">
        <button
          type="button" className="btn tiny"
          title="Показать все скрытые объекты и слои"
          disabled={!hiddenCount && !hiddenLayers.size}
          onClick={onShowAll}
        >
          <Ic n="eye" size={14} /> Показать всё
        </button>
        <button
          type="button" className="btn tiny"
          title="Снять замок со всех объектов — они снова выбираются мышью"
          disabled={!lockedCount}
          onClick={onUnlockAll}
        >
          <Ic n="unlock" size={14} /> Разблокировать
        </button>
      </div>

      <div className="obj-status" role="status">{status}</div>

      <div className="obj-tree" role="tree" aria-label="Дерево объектов платы">
        {rows.map((row) => {
          const { node, depth } = row;
          const hideState = flagState(node.ids, hiddenEnts);
          const lockState = flagState(node.ids, lockedEnts);
          const selected = node.ids.some((id) => sel.has(id));
          const title = node.detail ? `${node.label} — ${node.detail}` : node.label;
          return (
            <div
              key={node.id}
              className={'obj-row lvl' + depth + (selected ? ' active' : '')
                + (hideState === 'all' ? ' hidden' : '') + (node.kind === 'ent' ? ' is-ent' : '')}
              style={{ paddingLeft: 6 + depth * 12 }}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={row.hasKids ? row.open : undefined}
              aria-level={depth + 1}
              tabIndex={0}
              title={title}
              onClick={() => onPick(node)}
              onKeyDown={(e) => onRowKey(e, row)}
            >
              {row.hasKids ? (
                <button
                  type="button"
                  className={'obj-caret' + (row.open ? ' open' : '')}
                  aria-label={row.open ? 'Свернуть' : 'Развернуть'}
                  onClick={(e) => { e.stopPropagation(); toggle(node); }}
                >
                  <Ic n="caret" size={13} />
                </button>
              ) : <span className="obj-caret" />}
              <span className="obj-dot" style={{ background: toneColor(node.tone) }} />
              <Ic n={node.icon} size={14} />
              <span className="obj-label">{node.label}</span>
              {node.kind !== 'section' && <span className="obj-n">{node.count}</span>}
              <button
                type="button"
                className={'eye obj-eye' + (hideState === 'all' ? ' off' : hideState === 'mixed' ? ' part' : '')}
                title={hideState === 'all' ? 'Показать на холсте' : 'Скрыть с холста'}
                aria-label={(hideState === 'all' ? 'Показать: ' : 'Скрыть: ') + node.label}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden(node.ids, hideState !== 'all');
                }}
              >
                <Ic n="eye" size={15} />
              </button>
              <button
                type="button"
                className={'eye obj-lock' + (lockState === 'all' ? ' off' : lockState === 'mixed' ? ' part' : '')}
                title={lockState === 'all'
                  ? 'Разблокировать: объект снова выбирается мышью'
                  : 'Заблокировать: нельзя выбрать и сдвинуть мышью'}
                aria-label={(lockState === 'all' ? 'Разблокировать: ' : 'Заблокировать: ') + node.label}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLocked(node.ids, lockState !== 'all');
                }}
              >
                <Ic n={lockState === 'all' ? 'lock' : 'unlock'} size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="hint obj-hint">
        Клик по строке — выделить и показать объект. «Глаз» прячет объект с холста,
        «замок» оставляет его видимым, но не даёт выбрать или сдвинуть.
        Заблокированные объекты не выделяются рамкой и кликом.
      </div>
    </div>
  );
}
