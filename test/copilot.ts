// Проверка PCB-помощника («разводка словами»): разбиение реплик на команды,
// разбор русского языка и выполнение команд на документе.
import * as M from '../src/pcb/model';
import {
  execCopilot, parseCopilot, splitClauses,
  type CopilotCtx,
} from '../src/pcb/copilot';
import type { Comp } from '../src/pcb/model';

const fails: string[] = [];
const ok = (c: boolean, m: string): void => {
  if (!c) {
    fails.push(m);
    console.error('FAIL:', m);
  }
};

const ctxOf = (doc: M.Doc, extra?: Partial<CopilotCtx>): CopilotCtx => ({
  center: { x: doc.w / 2, y: doc.h / 2 },
  w: doc.w,
  h: doc.h,
  activeCu: 'k1',
  trackW: 0.6,
  selIds: [],
  lastIds: [],
  ...extra,
});

const run = (doc: M.Doc, text: string, extra?: Partial<CopilotCtx>) =>
  execCopilot(doc, parseCopilot(text), ctxOf(doc, extra));

const compsOf = (d: M.Doc): Comp[] => d.entities.filter((e): e is Comp => e.kind === 'comp');
const tracksOf = (d: M.Doc): M.Track[] => d.entities.filter((e): e is M.Track => e.kind === 'track');

// ------------------------------------------------ разбиение на команды
{
  const cl = splitClauses('Поставь 4 светодиода в ряд через 5 мм и соедини катоды');
  ok(cl.length === 2, `split «и»: ждали 2, получили ${cl.length}: ${JSON.stringify(cl)}`);
  const cl2 = splitClauses('плата 60x40. отверстия м3 по углам; текст «v1»');
  ok(cl2.length === 3, `split «.;»: ждали 3, получили ${cl2.length}: ${JSON.stringify(cl2)}`);
  const cl3 = splitClauses('соедини D1.2 с D2.1');
  ok(cl3.length === 1, `split не должен рвать «D1.2»: ${JSON.stringify(cl3)}`);
  const cl4 = splitClauses('поставь dip 8, потом соедини их');
  ok(cl4.length === 2, `split «потом»: ждали 2, получили ${cl4.length}: ${JSON.stringify(cl4)}`);
  const cl5 = splitClauses('дорожка от 10 20 до 30 40 шириной 0.5');
  ok(cl5.length === 1, `split не должен рвать «0.5»: ${JSON.stringify(cl5)}`);
}

// ---------------------------------------------------------------- разбор
{
  const c = parseCopilot('поставь 4 светодиода в ряд через 5 мм')[0];
  ok(c.t === 'place' && c.count === 4 && c.arrangement === 'row' && c.step === 5, `place: ${JSON.stringify(c)}`);

  const n = parseCopilot('поставь четыре кнопки')[0];
  ok(n.t === 'place' && n.count === 4, `числительное «четыре»: ${JSON.stringify(n)}`);

  const d = parseCopilot('dip 8')[0];
  ok(d.t === 'place' && d.count === 1, `«dip 8» — одна деталь: ${JSON.stringify(d)}`);

  const s = parseCopilot('0805')[0];
  ok(s.t === 'place' && s.count === 1, `«0805» — одна деталь: ${JSON.stringify(s)}`);

  const g = parseCopilot('сетка 2x3 резистора 0805')[0];
  ok(g.t === 'place' && g.arrangement === 'grid' && g.rows === 2 && g.cols === 3 && g.count === 6, `сетка: ${JSON.stringify(g)}`);

  const r = parseCopilot('поставь разъем 2x5 справа')[0];
  ok(r.t === 'place' && r.count === 1 && r.anchor.t === 'corner' && r.anchor.h === 'r', `разъём справа: ${JSON.stringify(r)}`);

  const v = parseCopilot('поставь 3 перехода')[0];
  ok(v.t === 'via' && v.count === 3, `переходы: ${JSON.stringify(v)}`);

  const c1 = parseCopilot('соедини катоды и аноды')[0];
  ok(c1.t === 'connect' && c1.picks.length === 2, `катоды и аноды: ${JSON.stringify(c1)}`);

  const c2 = parseCopilot('соедини D1.2 с R2.1 дорожкой 0.5 по низу')[0];
  ok(c2.t === 'connect' && c2.pairs?.length === 2 && c2.width === 0.5 && c2.layer === 'k2', `пары: ${JSON.stringify(c2)}`);

  const t = parseCopilot('дорожка от 10 20 до 30 40 шириной 0.6')[0];
  ok(t.t === 'track' && t.pts.length === 2 && t.width === 0.6, `дорожка: ${JSON.stringify(t)}`);

  const x = parseCopilot('текст «Плата v1» снизу')[0];
  ok(x.t === 'text' && x.text === 'Плата v1' && x.bottom, `текст: ${JSON.stringify(x)}`);

  const b = parseCopilot('плата 60x40')[0];
  ok(b.t === 'board' && b.w === 60 && b.h === 40, `плата: ${JSON.stringify(b)}`);

  const h = parseCopilot('отверстия м3 по углам')[0];
  ok(h.t === 'corners' && Math.abs(h.d - 3.2) < 1e-9, `углы: ${JSON.stringify(h)}`);

  const del = parseCopilot('удали всё')[0];
  ok(del.t === 'delete' && del.target.t === 'all', `удали всё: ${JSON.stringify(del)}`);

  const u = parseCopilot('отмени')[0];
  ok(u.t === 'undo', `отмени: ${JSON.stringify(u)}`);

  const hp = parseCopilot('что ты умеешь')[0];
  ok(hp.t === 'help', `помощь: ${JSON.stringify(hp)}`);

  const rot = parseCopilot('поверни их на 180')[0];
  ok(rot.t === 'rotate' && rot.times === 2, `поворот: ${JSON.stringify(rot)}`);

  const mv = parseCopilot('сдвинь влево на 2')[0];
  ok(mv.t === 'move' && mv.dx === -2 && mv.dy === 0, `сдвиг: ${JSON.stringify(mv)}`);

  const unk = parseCopilot('абракадабра швабра');
  ok(unk.length === 0, `мусор не парсится: ${JSON.stringify(unk)}`);
}

