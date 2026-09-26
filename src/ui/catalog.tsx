// Каталог PartReel: локальный поиск выполняет same-origin сервер по кэшированному
// JSON-индексу; браузер получает только совпавшие метаданные и выбранный .kicad_mod.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { parseKicadFootprint, type ParsedKicadFootprint } from '../pcb/kicad-footprint';
import { LibPreview } from './libpreview';

export interface PartReelPart {
  id: string;
  name: string;
  category: string;
  family: string;
  manufacturer: string;
  keywords: string;
  verified?: boolean | string;
  pins?: number;
  searchText?: string;
  [key: string]: unknown;
}

export interface CatalogSelection {
  source?: string;
  raw?: string;
  part: PartReelPart;
  detail: Record<string, unknown>;
  footprint: ParsedKicadFootprint;
  pageUrl: string;
  license: string;
  verified: boolean;
  provenance: string;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

function textValue(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textValue).filter(Boolean).join(' ');
  const o = obj(v);
  if (!o) return '';
  for (const k of ['name', 'label', 'value', 'title', 'id', 'url', 'source']) {
    const s = textValue(o[k]);
    if (s) return s;
  }
  return '';
}

const normalizeText = (s: string): string => s
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9а-яё]+/gi, ' ').trim();

function normalizePart(raw: unknown): PartReelPart | null {
  const p = obj(raw);
  if (!p) return null;
  const id = textValue(p.id ?? p.slug ?? p.key).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  const name = textValue(p.name ?? p.mpn ?? p.title).trim() || id;
  const category = textValue(p.category);
  const family = textValue(p.family);
  const manufacturer = textValue(p.manufacturer ?? p.brand);
  const keywords = textValue(p.keywords ?? p.tags);
  const pinsRaw = Number(p.pins ?? p.pin_count ?? p.pads);
  return {
    ...p,
    id, name, category, family, manufacturer, keywords,
    ...(Number.isFinite(pinsRaw) && pinsRaw > 0 ? { pins: pinsRaw } : {}),
  };
}

function isVerified(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return /^(verified|approved|passed|true|yes)$/i.test(value.trim());
}

function detailObject(value: unknown): Record<string, unknown> {
  const root = obj(value) ?? {};
  return obj(root.part) ?? obj(root.data) ?? root;
}

function partReelPath(value: unknown): string | null {
  const raw = textValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, 'https://partreel.com');
    if (url.hostname !== 'partreel.com' || !url.pathname.startsWith('/library/') || !url.pathname.endsWith('.kicad_mod')) return null;
    const path = decodeURIComponent(url.pathname);
    if (path.includes('..') || !/^\/library\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.kicad_mod$/.test(path)) return null;
    return path;
  } catch { return null; }
}

function footprintPath(detail: Record<string, unknown>): string | null {
  const files = obj(detail.files) ?? obj(detail.downloads) ?? {};
  const candidates: unknown[] = [
    files.footprint, files.kicad_mod, files.kicadMod, detail.footprint_url,
    detail.kicad_mod_url, detail.footprint,
  ];
  for (const value of candidates) {
    const p = partReelPath(value);
    if (p) return p;
    const nested = obj(value);
    if (nested) {
      const q = partReelPath(nested.url ?? nested.href ?? nested.download);
      if (q) return q;
    }
  }
  return null;
}

function displayLicense(detail: Record<string, unknown>): string {
  const license = obj(detail.license);
  const licenses = obj(detail.licenses);
  const componentLicense = textValue(license?.components ?? license?.component ?? license?.name ?? license?.spdx)
    || textValue(licenses?.components ?? licenses?.footprint)
    || textValue(detail.license_id ?? detail.license);
  return componentLicense || 'CC BY 4.0 (условия PartReel)';
}

function displayProvenance(detail: Record<string, unknown>): string {
  const provenance = obj(detail.provenance);
  const values = [
    detail.dimensions_source,
    provenance?.dimensions_source,
    provenance?.generator_source,
    detail.source,
    detail.upstream,
  ].map(textValue).filter(Boolean);
  return [...new Set(values)].slice(0, 2).join(' · ');
}

