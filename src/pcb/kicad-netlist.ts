// Безопасный разбор KiCad S-expression netlist (.net) и сопоставление с деталями платы.
import type { Comp, Doc, Net } from './model';
import { uid } from './model';

export interface KicadNetlistComponent {
  ref: string;
  value: string;
  footprint: string;
}
export interface KicadNetlistNode { ref: string; pin: string }
export interface KicadNetlistNet { name: string; code: string; nodes: KicadNetlistNode[] }
export interface KicadNetlist {
  components: KicadNetlistComponent[];
  nets: KicadNetlistNet[];
}
export interface KicadNetlistImport {
  nets: Net[];
  componentUpdates: Map<string, Partial<Comp>>;
  matchedComponents: number;
  matchedPads: number;
  unmatchedRefs: string[];
  unmatchedPins: string[];
  warnings: string[];
}

type SExpr = string | SExpr[];
const MAX_SOURCE = 10 * 1024 * 1024;
const MAX_TOKENS = 1_000_000;
const MAX_DEPTH = 160;

function tokenize(source: string): string[] {
  if (source.length > MAX_SOURCE) throw new Error('Netlist KiCad слишком большой (лимит 10 МБ).');
  const out: string[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';') { while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++; continue; }
    if (c === '(' || c === ')') { out.push(c); i++; continue; }
    if (c === '"') {
      i++;
      let text = '', closed = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '"') { closed = true; break; }
        if (ch === '\\' && i < source.length) {
          const e = source[i++];
          text += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e;
        } else text += ch;
      }
      if (!closed) throw new Error('В netlist KiCad не закрыта строка в кавычках.');
      out.push(text);
    } else {
      const start = i;
      while (i < source.length && !/[\s();]/.test(source[i])) i++;
      if (i === start) throw new Error('Не удалось прочитать netlist KiCad.');
      out.push(source.slice(start, i));
    }
    if (out.length > MAX_TOKENS) throw new Error('В netlist KiCad слишком много данных.');
  }
  return out;
}

function parseTree(tokens: string[]): SExpr {
  const stack: SExpr[][] = [];
  let root: SExpr | null = null;
  for (const token of tokens) {
    if (token === '(') {
      if (stack.length >= MAX_DEPTH) throw new Error('Netlist KiCad слишком глубоко вложен.');
      const node: SExpr[] = [];
      if (stack.length) stack[stack.length - 1].push(node);
      else if (root === null) root = node;
      else throw new Error('В netlist KiCad найдено несколько корневых выражений.');
      stack.push(node);
    } else if (token === ')') {
      if (!stack.length) throw new Error('В netlist KiCad лишняя закрывающая скобка.');
      stack.pop();
    } else {
      if (!stack.length) throw new Error('В netlist KiCad найден текст вне выражения.');
      stack[stack.length - 1].push(token);
    }
  }
  if (stack.length || !root) throw new Error('Netlist KiCad неполный или пустой.');
  return root;
}
const list = (v: SExpr | undefined): SExpr[] | null => Array.isArray(v) ? v : null;
const atom = (v: SExpr | undefined): string => typeof v === 'string' ? v : '';
function child(node: SExpr[] | null, key: string): SExpr[] | null {
  if (!node) return null;
  for (const item of node) {
    const row = list(item);
    if (row && atom(row[0]) === key) return row;
  }
  return null;
}
function children(node: SExpr[] | null, key: string): SExpr[][] {
  if (!node) return [];
  const out: SExpr[][] = [];
  for (const item of node) {
    const row = list(item);
    if (row && atom(row[0]) === key) out.push(row);
  }
  return out;
}
const field = (node: SExpr[] | null, key: string): string => atom(child(node, key)?.[1]);

export function parseKicadNetlist(source: string): KicadNetlist {
  const root = list(parseTree(tokenize(source)));
  if (!root || atom(root[0]) !== 'export') throw new Error('Файл не похож на netlist KiCad (.net).');
  const componentRoot = child(root, 'components');
  const components = children(componentRoot, 'comp').map((comp) => ({
    ref: field(comp, 'ref'), value: field(comp, 'value'), footprint: field(comp, 'footprint'),
  })).filter((c) => c.ref).slice(0, 100_000);
  const netRoot = child(root, 'nets');
  const nets = children(netRoot, 'net').map((net) => ({
    code: field(net, 'code'), name: field(net, 'name') || `N$${field(net, 'code') || '?'}`,
    nodes: children(net, 'node').map((n) => ({ ref: field(n, 'ref'), pin: field(n, 'pin') })).filter((n) => n.ref && n.pin),
  })).filter((n) => n.nodes.length);
  if (!componentRoot && !netRoot) throw new Error('В netlist нет разделов components и nets.');
  return { components, nets };
}

