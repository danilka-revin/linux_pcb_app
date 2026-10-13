import { useEffect, useState } from 'react';
import {
  cloudApi, cloudBytes, cloudDate, cloudError,
  type CloudLibraryEntry, type CloudLibraryEntryDetail,
} from '../cloud/api';
import type { Macro } from '../pcb/userlib';
import { Ic } from './icons';

const PAGE_SIZE = 25;

type CommunityLibraryProps = {
  onPlace: (macro: Macro) => void;
  onPreview: (macro: Macro) => void;
  onCopyToPersonal: (macro: Macro) => void;
};

/** Server-wide library shared by every signed-in workspace user. */
export function CommunityLibraryPanel({ onPlace, onPreview, onCopyToPersonal }: CommunityLibraryProps) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<CloudLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query.trim()) params.set('q', query.trim());
      void cloudApi<{ entries: CloudLibraryEntry[]; total: number }>(`/library?${params.toString()}`, 'GET', undefined, controller.signal)
        .then((result) => {
          if (!active) return;
          setEntries(result.entries);
          setTotal(result.total);
        })
        .catch((reason: unknown) => { if (active) setError(cloudError(reason)); })
        .finally(() => { if (active) setLoading(false); });
    }, query.trim() ? 220 : 0);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [query, offset, refresh]);

  const loadMacro = async (entry: CloudLibraryEntry): Promise<Macro | null> => {
    setBusyId(entry.id);
    setError('');
    try {
      const result = await cloudApi<{ entry: CloudLibraryEntryDetail }>(`/library/${entry.id}`);
      return result.entry.macro;
    } catch (reason) {
      setError(cloudError(reason));
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (entry: CloudLibraryEntry): Promise<void> => {
    if (!entry.canDelete || !window.confirm(`Удалить «${entry.name}» из общей библиотеки?`)) return;
    setBusyId(entry.id);
    setError('');
    try {
      await cloudApi(`/library/${entry.id}`, 'DELETE', {});
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(cloudError(reason));
    } finally {
      setBusyId(null);
    }
  };

  const act = async (entry: CloudLibraryEntry, action: 'place' | 'preview' | 'copy'): Promise<void> => {
    const macro = await loadMacro(entry);
    if (!macro) return;
    if (action === 'place') onPlace(macro);
    else if (action === 'preview') onPreview(macro);
    else onCopyToPersonal(macro);
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="community-library">
      <div className="community-library-intro">
        <strong>Общая библиотека PSBees</strong>
        <span>Опубликованные элементы доступны всем пользователям этого сервера. Личная библиотека остаётся отдельно.</span>
      </div>
      <div className="community-library-search">
        <input
          className="txt"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOffset(0); }}
          placeholder="Поиск по названию и папке…"
          aria-label="Поиск в общей библиотеке"
          spellCheck={false}
        />
        <button type="button" className="btn tiny" onClick={() => setRefresh((value) => value + 1)} disabled={loading}
          title="Обновить общую библиотеку">
          <Ic n="update" size={13} />
        </button>
      </div>
      {error && <div className="community-library-error" role="alert">{error}</div>}
      <div className="community-library-count" aria-live="polite">
        {loading ? 'Загружаем общую библиотеку…' : `${total} ${total === 1 ? 'деталь' : 'деталей'}`}
      </div>
      <div className="community-library-list">
        {!loading && !error && entries.length === 0 && (
          <div className="community-library-empty">
            {query.trim() ? 'По вашему запросу ничего не найдено.' : 'Пока пусто. Опубликуйте деталь из личной библиотеки, чтобы поделиться ею с остальными.'}
          </div>
        )}
        {entries.map((entry) => (
          <div className="community-library-item" key={entry.id}>
            <div className="community-library-meta">
              <strong title={entry.name}>{entry.name}{entry.isOwner && <span className="community-library-owner">моя</span>}</strong>
              <small>
                {entry.category ? `${entry.category} · ` : ''}{entry.entityCount} прим. · {cloudBytes(entry.bytes)}
              </small>
              <small>Обновлена {cloudDate(entry.updatedAt)}</small>
            </div>
            <div className="community-library-actions">
              <button type="button" className="btn tiny primary" disabled={busyId !== null}
                onClick={() => void act(entry, 'place')} title="Загрузить деталь и перейти к установке на плату">
                Поставить
              </button>
              <button type="button" className="btn tiny" disabled={busyId !== null}
                onClick={() => void act(entry, 'preview')} title="Предпросмотр детали">
                <Ic n="eye" size={13} />
              </button>
              <button type="button" className="btn tiny" disabled={busyId !== null}
                onClick={() => void act(entry, 'copy')} title="Скопировать в личную библиотеку">
                В личную
              </button>
              {entry.canDelete && (
                <button type="button" className="btn tiny" disabled={busyId !== null}
                  onClick={() => void remove(entry)} title="Удалить из общей библиотеки" aria-label={`Удалить ${entry.name}`}>
                  ×
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="community-library-pagination">
          <button type="button" className="btn tiny" disabled={page <= 1 || loading}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Назад</button>
          <span>{page} / {pages}</span>
          <button type="button" className="btn tiny" disabled={page >= pages || loading}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}>Дальше</button>
        </div>
      )}
    </div>
  );
}