// ---------------------------------------------------- установка и связи
{
  const doc = M.newBoard(100, 80, 'Тест');
  const r = run(doc, 'поставь 4 светодиода 5мм в ряд через 5 мм');
  ok(r.changed && r.lines.length === 1 && r.lines[0].ok, `place ok: ${JSON.stringify(r.lines)}`);
  const comps = compsOf(r.doc);
  ok(comps.length === 4, `4 компонента, получили ${comps.length}`);
  ok(comps.map((c) => c.ref).join(',') === 'D1,D2,D3,D4', `обозначения: ${comps.map((c) => c.ref)}`);
  const xs = comps.map((c) => c.x);
  ok(JSON.stringify(xs) === JSON.stringify([42.5, 47.5, 52.5, 57.5]), `ряд через 5: ${xs}`);
  ok(comps.every((c) => c.y === 40), `все на y=40: ${comps.map((c) => c.y)}`);
  ok(r.lastIds.length === 4 && (r.select?.length ?? 0) === 4, 'память и выделение обновлены');

  // катоды — правые площадки (квадратные у LED)
  const r2 = run(r.doc, 'соедини катоды', { lastIds: r.lastIds });
  ok(r2.changed && r2.lines[0].ok, `connect ok: ${JSON.stringify(r2.lines)}`);
  const tr = tracksOf(r2.doc);
  ok(tr.length === 1 && tr[0].pts.length === 4, `одна дорожка на 4 точки: ${tr.length}`);
  ok(tr[0].layer === 'k2', `выводные паяются снизу: ${tr[0].layer}`);
  ok((r2.doc.nets?.length ?? 0) === 1 && (r2.doc.nets?.[0].pads.length ?? 0) === 4, 'цепь создана');
  ok(r2.doc.nets?.[0].name === 'Катоды', `имя цепи: ${r2.doc.nets?.[0].name}`);
  const cathX = tr[0].pts.map((p) => p.x);
  ok(cathX.every((x, i) => x > comps[i].x), `катоды справа от центров: ${cathX}`);
}

// цепочка одной репликой: «поставь … и соедини»
{
  const doc = M.newBoard(100, 80, 'Тест');
  const r = run(doc, 'поставь 2 резистора 0805 в ряд через 4 и соедини их');
  ok(r.lines.length === 2 && r.lines.every((l) => l.ok), `цепочка: ${JSON.stringify(r.lines)}`);
  ok(tracksOf(r.doc).length === 1, 'дорожка соединила поставленное');
}

// «катоды и аноды» — две цепочки
{
  const doc = M.newBoard(100, 80, 'Тест');
  const p = run(doc, 'поставь 3 светодиода');
  const r = run(p.doc, 'соедини катоды и аноды', { lastIds: p.lastIds });
  ok(tracksOf(r.doc).length === 2, `две цепочки: ${tracksOf(r.doc).length}`);
  ok((r.doc.nets?.length ?? 0) === 2, 'две цепи');
}