function embeddedPinMap(comp: Comp): Map<string, string> {
  const pins = new Map<string, string>();
  (comp.ents ?? []).forEach((e, index) => {
    if ((e.kind === 'pad' || e.kind === 'smd') && e.pin && !pins.has(e.pin)) pins.set(e.pin, `${comp.id}:${index}`);
  });
  return pins;
}

/** Map all nodes to expanded component-pad IDs. Unmapped pins are preserved as warnings, never guessed by coordinates. */
export function mapKicadNetlist(netlist: KicadNetlist, doc: Doc): KicadNetlistImport {
  const comps = doc.entities.filter((e): e is Comp => e.kind === 'comp');
  const byRef = new Map<string, Comp>();
  const duplicateRefs = new Set<string>();
  for (const comp of comps) {
    const ref = (comp.ref ?? '').trim().toLocaleUpperCase();
    if (!ref) continue;
    if (byRef.has(ref)) duplicateRefs.add(ref);
    else byRef.set(ref, comp);
  }
  const pinMaps = new Map(comps.map((comp) => [comp.id, embeddedPinMap(comp)]));
  const netlistByRef = new Map(netlist.components.map((comp) => [comp.ref.toLocaleUpperCase(), comp]));
  const componentUpdates = new Map<string, Partial<Comp>>();
  let matchedComponents = 0;
  for (const [ref, source] of netlistByRef) {
    const target = byRef.get(ref);
    if (!target || duplicateRefs.has(ref)) continue;
    matchedComponents++;
    componentUpdates.set(target.id, {
      ...(source.value ? { value: source.value } : {}),
      ...(source.footprint ? { footprint: source.footprint } : {}),
    });
  }
  const unmatchedRefs = new Set<string>();
  const unmatchedPins = new Set<string>();
  const warnings: string[] = [];
  for (const ref of duplicateRefs) warnings.push(`Обозначение ${ref} встречается на плате несколько раз; выводы не сопоставлены.`);
  let matchedPads = 0;
  const nets: Net[] = [];
  for (const net of netlist.nets) {
    const pads: string[] = [];
    const seen = new Set<string>();
    for (const node of net.nodes) {
      const ref = node.ref.toLocaleUpperCase();
      const comp = byRef.get(ref);
      if (!comp || duplicateRefs.has(ref)) { unmatchedRefs.add(node.ref); continue; }
      const padId = pinMaps.get(comp.id)?.get(node.pin);
      if (!padId) { unmatchedPins.add(`${node.ref}.${node.pin}`); continue; }
      if (!seen.has(padId)) { seen.add(padId); pads.push(padId); matchedPads++; }
    }
    if (pads.length >= 2) nets.push({ id: uid(), name: net.name, pads, source: 'kicad' });
    else if (pads.length === 1) warnings.push(`Цепь «${net.name}» имеет только один сопоставленный вывод; группа не создана.`);
  }
  if (unmatchedRefs.size) warnings.push(`На плате не найдены обозначения: ${[...unmatchedRefs].sort().slice(0, 12).join(', ')}${unmatchedRefs.size > 12 ? '…' : ''}.`);
  if (unmatchedPins.size) warnings.push(`Не найдены номера выводов: ${[...unmatchedPins].sort().slice(0, 12).join(', ')}${unmatchedPins.size > 12 ? '…' : ''}.`);
  return { nets, componentUpdates, matchedComponents, matchedPads, unmatchedRefs: [...unmatchedRefs], unmatchedPins: [...unmatchedPins], warnings };
}

/** Replace older imported groups; manual groups overlapping imported pads are dropped to avoid double ownership. */
export function mergeImportedNets(existing: Net[], incoming: Net[]): { nets: Net[]; removedManual: string[] } {
  const incomingPads = new Set(incoming.flatMap((n) => n.pads));
  const removedManual = existing.filter((n) => n.source !== 'kicad' && n.pads.some((p) => incomingPads.has(p))).map((n) => n.name);
  const manual = existing.filter((n) => n.source !== 'kicad' && !n.pads.some((p) => incomingPads.has(p)));
  return { nets: [...manual, ...incoming], removedManual };
}
