// Панель генератора деталей и дерево личной библиотеки.
//
// Идея: каталога готовых макросов нет — пользователь пишет в одну строку, что
// ему нужно («soic-16 шаг 1.27, 4 крепежных отверстия»), генератор считает
// посадочное место (src/pcb/gen.ts + footprint.ts), а деталь можно поставить на
// плату сразу или сохранить в свою папку.

import { useState, type ReactNode } from 'react';
import {
  EXAMPLES, FAMILY_HELP, setParamInQuery, describe, type GenResult, type ParamDef, type ParamVal,
} from '../pcb/gen';
import { fmt } from '../pcb/model';
import { folderPath, type Macro, type Store, type Tree } from '../pcb/userlib';
import { LibPreview } from './libpreview';
import { NI, SI, TI } from './widgets';
import { Ic } from './icons';

/** «8 выводов · шаг 2.54 мм · 4 отверстия» — одна строка характеристик */
export function genSpecText(r: GenResult): string {
  const sp = r.spec;
  if (!sp) return '';
  const parts: string[] = [];
  if (sp.pins) parts.push(`${sp.pins} ${plural(sp.pins, ['вывод', 'вывода', 'выводов'])}`);
  if (sp.smd) parts.push(`${sp.smd} планарных`);
  if (sp.holes) parts.push(`${sp.holes} ${plural(sp.holes, ['отверстие', 'отверстия', 'отверстий'])}`);
  if (sp.pitch) parts.push(`шаг ${fmt(sp.pitch)} мм`);
  if (sp.labels) parts.push(`подписей: ${sp.labels}`);
  if (sp.w && sp.h) parts.push(`габарит ${fmt(sp.w)} × ${fmt(sp.h)} мм`);
  return parts.join(' · ');
}

const plural = (n: number, forms: [string, string, string]): string => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

export interface GenPanelProps {
  query: string;
  onQuery: (q: string) => void;
  gen: GenResult;
  store: Store;
  /** деталь, из которой пришёл запрос (для кнопки «обновить») */
  source?: Macro | null;
  onPlace: () => void;
  onPreview: () => void;
  onSave: (name: string, folderId: string | null) => void;
  onUpdate?: () => void;
  onNewFolder?: (name: string) => void;
}