// явная пара по обозначениям
{
  const doc = M.newBoard(100, 80, 'Тест');
  const p = run(doc, 'поставь 2 светодиода');
  const r = run(p.doc, 'соедини D1.2 с D2.1 дорожкой 0.5', { lastIds: p.lastIds });
  ok(r.lines[0].ok, `пара: ${JSON.stringify(r.lines)}`);
  const tr = tracksOf(r.doc);
  ok(tr.length === 1 && tr[0].w === 0.5 && tr[0].pts.length === 2, 'дорожка D1.2→D2.1');
}

// ------------------------------------------------------------ примитивы
{
  const doc = M.newBoard(100, 80, 'Тест');
  const v = run(doc, 'поставь 3 перехода в ряд через 3');
  const vias = v.doc.entities.filter((e) => e.kind === 'via');
  ok(vias.length === 3, `3 перехода: ${vias.length}`);

  const t = run(doc, 'текст «V1» снизу высотой 2.5');
  const te = t.doc.entities.find((e) => e.kind === 'text');
  ok(!!te && te.kind === 'text' && te.layer === 's2' && te.mirror && te.size === 2.5, `текст снизу: ${JSON.stringify(te)}`);

  const c = run(doc, 'отверстия м3 по углам');
  const holes = c.doc.entities.filter((e) => e.kind === 'hole');
  ok(holes.length === 4 && holes.every((e) => e.kind === 'hole' && Math.abs(e.d - 3.2) < 1e-9), '4 отверстия м3');

  const b = run(doc, 'плата 60x40');
  ok(b.doc.w === 60 && b.doc.h === 40, 'размер платы');
  const outline = b.doc.entities.find((e) => e.kind === 'rect' && e.layer === 'outline');
  ok(!!outline && outline.kind === 'rect' && outline.w === 60 && outline.h === 40, 'контур подтянулся');

  const tr = run(doc, 'дорожка от 10 20 до 30 40');
  const trs = tracksOf(tr.doc);
  ok(trs.length === 1 && trs[0].pts.length === 2 && trs[0].layer === 'k1', 'дорожка по координатам');
}

// ---------------------------------------------------------------- правка
{
  const doc = M.newBoard(100, 80, 'Тест');
  const p = run(doc, 'поставь 2 светодиода');
  ok(compsOf(p.doc).length === 2, 'подготовка: 2 диода');

  const del = run(p.doc, 'удали D1');
  ok(compsOf(del.doc).length === 1 && compsOf(del.doc)[0].ref === 'D2', 'удалён D1');

  const dup = run(p.doc, 'продублируй', { selIds: p.lastIds.slice(0, 1) });
  ok(compsOf(dup.doc).length === 3, `дубль: ${compsOf(dup.doc).length}`);

  const before = compsOf(p.doc)[0];
  const mv = run(p.doc, 'сдвинь D1 влево на 2');
  const after = compsOf(mv.doc).find((c) => c.ref === 'D1');
  ok(!!after && Math.abs(after.x - (before.x - 2)) < 1e-9, 'сдвиг D1');

  const rt = run(p.doc, 'поверни D2 на 90');
  const r2 = compsOf(rt.doc).find((c) => c.ref === 'D2');
  ok(!!r2 && r2.rot === 90, 'поворот D2');

  const al = run(p.doc, 'удали всё');
  ok(al.doc.entities.every((e) => e.kind === 'rect'), 'плата очищена');

  const u = run(p.doc, 'отмени');
  ok(!u.changed && u.effects.length === 1 && u.effects[0].t === 'undo', 'эффект отмены');

  const f = run(p.doc, 'покажи всю плату');
  ok(f.effects.length === 1 && f.effects[0].t === 'fit', 'эффект обзора');

  const h = run(p.doc, 'что ты умеешь');
  ok(!h.changed && h.lines[0].ok && h.lines[0].text.includes('соедини'), 'справка');
}

// --------------------------------------------------------------- ошибки
{
  const doc = M.newBoard(100, 80, 'Тест');
  const e1 = run(doc, 'соедини катоды');
  ok(!e1.lines[0].ok, `соединять нечего: ${JSON.stringify(e1.lines)}`);
  const e2 = run(doc, 'поставь квантовый флюксуатор');
  ok(!e2.changed && !e2.lines[0].ok, `неизвестная деталь: ${JSON.stringify(e2.lines)}`);
  const e3 = run(doc, '');
  ok(!e3.changed && e3.lines.length === 1, 'пустая команда');
}

if (fails.length) {
  console.error(`\nПомощник: ${fails.length} ошибок`);
  process.exit(1);
} else {
  console.log('Помощник: все проверки прошли');
}
