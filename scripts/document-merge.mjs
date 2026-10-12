// Трёхстороннее слияние JSON-документов плат для совместного редактирования.
// Независимые изменения разных объектов/полей объединяются; изменения одного
// поля с разных вкладок отклоняются с перечнем конфликтных путей.
const MISSING = Symbol('missing');

function addConflict(conflicts, path) { conflicts.push(String(path || '(документ)').slice(0, 160)); }

function copy(value) {
  if (value === MISSING) return MISSING;
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[key] = copy(item);
    return out;
  }
  return value;
}

function equal(a, b) {
  if (a === b) return true;
  if (a === MISSING || b === MISSING || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && equal(a[key], b[key]));
}

function byId(array) {
  if (!Array.isArray(array) || !array.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string')) return null;
  const map = new Map();
  for (const item of array) {
    if (map.has(item.id)) return null;
    map.set(item.id, item);
  }
  return map;
}

function mergeSet(base, local, remote) {
  const b = new Set(base), l = new Set(local), r = new Set(remote);
  const values = new Set([...base, ...local, ...remote]);
  const result = new Set();
  for (const value of values) {
    const bv = b.has(value), lv = l.has(value), rv = r.has(value);
    if (lv === bv ? rv : rv === bv ? lv : lv) result.add(value);
  }
  // Preserve server order, then append items added only by this client.
  return [...remote.filter((item) => result.has(item)), ...local.filter((item) => result.has(item) && !r.has(item))];
}

function mergeIdentifiedArray(base, local, remote, path, conflicts) {
  const bm = byId(base), lm = byId(local), rm = byId(remote);
  const merged = new Map();
  const ids = new Set([...bm.keys(), ...lm.keys(), ...rm.keys()]);
  for (const id of ids) {
    const value = mergeValue(bm.has(id) ? bm.get(id) : MISSING,
      lm.has(id) ? lm.get(id) : MISSING, rm.has(id) ? rm.get(id) : MISSING,
      `${path}[${id}]`, conflicts);
    if (value !== MISSING) merged.set(id, value);
  }

  // Array order determines visual stacking for board objects. Respect a reorder
  // made on one side, merge additions from the other side, and reject competing
  // incompatible reorders instead of silently changing the drawing order.
  const localIds = new Set(local.map((item) => item.id));
  const remoteIds = new Set(remote.map((item) => item.id));
  const sharedBase = base.map((item) => item.id).filter((id) => localIds.has(id) && remoteIds.has(id));
  const sharedSet = new Set(sharedBase);
  const localOrder = local.map((item) => item.id).filter((id) => sharedSet.has(id));
  const remoteOrder = remote.map((item) => item.id).filter((id) => sharedSet.has(id));
  const localReordered = !equal(sharedBase, localOrder);
  const remoteReordered = !equal(sharedBase, remoteOrder);
  if (localReordered && remoteReordered && !equal(localOrder, remoteOrder)) addConflict(conflicts, `${path} (порядок объектов)`);

  const primary = localReordered && !remoteReordered ? local : remote;
  const secondary = primary === local ? remote : local;
  const order = [];
  const ordered = new Set();
  for (const item of primary) if (merged.has(item.id) && !ordered.has(item.id)) { order.push(item.id); ordered.add(item.id); }
  for (const item of secondary) if (merged.has(item.id) && !ordered.has(item.id)) { order.push(item.id); ordered.add(item.id); }
  for (const id of merged.keys()) if (!ordered.has(id)) { order.push(id); ordered.add(id); }
  return order.map((id) => merged.get(id));
}

function mergeValue(base, local, remote, path, conflicts) {
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base)) return copy(local);
  if (equal(local, remote)) return copy(local);

  if (base !== MISSING && Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    if (base.every((item) => typeof item === 'string') && local.every((item) => typeof item === 'string') && remote.every((item) => typeof item === 'string')) {
      return mergeSet(base, local, remote);
    }
    if (byId(base) && byId(local) && byId(remote)) return mergeIdentifiedArray(base, local, remote, path, conflicts);
    addConflict(conflicts, path);
    return copy(remote);
  }

  if (base !== MISSING && base && local && remote
    && typeof base === 'object' && typeof local === 'object' && typeof remote === 'object'
    && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(remote)) {
    const result = Object.create(null);
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const value = mergeValue(
        Object.hasOwn(base, key) ? base[key] : MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
        path ? `${path}.${key}` : key, conflicts,
      );
      if (value !== MISSING) result[key] = value;
    }
    return result;
  }

  // A concurrently added object can still be merged field-by-field when both
  // sides used the same stable ID, even though it had no value in the base.
  if (base === MISSING && local && remote && typeof local === 'object' && typeof remote === 'object'
    && !Array.isArray(local) && !Array.isArray(remote)) {
    const result = Object.create(null);
    const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const value = mergeValue(MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
        path ? `${path}.${key}` : key, conflicts);
      if (value !== MISSING) result[key] = value;
    }
    return result;
  }

  addConflict(conflicts, path);
  return copy(remote);
}

/**
 * @param {object} base - document both clients started from
 * @param {object} local - current document in the saving client
 * @param {object} remote - latest document stored by the server
 * @returns {{ ok: boolean, document: object, conflicts: string[] }}
 */
export function mergeDocuments(base, local, remote) {
  const conflicts = [];
  const document = mergeValue(base, local, remote, '', conflicts);
  return { ok: conflicts.length === 0, document, conflicts: [...new Set(conflicts)].slice(0, 30) };
}

/** Deep equality for JSON-compatible values, independent of object key order. */
export function documentsEqual(a, b) { return equal(a, b); }
