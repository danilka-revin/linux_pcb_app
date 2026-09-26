// Pure local search over the PartReel static JSON index.
// Kept in one module so the production server and Vite development proxy agree.

const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : null;

export function partText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(partText).filter(Boolean).join(' ');
  const o = object(value);
  if (!o) return '';
  for (const key of ['name', 'label', 'value', 'title', 'id', 'url', 'source']) {
    const s = partText(o[key]);
    if (s) return s;
  }
  return '';
}

export function normalizePartText(value) {
  return partText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, ' ').trim();
}

export function partVerified(value) {
  if (value === true) return true;
  return typeof value === 'string' && /^(verified|approved|passed|true|yes)$/i.test(value.trim());
}

const SMD_RE = /(?:^| )(?:smd|smt|surface mount|0402|0603|0805|1206|1210|1812|2010|2512|soic|sop|qfn|qfp|dfn|sot|bga|lga)(?: |$)/;
const MODULE_RE = /(?:^| )(?:module|breakout|sensor|arduino|esp32|esp8266|raspberry|pico|nodemcu|devkit|hat|board|gy ?\d|ky ?\d|hc ?\d|mpu ?\d|bme ?\d|bmp ?\d|dht ?\d|ina ?\d)(?: |$)/;

/** Parse and normalize the few metadata fields the UI needs from the full public index. */
export function parsePartReelIndex(raw) {
  const root = object(raw);
  const rows = Array.isArray(raw) ? raw : root?.parts ?? root?.items ?? root?.data;
  if (!Array.isArray(rows)) throw new Error('PartReel index format changed: parts list not found.');
  const parts = [];
  for (const row of rows) {
    const p = object(row);
    if (!p) continue;
    const id = partText(p.id ?? p.slug ?? p.key).trim();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) continue;
    const name = partText(p.name ?? p.mpn ?? p.title).trim() || id;
    const category = partText(p.category);
    const family = partText(p.family);
    const manufacturer = partText(p.manufacturer ?? p.brand);
    const keywords = partText(p.keywords ?? p.tags);
    const params = object(p.parameters) ?? {};
    const pinsValue = Number(p.pins ?? p.pin_count ?? p.pad_count ?? params.contacts);
    const pins = Number.isFinite(pinsValue) && pinsValue > 0 ? pinsValue : undefined;
    const mpn = partText(p.mpn_pattern ?? p.mpn);
    const searchText = normalizePartText([
      id, name, category, family, manufacturer, keywords, mpn,
      p.description, p.package, params.mounting, params.orientation,
    ].map(partText).filter(Boolean).join(' '));
    parts.push({
      id, name, category, family, manufacturer, keywords, mpn,
      ...(pins ? { pins } : {}),
      verified: p.verified ?? p.status,
      page: partText(p.page),
      searchText,
    });
  }
  const totalValue = Number(root?.count);
  return { total: Number.isFinite(totalValue) && totalValue >= parts.length ? totalValue : parts.length, parts };
}

/** Search all metadata on the server and return only the best `limit` matches. */
export function searchPartReel(index, { query, category = 'all', verifiedOnly = false, limit = 40 } = {}) {
  const q = normalizePartText(query);
  if (!q) return { total: index.total, count: 0, results: [] };
  const tokens = q.split(/\s+/).filter(Boolean);
  const boundedLimit = Math.max(1, Math.min(40, Math.round(Number(limit) || 40)));
  const matches = [];
  let count = 0;
  for (const part of index.parts) {
    if (!tokens.every((token) => part.searchText.includes(token))) continue;
    if (verifiedOnly && !partVerified(part.verified)) continue;
    if (category === 'smd' && !SMD_RE.test(part.searchText)) continue;
    if (category === 'modules' && !MODULE_RE.test(part.searchText)) continue;
    count++;
    const title = normalizePartText(`${part.name} ${part.mpn}`);
    const id = normalizePartText(part.id);
    let score = 0;
    if (title === q) score += 120;
    if (id === q) score += 110;
    if (title.startsWith(q)) score += 75;
    if (id.startsWith(q)) score += 65;
    if (title.includes(q)) score += 35;
    if (part.searchText.includes(q)) score += 10;
    if (partVerified(part.verified)) score += 1;
    matches.push({ part, score });
  }
  matches.sort((a, b) => b.score - a.score || a.part.name.localeCompare(b.part.name));
  return {
    total: index.total,
    count,
    results: matches.slice(0, boundedLimit).map(({ part }) => ({
      id: part.id,
      name: part.name,
      category: part.category,
      family: part.family,
      manufacturer: part.manufacturer,
      keywords: part.keywords,
      verified: part.verified,
      ...(part.pins ? { pins: part.pins } : {}),
      ...(part.mpn ? { mpn_pattern: part.mpn } : {}),
      ...(part.page ? { page: part.page } : {}),
    })),
  };
}