export function GenPanel({
  query, onQuery, gen, store, source, onPlace, onPreview, onSave, onUpdate, onNewFolder,
}: GenPanelProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const fam = gen.family;
  const ok = gen.ok && !!fam;

  const change = (def: ParamDef, v: ParamVal): void => {
    if (!fam) return;
    onQuery(setParamInQuery(query, fam, def.key, v));
  };

  const startSave = (): void => {
    setName(source?.name ?? gen.title ?? 'Деталь');
    setFolderId(source?.folderId ?? null);
    setSaving(true);
  };

  return (
    <div className="gen">
      <div className="search gen-q">
        <input
          id="gen-query"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) { e.preventDefault(); onPlace(); } }}
          placeholder="Опишите деталь: dip 8, soic-16 шаг 1.27, плата 60×40…"
          spellCheck={false}
        />
      </div>
      <div className="gen-bar">
        <button type="button" className="btn tiny" onClick={() => setShowHelp((v) => !v)} title="Что понимает генератор">
          Справка
        </button>
        {onNewFolder && (
          <button
            type="button"
            className="btn tiny"
            title="Создать папку в библиотеке"
            onClick={() => {
              const n = `Папка ${store.folders.length + 1}`;
              onNewFolder(n);
            }}
          >
            + папка
          </button>
        )}
      </div>
      {showHelp && (
        <div className="gen-help">
          <div className="lib-hint">
            Укажите тип корпуса (можно с кодом), число выводов, шаг, размеры площадок и сверла,
            габарит, крепёж, подписи. Единицы: мм, mil, см; пары — «60×40», «1.8/0.8».
          </div>
          <ul>
            {FAMILY_HELP.map((f) => (
              <li key={f.id}>
                <b>{f.id}</b> — {f.hint}
                <div className="lib-hint">слова: {f.words} · пример: {f.example}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!ok && (
        <div className="gen-fail">
          <div className="gen-err">{gen.error ?? 'Начните с названия корпуса.'}</div>
          {gen.notes.map((n, i) => <div key={i} className="lib-hint">{n}</div>)}
          <div className="gen-ex">
            {EXAMPLES.slice(0, 10).map((e) => (
              <button key={e.query} type="button" className="chip" onClick={() => onQuery(e.query)} title={e.note}>
                {e.query}
              </button>
            ))}
          </div>
        </div>
      )}

      {ok && (
        <>
          <div className="gen-fam" title={fam!.hint}>
            <span className="t">{gen.title ?? fam!.title}</span>
            <span className="f">{fam!.title}</span>
          </div>
          <LibPreview els={gen.els} bl={gen.bl} height={158} rot={0} />
          {genSpecText(gen) && <div className="lib-spec gen-spec">{genSpecText(gen)}</div>}
          {describe(gen) && <div className="lib-hint">{describe(gen)}</div>}
          {gen.notes.map((n, i) => (
            <div key={i} className="gen-note">{n}</div>
          ))}
          {!!gen.ignored?.length && (
            <div className="lib-hint">не учтено: {gen.ignored.join(', ')}</div>
          )}

          <div className="gen-acts">
            <button type="button" className="btn primary" onClick={onPlace} title="Поставить на плату (ЛКМ по плате, R — поворот, Q — сторона)">
              Поставить на плату
            </button>
            <button type="button" className="btn" onClick={onPreview} title="Крупный предпросмотр">
              <Ic n="eye" size={15} />
            </button>
            <button type="button" className="btn" onClick={startSave} title="Сохранить в библиотеку">
              <Ic n="save" size={15} />
            </button>
            {source && onUpdate && (
              <button type="button" className="btn" onClick={onUpdate} title={`Обновить «${source.name}» текущими размерами`}>
                <Ic n="update" size={15} />
              </button>
            )}
          </div>

          {saving && (
            <div className="gen-save">
              <TI label="Имя" value={name} on={setName} />
              <SI
                label="Папка"
                value={folderId ?? ''}
                options={[['', 'Библиотека (корень)'], ...store.folders.map((f) => [f.id, folderPath(store, f.id, ' / ')] as [string, string])]}
                on={(v) => setFolderId(v || null)}
              />
              <div className="gen-save-acts">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => { onSave(name, folderId); setSaving(false); }}
                >
                  Сохранить
                </button>
                <button type="button" className="btn" onClick={() => setSaving(false)}>Отмена</button>
              </div>
            </div>
          )}

          <div className="gen-params">
            <div className="cat" style={{ padding: '9px 12px 2px' }}>Параметры</div>
            {fam!.params.map((def) => <ParamRow key={def.key} def={def} value={gen.params?.[def.key] ?? def.def} on={(v) => change(def, v)} />)}
          </div>

          <div className="gen-ex">
            {EXAMPLES.map((e) => (
              <button key={e.query} type="button" className="chip" onClick={() => onQuery(e.query)} title={e.note}>
                {e.query}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Одна строка редактора параметра: правка переписывает строку запроса */
function ParamRow({ def, value, on }: { def: ParamDef; value: ParamVal; on: (v: ParamVal) => void }) {
  const num = typeof value === 'number' ? value : Number(value) || 0;
  const inner: ReactNode = def.kind === 'bool' ? (
    <label className="chk gen-chk">
      <input type="checkbox" checked={!!value} onChange={(e) => on(e.target.checked)} />
      {def.label}
    </label>
  ) : def.kind === 'enum' ? (
    <SI
      label={def.label}
      value={String(value)}
      options={def.options ?? []}
      on={(v) => on(v)}
    />
  ) : def.kind === 'text' ? (
    <TI label={def.label} value={String(value ?? '')} on={(v) => on(v)} />
  ) : (
    <NI
      label={def.label}
      value={num}
      step={def.kind === 'int' ? 1 : def.step ?? 0.05}
      min={def.min}
      max={def.max}
      on={(v) => on(def.kind === 'int' ? Math.round(v) : v)}
    />
  );
  return (
    <div className="gen-p" title={def.hint}>
      {inner}
    </div>
  );
}

export interface MacroTreeProps {
  store: Store;
  tree: Tree;
  pickedId: string | null;
  onPick: (m: Macro) => void;
  onPreview: (m: Macro) => void;
  /** «в генератор»: подставить строку, из которой деталь получилась, и править её */
  onEdit?: (m: Macro) => void;
  onRename: (m: Macro, name: string) => void;
  onDelete: (m: Macro) => void;
  onMove: (m: Macro, folderId: string | null) => void;
  onNewFolder: (parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  filter: string;
  onFilter: (s: string) => void;
  onExport: () => void;
  onImport: () => void;
}

/** Дерево папок с сохранёнными деталями: свои папки, переименование, перенос */
export function MacroTree(p: MacroTreeProps) {
  return (
    <div className="mtree">
      <div className="search">
        <input
          value={p.filter}
          onChange={(e) => p.onFilter(e.target.value)}
          placeholder="Поиск по библиотеке…"
          spellCheck={false}
        />
      </div>
      <div className="gen-bar">
        <button type="button" className="btn tiny" onClick={() => p.onNewFolder(null)} title="Новая папка в корне библиотеки">
          + папка
        </button>
        <button type="button" className="btn tiny" onClick={p.onExport} title="Сохранить библиотеку в JSON-файл">
          Экспорт
        </button>
        <button type="button" className="btn tiny" onClick={p.onImport} title="Дозагрузить библиотеку из JSON-файла">
          Импорт…
        </button>
      </div>
      {!p.store.macros.length && (
        <div className="lib-hint">
          Пока пусто. Сгенерируйте деталь сверху и нажмите «в библиотеку» — её можно
          положить в папку, переименовать, перенести и удалять.
        </div>
      )}
      <Node {...p} node={p.tree} depth={0} />
    </div>
  );
}

function Node(props: MacroTreeProps & { node: Tree; depth: number }) {
  const {
    node, depth, store, pickedId, onPick, onPreview, onEdit, onRename, onDelete, onMove,
    onNewFolder, onRenameFolder, onDeleteFolder, collapsed, toggle,
  } = props;
  const [edit, setEdit] = useState<string | null>(null);
  const open = node.id === null || !collapsed.has(node.id);
  const total = countAll(node);
  return (
    <div className={'fold' + (depth > 0 ? ' sub' : '')}>
      {node.id !== null ? (
        <div className="cat" onClick={() => toggle(node.id as string)} title={open ? 'Свернуть папку' : 'Развернуть папку'}>
          <span className="tw">{open ? '▾' : '▸'}</span>
          {edit === node.id ? (
            <NameEdit
              value={node.name}
              onDone={(v) => { if (v.trim()) onRenameFolder(node.id as string, v); setEdit(null); }}
            />
          ) : (
            <span className="nm">{node.name}</span>
          )}
          <span className="cnt">{total}</span>
          <span className="acts" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn tiny" title="Новая подпапка" onClick={() => onNewFolder(node.id)}>+</button>
            <button type="button" className="btn tiny" title="Переименовать папку" onClick={() => setEdit(node.id)}>✎</button>
            <button
              type="button"
              className="btn tiny"
              title={node.macros.length ? 'Удалить папку — детали в ней переедут на уровень выше' : 'Удалить пустую папку'}
              onClick={() => onDeleteFolder(node.id as string)}
            >
              ×
            </button>
          </span>
        </div>
      ) : (
        depth > 0 && <div className="cat"><span className="nm">{node.name}</span><span className="cnt">{total}</span></div>
      )}
      {open && (
        <>
          {node.macros.map((m) => (
            <div
              key={m.id}
              className={'lib-item' + (pickedId === m.id ? ' picked' : '')}
              onClick={() => onPick(m)}
              onDoubleClick={() => onPreview(m)}
              title={`${m.name} · ${m.ents.length} прим.\n${m.query ? 'из строки: ' + m.query + '\n' : ''}клик — брать и ставить, двойной — крупный вид`}
            >
              {edit === m.id ? (
                <NameEdit value={m.name} onDone={(v) => { if (v.trim()) onRename(m, v); setEdit(null); }} />
              ) : (
                <>
                  <span className="lib-name">{m.name}</span>
                  <span className="lib-spec">{m.query ? 'генератор' : `${m.ents.length} прим.`}</span>
                </>
              )}
              <span className="acts" onClick={(e) => e.stopPropagation()}>
                <select
                  className="mv"
                  value={m.folderId ?? ''}
                  title="Перенести в папку"
                  onChange={(e) => onMove(m, e.target.value || null)}
                >
                  <option value="">корень</option>
                  {store.folders.map((f) => (
                    <option key={f.id} value={f.id}>{folderPath(store, f.id, ' / ')}</option>
                  ))}
                </select>
                {!!(onEdit && m.query) && (
                  <button
                    type="button"
                    className="btn tiny"
                    title={`Поправить строку: ${m.query}`}
                    onClick={() => onEdit!(m)}
                  >
                    <Ic n="gen" size={12} />
                  </button>
                )}
                <button type="button" className="btn tiny" title="Переименовать" onClick={() => setEdit(m.id)}>✎</button>
                <button type="button" className="btn tiny" title="Удалить деталь" onClick={() => onDelete(m)}>×</button>
              </span>
            </div>
          ))}
          {node.folders.map((c) => <Node key={c.id ?? 'root'} {...props} node={c} depth={depth + 1} />)}
        </>
      )}
    </div>
  );
}

function countAll(node: Tree): number {
  return node.macros.length + node.folders.reduce((a, f) => a + countAll(f), 0);
}

/** Инлайн-поле переименования: Enter — принять, Esc/клик мимо — отменить */
function NameEdit({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  return (
    <input
      className="txt nm-edit"
      autoFocus
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') onDone('');
      }}
      onBlur={(e) => onDone(e.target.value)}
    />
  );
}
