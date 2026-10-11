import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/widgets';
import type { Doc } from '../pcb/model';
import { diffDocs, diffSummary, type VersionDiff } from '../pcb/versions-diff';
import { cloudApi, cloudBytes, cloudDate, cloudError, type CloudProject } from './api';

/** Метаданные версии: без документа (он приходит отдельно, по запросу). */
export interface ProjectVersion {
  id: string;
  projectId: string;
  name: string;
  bytes: number;
  entityCount: number;
  createdAt: number;
}

const CURRENT = 'current';
const KIND_CHANGE = { added: 'Добавлено', removed: 'Удалено', changed: 'Изменено' } as const;

const defaultName = (): string =>
  `Версия ${new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`;

const mm = (v: number): string => v.toFixed(1).replace('.', ',') + ' мм';

/**
 * Именованные версии облачного проекта: снимки текущей платы, сравнение любых двух
 * (включая несохранённую плату в редакторе) и восстановление. Восстановление
 * передаёт документ в редактор через App — оно отменяется Ctrl+Z.
 */
export function ProjectVersionsDialog({ project, current, onClose, onRestore, onLocate }: {
  project: CloudProject;
  /** плата, открытая в редакторе (может содержать несохранённые правки) */
  current: Doc;
  onClose: () => void;
  onRestore: (doc: Doc, version: ProjectVersion) => void;
  /** перейти к точке на плате (мм) */
  onLocate: (x: number, y: number) => void;
}) {
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(defaultName);
  const [left, setLeft] = useState<string>(CURRENT);
  const [right, setRight] = useState<string>(CURRENT);
  const [diff, setDiff] = useState<{ title: string; result: VersionDiff } | null>(null);
  // документы сохранённых версий неизменяемы — кэшируем; текущая плата всегда берётся из пропса
  const docs = useRef(new Map<string, Doc>());

  const load = useCallback(async () => {
    const data = await cloudApi<{ versions: ProjectVersion[] }>(`/projects/${project.id}/versions`);
    setVersions(data.versions);
    return data.versions;
  }, [project.id]);

  useEffect(() => {
    let live = true;
    void load().catch((e) => { if (live) setError(cloudError(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [load]);

  /** Документ версии: один раз с сервера, дальше — из кэша. */
  const docOf = async (id: string): Promise<Doc> => {
    if (id === CURRENT) return current;
    const cached = docs.current.get(id);
    if (cached) return cached;
    const data = await cloudApi<{ version: ProjectVersion & { document: Doc } }>(`/projects/${project.id}/versions/${id}`);
    docs.current.set(id, data.version.document);
    return data.version.document;
  };

  const label = (id: string): string => {
    if (id === CURRENT) return 'Текущая плата (редактор)';
    const v = versions.find((x) => x.id === id);
    return v ? `${v.name} · ${cloudDate(v.createdAt)}` : 'Версия';
  };

  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); }
    catch (e) { setError(cloudError(e)); }
    finally { setBusy(false); }
  };

  const save = () => perform(async () => {
    const trimmed = name.trim();
    const data = await cloudApi<{ version: ProjectVersion }>(`/projects/${project.id}/versions`, 'POST', {
      name: trimmed, document: current,
    });
    docs.current.set(data.version.id, current);
    await load();
    setName(defaultName());
    setRight(CURRENT);
    setLeft(data.version.id);
  });

  const compare = () => perform(async () => {
    const [a, b] = await Promise.all([docOf(left), docOf(right)]);
    setDiff({ title: `${label(left)}  →  ${label(right)}`, result: diffDocs(a, b) });
  });

  const remove = (v: ProjectVersion) => {
    if (!window.confirm(`Удалить версию «${v.name}»? Восстановить её после этого нельзя.`)) return;
    void perform(async () => {
      await cloudApi(`/projects/${project.id}/versions/${v.id}`, 'DELETE');
      docs.current.delete(v.id);
      if (left === v.id) setLeft(CURRENT);
      if (right === v.id) setRight(CURRENT);
      setDiff(null);
      await load();
    });
  };

  const sameChoice = left === right;

  return <Modal title="Версии проекта" className="versions-modal" onClose={onClose}
    foot={<button className="btn" onClick={onClose}>Закрыть</button>}>
    <p>Снимки «{project.name}» хранятся на сервере отдельно от текущей версии. Сохраните плату именованной версией перед крупными изменениями, сравните версии и при необходимости восстановите любую из них. Восстановление можно отменить Ctrl+Z.</p>

    <div className="versions-save">
      <label htmlFor="version-name">Сохранить текущую плату как версию</label>
      <div>
        <input id="version-name" className="txt" value={name} maxLength={120} disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) void save(); }} />
        <button className="btn primary" disabled={!name.trim() || busy || versions.length >= 50} onClick={() => void save()}>Сохранить версию</button>
      </div>
      {versions.length >= 50 && <small className="versions-hint">Достигнут предел 50 версий. Удалите ненужные, чтобы сохранить новую.</small>}
    </div>

    <h3 className="versions-head">Версии <span>{versions.length}</span></h3>
    <div className="versions-list" aria-busy={loading}>
      {loading && <p>Загружаем версии…</p>}
      {!loading && !versions.length && <p>Версий пока нет. Сохраните первую — например, перед трассировкой.</p>}
      {versions.map((v) => <div className="versions-item" key={v.id}>
        <div className="versions-meta">
          <strong>{v.name}</strong>
          <small>{cloudDate(v.createdAt)} · {v.entityCount} эл. · {cloudBytes(v.bytes)}</small>
        </div>
        <div className="versions-actions">
          <button className="btn tiny" disabled={busy} onClick={() => { setRight(v.id); setLeft(CURRENT); setDiff(null); }}
            title="Сравнить эту версию с текущей платой">Сравнить с текущей</button>
          <button className="btn tiny" disabled={busy} onClick={() => {
            if (!window.confirm(`Восстановить «${v.name}» в редакторе? Текущая плата заменится. Вернуть её можно Ctrl+Z, сохранённые версии останутся.`)) return;
            void perform(async () => onRestore(await docOf(v.id), v));
          }}>Восстановить</button>
          <button className="btn tiny danger" disabled={busy} onClick={() => remove(v)}>Удалить</button>
        </div>
      </div>)}
    </div>

    {versions.length > 0 && <div className="versions-compare">
      <h3 className="versions-head">Сравнение</h3>
      <div className="versions-pick">
        <label>Было
          <select className="txt" value={left} disabled={busy} onChange={(e) => { setLeft(e.target.value); setDiff(null); }}>
            <option value={CURRENT}>{label(CURRENT)}</option>
            {versions.map((v) => <option key={v.id} value={v.id}>{label(v.id)}</option>)}
          </select>
        </label>
        <label>Стало
          <select className="txt" value={right} disabled={busy} onChange={(e) => { setRight(e.target.value); setDiff(null); }}>
            <option value={CURRENT}>{label(CURRENT)}</option>
            {versions.map((v) => <option key={v.id} value={v.id}>{label(v.id)}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={busy || sameChoice} onClick={() => void compare()}>Сравнить</button>
      </div>
      {sameChoice && <small className="versions-hint">Выберите две разные версии.</small>}
      {diff && <DiffView title={diff.title} result={diff.result} onLocate={onLocate} />}
    </div>}

    {busy && <p role="status" className="versions-hint">Выполняем…</p>}
    {error && <div className="cloud-error" role="alert">{error}</div>}
  </Modal>;
}

function DiffView({ title, result, onLocate }: { title: string; result: VersionDiff; onLocate: (x: number, y: number) => void }) {
  const kinds = Object.entries(result.byKind);
  return <div className="versions-diff" role="region" aria-label="Результат сравнения">
    <strong>{title}</strong>
    <p className="versions-summary">{diffSummary(result)}</p>
    <div className="versions-stats">
      <span>Дорожки: {mm(result.trackLength.before)} → {mm(result.trackLength.after)}</span>
      {result.sizeChanged && <span>Размер платы изменён</span>}
      {result.panelChanged && <span>Параметры панелизации изменены</span>}
    </div>
    {kinds.length > 0 && <ul className="versions-kinds">
      {kinds.map(([kind, c]) => <li key={kind}>{kindName(kind)}: +{c.added} / −{c.removed} / ~{c.changed}</li>)}
    </ul>}
    {result.nets.length > 0 && <div className="versions-nets">
      <h4>Цепи</h4>
      <ul>{result.nets.map((n, i) => <li key={i}>{KIND_CHANGE[n.type]}: <b>{n.name}</b>{n.detail ? ` — ${n.detail}` : ''}</li>)}</ul>
    </div>}
    {result.diffPairs.length > 0 && <div className="versions-nets">
      <h4>Дифференциальные пары</h4>
      <ul>{result.diffPairs.map((pair, i) => <li key={i}>{KIND_CHANGE[pair.type]}: <b>{pair.name}</b>{pair.detail ? ` — ${pair.detail}` : ''}</li>)}</ul>
    </div>}
    {result.comments.length > 0 && <div className="versions-nets versions-comments">
      <h4>Комментарии ревью</h4>
      <ul>{result.comments.map((comment) => <li key={comment.type + comment.id}>
        <span className={'versions-tag ' + comment.type}>{KIND_CHANGE[comment.type]}</span>
        <span>{comment.detail.slice(0, 120)}</span>
        <button className="btn tiny" onClick={() => onLocate(comment.x, comment.y)} title="Показать метку на плате">Показать</button>
      </li>)}</ul>
    </div>}
    {result.changes.length > 0 && <>
      <h4>Изменения</h4>
      <ul className="versions-changes">
        {result.changes.map((c) => <li key={c.type + c.id}>
          <span className={'versions-tag ' + c.type}>{KIND_CHANGE[c.type]}</span>
          <span>{c.label}</span>
          <button className="btn tiny" onClick={() => onLocate(c.x, c.y)} title="Показать на плате">Показать</button>
        </li>)}
      </ul>
      {result.truncated && <small className="versions-hint">Показаны первые {result.changes.length} изменений из {result.added + result.removed + result.changed}.</small>}
    </>}
  </div>;
}

function kindName(kind: string): string {
  const names: Record<string, string> = {
    pad: 'Площадки', smd: 'SMD', track: 'Дорожки', via: 'Переходы', hole: 'Отверстия', line: 'Линии',
    circle: 'Окружности', rect: 'Прямоугольники', text: 'Тексты', poly: 'Полигоны', dim: 'Размеры', comp: 'Детали',
  };
  return names[kind] ?? kind;
}