function pageFor(part: PartReelPart, detail: Record<string, unknown>): string {
  const candidate = textValue(detail.page ?? detail.url ?? part.page);
  if (candidate) {
    try {
      const u = new URL(candidate, 'https://partreel.com');
      if (u.hostname === 'partreel.com' && u.pathname.startsWith('/p/')) return u.href;
    } catch { /* use predictable page below */ }
  }
  return `https://partreel.com/p/${encodeURIComponent(part.id)}/`;
}

const categories: { id: 'all' | 'smd' | 'modules'; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'smd', label: 'SMD' },
  { id: 'modules', label: 'Модули / датчики' },
];

export function FootprintCatalog({
  onPlace, onSave, onExport,
}: {
  onPlace: (selection: CatalogSelection) => void;
  onSave: (selection: CatalogSelection) => void;
  onExport?: (selection: CatalogSelection) => void;
}) {
  const [provider, setProvider] = useState<'footprints' | 'modules'>('footprints');
  const sourceName = provider === 'modules' ? 'KiCad' : 'PartReel';
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const [category, setCategory] = useState<'all' | 'smd' | 'modules'>('all');
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [results, setResults] = useState<PartReelPart[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState<PartReelPart | null>(null);
  const [selection, setSelection] = useState<CatalogSelection | null>(null);
  const [loadingPart, setLoadingPart] = useState(false);
  const [partError, setPartError] = useState('');
  const searchRequest = useRef(0);
  const partRequest = useRef(0);

  useEffect(() => {
    if (!submittedQuery) return;
    const seq = ++searchRequest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setLoadingSearch(true);
        setSearchError('');
        try {
          const params = new URLSearchParams({
            q: submittedQuery,
            category,
            verified: String(onlyVerified),
          });
          const response = await fetch(`/api/${provider}/search?${params}`, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
          const payload: unknown = await response.json();
          const data = obj(payload) ?? {};
          if (!response.ok) throw new Error(textValue(data.error) || `HTTP ${response.status}`);
          const found = Array.isArray(data.results)
            ? data.results.map(normalizePart).filter((p): p is PartReelPart => !!p)
            : [];
          if (seq !== searchRequest.current) return;
          setResults(found);
          setMatchCount(Number(data.count) || 0);
        } catch (error) {
          if (seq === searchRequest.current && !controller.signal.aborted) {
            setSearchError(error instanceof Error ? error.message : 'Каталог PartReel недоступен.');
            setResults([]);
            setMatchCount(0);
          }
        } finally {
          if (seq === searchRequest.current) setLoadingSearch(false);
        }
      })();
    }, 140);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [submittedQuery, category, onlyVerified, searchRevision, provider]);

  const search = (event?: FormEvent): void => {
    event?.preventDefault();
    const q = query.trim();
    if (!q || q.length > 120) return;
    setSearchError('');
    setSubmittedQuery(q);
    setSearchRevision((v) => v + 1);
  };

  const selectPart = async (part: PartReelPart): Promise<void> => {
    const seq = ++partRequest.current;
    setSelected(part);
    setSelection(null);
    setPartError('');
    setLoadingPart(true);
    try {
      const detailResponse = await fetch(`/api/${provider}/detail/${encodeURIComponent(part.id)}`, { signal: AbortSignal.timeout(30_000) });
      if (!detailResponse.ok) {
        let reason = `HTTP ${detailResponse.status}`;
        try { reason = textValue((await detailResponse.json()).error) || reason; } catch { /* upstream error page */ }
        throw new Error(reason);
      }
      const detail = detailObject(await detailResponse.json());
      const path = provider === 'modules' ? `/api/modules/raw/${encodeURIComponent(part.id)}` : footprintPath(detail);
      if (!path) throw new Error('Для этой записи PartReel не опубликован файл .kicad_mod.');
      const modResponse = await fetch(provider === 'modules' ? path : `/api/footprints/raw?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(30_000) });
      if (!modResponse.ok) {
        let reason = `HTTP ${modResponse.status}`;
        try { reason = textValue((await modResponse.json()).error) || reason; } catch { /* upstream text response */ }
        throw new Error(reason);
      }
      const raw = await modResponse.text();
      const footprint = parseKicadFootprint(raw);
      if (seq !== partRequest.current) return;
      setSelection({
        part, detail, footprint, raw, source: sourceName,
        pageUrl: provider === 'modules' ? String(detail.page) : pageFor(part, detail),
        license: displayLicense(detail),
        verified: isVerified(detail.verified ?? part.verified),
        provenance: displayProvenance(detail),
      });
    } catch (error) {
      if (seq === partRequest.current) setPartError(error instanceof Error ? error.message : 'Не удалось загрузить .kicad_mod.');
    } finally {
      if (seq === partRequest.current) setLoadingPart(false);
    }
  };

  const retrySearch = (): void => {
    setSearchError('');
    setSearchRevision((v) => v + 1);
  };

  const datasheet = useMemo(() => {
    if (!selection) return '';
    const value = textValue(selection.detail.datasheet ?? selection.detail.datasheet_url);
    try { return new URL(value, 'https://partreel.com').href; } catch { return ''; }
  }, [selection]);

  return (
    <div className="catalog">
      <div className="catalog-intro">
        <strong>{sourceName} · каталог компонентов</strong>
        <span>Публичный индекс, без ключа API. Поиск и кэш — на сервере; в браузер передаются только совпадения.</span>
      </div>
      <div className="catalog-filter" role="group" aria-label="Источник каталога">
        {(['footprints', 'modules'] as const).map(value => <button key={value} type="button" className={provider === value ? 'on' : ''} onClick={() => {
          ++partRequest.current; ++searchRequest.current;
          setProvider(value); setSelected(null); setSelection(null); setResults([]); setPartError(''); setSearchError(''); setLoadingPart(false); setLoadingSearch(false);
          setOnlyVerified(false);
          if (value === 'modules' && !submittedQuery) { setQuery('Arduino'); setSubmittedQuery('Arduino'); }
        }}>{value === 'modules' ? 'Arduino / KiCad' : 'PartReel'}</button>)}
      </div>
      <form className="catalog-search" onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="BME280, 0805, USB-C, Arduino…"
          aria-label="Поиск по каталогу компонентов"
          spellCheck={false}
        />
        <button type="submit" className="btn primary" disabled={!query.trim() || query.trim().length > 120 || loadingSearch}>
          {loadingSearch ? '…' : 'Найти'}
        </button>
      </form>
      <div className="catalog-filter" role="group" aria-label="Тип компонента">
        {categories.map((item) => (
          <button key={item.id} type="button" className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <label className="catalog-verified">
        <input type="checkbox" checked={onlyVerified} onChange={(event) => setOnlyVerified(event.target.checked)} />
        Только с отметкой verified
      </label>

      {searchError && <div className="catalog-error">Каталог недоступен: {searchError}
        <button type="button" className="btn tiny" onClick={retrySearch}>Повторить</button>
      </div>}
      {!submittedQuery && (
        <div className="catalog-hint">
          При первом поиске сервер загружает и кэширует статический индекс PartReel; полный каталог не отправляется в браузер.
          <div className="catalog-examples">
            {['0805', 'BME280', 'Arduino Nano'].map((sample) => (
              <button key={sample} type="button" className="chip" onClick={() => setQuery(sample)}>{sample}</button>
            ))}
          </div>
        </div>
      )}
      {loadingSearch && <div className="catalog-state">Ищу в каталоге {sourceName}…</div>}
      {!!submittedQuery && !loadingSearch && !searchError && (
        <>
          <div className="catalog-result-count">{matchCount.toLocaleString('ru-RU')} совпадений · показаны первые {results.length}</div>
          {results.length === 0 ? <div className="catalog-state">Ничего не найдено. Попробуйте другой артикул или категорию.</div> : (
            <div className="catalog-results">
              {results.map((part) => (
                <button key={part.id} type="button" className={`catalog-item${selected?.id === part.id ? ' selected' : ''}`} onClick={() => void selectPart(part)}>
                  <span className="catalog-item-title">
                    {part.name}
                    <span className={`catalog-badge${isVerified(part.verified) ? ' verified' : ''}`}>{isVerified(part.verified) ? 'verified' : 'не проверен'}</span>
                  </span>
                  <span className="catalog-item-meta">
                    {[part.category, part.family, part.manufacturer, textValue(part.mpn_pattern ?? part.mpn), part.pins ? `${part.pins} pin` : ''].filter(Boolean).join(' · ') || part.id}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {selected && (
        <section className="catalog-card" aria-live="polite">
          <h4>{selected.name}</h4>
          <div className="catalog-card-meta">{[selected.manufacturer, selected.family, selected.category, textValue(selected.mpn_pattern ?? selected.mpn), selected.pins ? `${selected.pins} контактов` : ''].filter(Boolean).join(' · ')}</div>
          {loadingPart && <div className="catalog-state">Загружаю карточку и .kicad_mod…</div>}
          {partError && <div className="catalog-error">{partError}<button type="button" className="btn" onClick={() => void selectPart(selected)}>Повторить</button></div>}
          {selection && (
            <>
              <LibPreview els={selection.footprint.els} bl={selection.footprint.bbox} height={142} />
              <div className="catalog-spec">
                {selection.footprint.stats.smd ? `${selection.footprint.stats.smd} SMD` : ''}
                {selection.footprint.stats.plated ? `${selection.footprint.stats.plated} PTH` : ''}
                {selection.footprint.stats.holes ? `${selection.footprint.stats.holes} отверстий` : ''}
                {` · ${(selection.footprint.bbox[2] - selection.footprint.bbox[0]).toFixed(2)} × ${(selection.footprint.bbox[3] - selection.footprint.bbox[1]).toFixed(2)} мм`}
              </div>
              <div className="catalog-attribution">
                <span className={`catalog-badge${selection.verified ? ' verified' : ''}`}>
                  {selection.verified ? `Проверено ${sourceName}` : 'Нет отметки verified'}
                </span>
                <span>Лицензия: {selection.license}. Атрибуция: {sourceName}.</span>
                {selection.provenance && <span>Источник: {selection.provenance}</span>}
                <span>Перенос в PSBees упрощает геометрию; сверьте размеры с даташитом перед изготовлением.</span>
                {!!selection.footprint.warnings.length && <span>Ограничения конвертации: {selection.footprint.warnings.join(' ')}</span>}
              </div>
              <div className="catalog-actions">
                <button type="button" className="btn primary" onClick={() => onPlace(selection)}>Поставить на плату</button>
                <button type="button" className="btn" onClick={() => onSave(selection)}>В личную библиотеку</button>
              </div>
              <div className="catalog-actions">
                {onExport && <button type="button" className="btn" onClick={() => onExport(selection)}>Экспорт JSON PSBees</button>}
                <button type="button" className="btn" onClick={() => {
                  const url = URL.createObjectURL(new Blob([selection.raw ?? ''], { type: 'text/plain' }));
                  const link = document.createElement('a'); link.href = url;
                  link.download = `${selection.part.name.replace(/[^a-zA-Z0-9а-яА-Я._-]/g, '_')}.kicad_mod`;
                  document.body.appendChild(link); link.click(); link.remove();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}>Скачать .kicad_mod</button>
              </div>
              <div className="catalog-links">
                <a href={selection.pageUrl} target="_blank" rel="noreferrer">{sourceName} · карточка компонента</a>
                {/^https:\/\//i.test(datasheet) && <a href={datasheet} target="_blank" rel="noreferrer">Даташит</a>}
              </div>
            </>
          )}
        </section>
      )}
      <div className="catalog-footnote">Статус verified и provenance показываются как в источнике; они не заменяют проверку даташита. Источники: PartReel и KiCad Module.pretty. Совместимость модулей и размеры сверяйте с документацией; варианты клонов могут отличаться.</div>
    </div>
  );
}
