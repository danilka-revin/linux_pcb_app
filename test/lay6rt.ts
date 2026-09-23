import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLay6, lay6ToDoc, docToLay6, lmkToEnts, entsToLmk, LAY_TYPE } from '../src/pcb/lay6';
import * as M from '../src/pcb/model';
import { expandDoc } from '../src/pcb/expand';

let n = 0;
const ok = (cond: boolean, msg: string): void => {
  n++;
  if (!cond) { console.error('✗ FAIL:', msg); process.exit(1); }
};

// 1. реальный файл Sprint-Layout → doc → lay6 → парсинг
const fx = (n: string) => {
  for (const dir of [process.env.XLAY_FIXTURES || '', join(process.cwd(), 'test/fixtures'), '/tmp/xlay']) {
    try { return readFileSync(join(dir, n)); } catch { /* следующий */ }
  }
  throw new Error('нет испытательного файла ' + n);
};
const buf = new Uint8Array(fx('test1.lay6'));
const src = parseLay6(buf);
const { doc, warnings } = lay6ToDoc(buf);
console.log('импорт test1.lay6:', doc.entities.length, 'сущностей, предупреждений:', warnings.length);
ok(doc.entities.length > 400, 'im:1 много сущностей');
const texts = doc.entities.filter((e) => e.kind === 'text') as M.TextE[];
ok(texts.length >= 40, 'im:2 тексты');
const t90 = texts.find((t) => t.text === 'IR2110')!;
ok(t90 && Math.abs(t90.rot - 270) < 1, 'im:3 поворот 90CW→270CCW, получил ' + t90?.rot);
const t270 = texts.find((t) => t.text === '10K')!;
ok(t270 && Math.abs(t270.rot - 90) < 1, 'im:4 поворот 270CW→90CCW, получил ' + t270?.rot);

const out = docToLay6(doc, expandDoc(doc.entities));
try { writeFileSync(join(process.cwd(), 'node_modules/.cache/test1-rt.lay6'), Buffer.from(out)); } catch { /* отладочный артефакт, не критично */ }
const src2 = parseLay6(out);
ok(src2.boards.length === 1, 'rt:1 одна доска');
ok(Math.abs(src2.boards[0].w - 60) < 0.2 && Math.abs(src2.boards[0].h - 50) < 0.2, 'rt:2 размер платы ' + src2.boards[0].w + 'x' + src2.boards[0].h);
ok(src2.projectName === doc.name, 'rt:3 имя проекта CP1251: ' + src2.projectName);
const objs2 = src2.boards[0].objects;
ok(objs2.length >= src.boards[0].objects.length - 20, 'rt:4 объекты ' + objs2.length + ' vs ' + src.boards[0].objects.length);
const texts2 = objs2.filter((o) => o.type === LAY_TYPE.TEXT);
ok(texts2.length === texts.length, 'rt:5 тексты ' + texts2.length + '/' + texts.length);
const t90b = texts2.find((t) => t.text === 'IR2110')!;
ok(t90b && t90b.thzise === 90, 'rt:6 thzise обратно в 90CW, получил ' + t90b?.thzise);
ok(t90b.children.length > 0, 'rt:7 глифы записаны');
ok(texts2.every((t) => t.children.length > 0), 'rt:8 у всех текстов глифы');

// 2. второй круг doc→lay6→doc
const { doc: doc2 } = lay6ToDoc(out);
ok(doc2.entities.length === doc.entities.length, 'rt:9 второй круг: ' + doc2.entities.length + ' === ' + doc.entities.length);
const sz = (d: M.Doc, kind: string) => d.entities.filter((e) => e.kind === kind) as (M.PadE | M.HoleE)[];
const pads1 = sz(doc2, 'pad') as M.PadE[], pads0 = sz(doc, 'pad') as M.PadE[];
ok(pads1.length === pads0.length && pads1.every((p, i) => Math.abs(p.size - pads0[i].size) < 0.01 && Math.abs(p.drill - pads0[i].drill) < 0.01), 'rt:10 размеры падов сохранены');
const h1 = sz(doc2, 'hole') as M.HoleE[], h0 = sz(doc, 'hole') as M.HoleE[];
ok(h1.length === h0.length && h1.every((p, i) => Math.abs(p.d - h0[i].d) < 0.01), 'rt:11 диаметры отверстий сохранены');

// 3. макрос lmk
const sel = doc.entities.slice(0, 30).map((e) => ({ ...e, id: M.uid() }));
const lmk = entsToLmk(sel);
ok(new DataView(lmk.buffer, lmk.byteOffset).getUint32(0, true) === 0xFFAA3306, 'lmk:1 магия');
const re = lmkToEnts(lmk);
ok(re.ents.length === sel.length, 'lmk:2 количество ' + re.ents.length + '/' + sel.length);
const bb = (ents: M.Entity[]) => M.unionBBox(ents.map((e) => M.entBBox(e)));
const [a1, b1, a2, b2] = bb(re.ents);
ok(Math.abs((a1 + a2) / 2) < 0.05 && Math.abs((b1 + b2) / 2) < 0.05, 'lmk:3 макрос перецентрирован в (0,0)');
const hd = (ents: M.Entity[]) => (ents.filter((e) => e.kind === 'hole') as M.HoleE[]).map((h) => h.d).sort((a, c) => a - c);
ok(JSON.stringify(hd(sel)) === JSON.stringify(hd(re.ents)), 'lmk:4 диаметры отверстий в макросе');
const tsel = sel.filter((e) => e.kind === 'text') as M.TextE[];
const tre = re.ents.filter((e) => e.kind === 'text') as M.TextE[];
if (tsel.length) { ok(tsel.length === tre.length, 'lmk:4 тексты'); ok(tsel.every((t, i) => t.text === tre[i].text && Math.abs(t.rot - tre[i].rot) < 1), 'lmk:5 тексты и повороты'); }
console.log('✓ ВСЕ ПРОШЛО (' + n + ' проверок): lay6/lmk roundtrip');
