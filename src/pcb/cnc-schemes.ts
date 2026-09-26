// Схемы к экспорту на станок: SVG-чертежи «что за что отвечает».
// Чистый модуль без React — схемы рисуются строками и используются в двух местах:
//   1) интерактивные схемы в диалоге ЧПУ (src/ui/cnc-schemes.tsx),
//   2) файл 00b_SHEMY_PARAMETROV.svg внутри скачиваемого CNC ZIP.
// У каждого узла есть data-part — на него завязана подсветка при наведении.
import type { Doc } from './model';
import type { CncSettings } from './cnc-settings';

export interface SchemePart {
  id: string;
  /** короткое имя параметра для чипа-легенды */
  label: string;
  /** «за что отвечает» — показывается при наведении */
  hint: string;
}

export interface BuiltScheme {
  id: string;
  title: string;
  svg: string;
  parts: SchemePart[];
  caption: string;
}

const esc = (s: unknown): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v: number): string => String(Number(v.toFixed(3)));
const n2 = (v: number): string => String(Number(v.toFixed(2)));

const T = (x: number, y: number, s: string, cls = 'sch-text', anchor: 'start' | 'middle' | 'end' = 'middle', part?: string): string =>
  `<text x="${n2(x)}" y="${n2(y)}" class="${cls}" text-anchor="${anchor}"${part ? ` data-part="${part}"` : ''}>${esc(s)}</text>`;

const G = (part: string | undefined, body: string): string =>
  part ? `<g data-part="${part}">${body}</g>` : `<g>${body}</g>`;

const R = (x: number, y: number, w: number, h: number, cls: string, rx = 0): string =>
  `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" class="${cls}"${rx ? ` rx="${n2(rx)}"` : ''} />`;

const C = (x: number, y: number, r: number, cls: string): string =>
  `<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(r)}" class="${cls}" />`;

const L = (x1: number, y1: number, x2: number, y2: number, cls = 'sch-dim'): string =>
  `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" class="${cls}" />`;

const arrDefs = (id: string): string =>
  `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">` +
  `<path d="M0 0 L10 5 L0 10 z" class="sch-dim-head" /></marker></defs>`;

const arrLine = (x1: number, y1: number, x2: number, y2: number, arr: string, cls = 'sch-dim'): string =>
  L(x1, y1, x2, y2, cls).replace(`class="${cls}"`, `class="${cls}" marker-start="url(#${arr})" marker-end="url(#${arr})"`);

/** Горизонтальный размер со стрелками; labelDy смещает подпись от линии (по умолчанию на линии). */
const dimH = (x1: number, x2: number, y: number, label: string, arr: string, part?: string, labelDy = 3): string => {
  const mid = (x1 + x2) / 2, half = Math.max(16, label.length * 3.4);
  return G(part,
    arrLine(x1, y, x2, y, arr) +
    R(mid - half, y + labelDy - 8, half * 2, 12, 'sch-dim-bg', 3) +
    T(mid, y + labelDy, label, 'sch-dim-text'));
};

/** Вертикальный размер: подпись слева от линии. */
const dimV = (x: number, y1: number, y2: number, label: string, arr: string, part?: string): string => {
  const mid = (y1 + y2) / 2, half = Math.max(13, label.length * 3.2);
  return G(part,
    arrLine(x, y1, x, y2, arr) +
    R(x - half - 7, mid - 6, half * 2, 12, 'sch-dim-bg', 3) +
    T(x - 7, mid + 3, label, 'sch-dim-text', 'middle'));
};

const stepDepths = (depth: number, step: number): string[] =>
  Array.from({ length: Math.max(1, Math.ceil(depth / step)) }, (_, i) => num(Math.min(depth, (i + 1) * step)));

// ─────────────────────────── 1. Рабочий ноль и отступы ───────────────────────────

export function workZeroScheme(doc: Doc, s: CncSettings): BuiltScheme {
  const arr = 'sch-arr-zero';
  const W = doc.w + 2 * s.originX, H = doc.h + 2 * s.originY;
  const k = Math.min(250 / W, 86 / H);
  const sw = W * k, sh = H * k;
  const sx = 42 + (250 - sw) / 2, sy = 32;
  const bx = sx + s.originX * k, by = sy + sh - (s.originY + doc.h) * k;
  const bw = doc.w * k, bh = doc.h * k;
  const ySurf = 194, kv = 20 / Math.max(s.safeZ, 2), ySafe = ySurf - s.safeZ * kv;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 226" class="scheme-svg-root" role="img" aria-label="Схема рабочего нуля и отступов">${arrDefs(arr)}
    ${T(160, 12, 'Сверху: заготовка и плата в рабочих координатах')}
    ${G('stock', R(sx, sy, sw, sh, 'sch-stock') + T(sx + sw / 2, sy - 6, `заготовка ≥ ${num(W)} × ${num(H)} мм`, 'sch-text'))}
    ${G('board', R(bx, by, bw, bh, 'sch-board', 2) + T(bx + bw / 2, by + bh / 2 + 3, `плата ${num(doc.w)} × ${num(doc.h)} мм`))}
    ${G('origin', C(sx, sy + sh, 3, 'sch-cut') + L(sx - 5, sy + sh, sx + 9, sy + sh, 'sch-cut') + L(sx, sy + sh - 9, sx, sy + sh + 5, 'sch-cut') + T(sx + 12, sy + sh + 11, 'X0 Y0', 'sch-text', 'start'))}
    ${dimH(sx, bx, sy + sh + 11, `a = ${num(s.originX)} мм`, arr, 'originx', 12)}
    ${dimV(sx - 14, sy + sh, by + bh, `b = ${num(s.originY)} мм`, arr, 'originy')}
    ${T(160, 168, 'Сбоку: ноль Z и безопасный подъём')}
    ${G('z0', R(70, ySurf, 180, 12, 'sch-board') + R(70, ySurf - 3, 180, 3, 'sch-copper') + T(62, ySurf + 8, 'Z0', 'sch-text', 'end') + L(66, ySurf, 250, ySurf, 'sch-line'))}
    ${G('safez', L(70, ySafe, 250, ySafe, 'sch-safe') + dimV(282, ySurf, ySafe, `+${num(s.safeZ)} мм`, arr))}
    ${G('clamps', R(74, ySurf - 13, 26, 13, 'sch-clamp') + R(222, ySurf - 13, 26, 13, 'sch-clamp') + T(160, 220, 'зажимы должны быть ниже безопасного Z', 'sch-warn-text'))}
  </svg>`;
  return {
    id: 'zero',
    title: '1. Рабочий ноль и безопасный подъём',
    svg,
    caption: 'Ноль X/Y — левый нижний угол заготовки; плата стоит с отступами a и b.',
    parts: [
      { id: 'origin', label: 'X0 Y0', hint: 'Рабочий ноль станка: левый нижний угол заготовки при взгляде на обрабатываемую сторону. Все координаты G-code считаются от него.' },
      { id: 'originx', label: 'a — отступ X', hint: `Сколько мм от рабочего нуля до левого края платы. Сейчас ${num(s.originX)} мм. Увеличьте, если фреза попадёт в зажимы.` },
      { id: 'originy', label: 'b — отступ Y', hint: `Сколько мм от рабочего нуля до нижнего края платы. Сейчас ${num(s.originY)} мм.` },
      { id: 'board', label: 'плата', hint: `Размер вашей платы ${num(doc.w)} × ${num(doc.h)} мм — прямоугольник, внутри которого идут все операции.` },
      { id: 'stock', label: 'заготовка', hint: `Заготовка должна быть не меньше ${num(W)} × ${num(H)} мм (плата + два отступа).` },
      { id: 'z0', label: 'Z0', hint: 'Ноль Z — поверхность текущей стороны платы. После КАЖДОЙ смены инструмента выставляйте Z0 заново.' },
      { id: 'safez', label: 'безопасный Z', hint: `Подъём над платой +${num(s.safeZ)} мм. На этой высоте идут быстрые перемещения; она должна быть выше зажимов.` },
      { id: 'clamps', label: 'зажимы', hint: 'Зажимы и оснастка обязаны быть ниже безопасного Z — иначе фреза врежется в них при быстром ходе.' },
    ],
  };
}

// ─────────────────────────── 2. Изоляция меди ───────────────────────────

export function isolationScheme(s: CncSettings): BuiltScheme {
  const arr = 'sch-arr-iso';
  const o = 7 + s.toolDiameter * 4 + s.clearance * 8;
  const cutR = Math.max(3.5, s.toolDiameter * 5);
  const depthPx = Math.max(6, s.isolationDepth * 28);
  const need = s.toolDiameter + 2 * s.clearance;
  const gapW = 118;
  const kW = Math.max(10, need > 0 ? (s.toolDiameter / need) * gapW : gapW);
  const cW = Math.max(0, (gapW - kW) / 2);
  const yG = 206, hG = 16, xC1 = 28, wC = 58, xGap = xC1 + wC, xC2 = xGap + gapW;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 248" class="scheme-svg-root" role="img" aria-label="Схема изоляционной фрезеровки">${arrDefs(arr)}
    ${T(86, 12, 'Сверху: обход меди')}
    ${G('copper', R(42, 54, 88, 26, 'sch-copper', 13) + T(86, 71, 'медь K1/K2', 'sch-copper-text'))}
    ${G('path', R(42 - o, 54 - o, 88 + o * 2, 26 + o * 2, 'sch-path', 13 + o))}
    ${G('toold', C(86, 54 - o, cutR, 'sch-tool') + dimH(86 - cutR, 86 + cutR, 54 - o - cutR - 8, `Ø ${num(s.toolDiameter)}`, arr, undefined, -6))}
    ${G('clearance', arrLine(60, 54, 60, 54 - o, arr) + T(55, 54 - o / 2 + 3, `запас ${num(s.clearance)}`, 'sch-text', 'end'))}
    ${G('path', T(86, 104, 'центр фрезы: медь', 'sch-path-text') + T(86, 116, '+ радиус + запас', 'sch-path-text'))}
    ${T(216, 12, 'Сбоку: глубина и подача')}
    ${R(180, 66, 118, 26, 'sch-board')}
    ${G('copper', R(180, 60, 118, 6, 'sch-copper'))}
    ${G('toold', `<path d="M${232 - 14} 30 L${232 + 14} 30 L232 ${60 + depthPx} z" class="sch-tool" />`)}
    ${G('depth', L(202, 60, 202, 60 + depthPx, 'sch-cut') + T(202, 60 + depthPx + 13, `Z-${num(s.isolationDepth)}`, 'sch-cut-text'))}
    ${G('feed', dimH(250, 302, 34, `F${num(s.isolationFeed)}`, arr, undefined, 12))}
    ${G('plunge', arrLine(312, 26, 312, 62, arr) + T(308, 22, `врез F${num(s.isolationPlunge)}`, 'sch-text', 'end'))}
    ${G('rpm', T(186, 108, `шпиндель S${num(s.isolationRpm)} об/мин`, 'sch-text', 'start'))}
    ${T(160, 136, 'V-фреза: ширина реза — это ширина НА глубине Z, не хвостовик.', 'sch-warn-text')}
    ${T(160, 149, 'Одна канавка вокруг меди, не полная зачистка фольги.', 'sch-warn-text')}
    ${T(160, 168, 'Между двумя дорожками: запас + рез + запас')}
    ${G('copper', R(xC1, yG, wC, hG, 'sch-copper', 3) + T(xC1 + wC / 2, yG + 12, 'медь', 'sch-copper-text') +
      R(xC2, yG, wC, hG, 'sch-copper', 3) + T(xC2 + wC / 2, yG + 12, 'медь', 'sch-copper-text'))}
    ${G('clearance', R(xGap, yG, cW, hG, 'sch-keep') + R(xGap + cW + kW, yG, Math.max(0, gapW - cW - kW), hG, 'sch-keep'))}
    ${G('toold', R(xGap + cW, yG, kW, hG, 'sch-kerf') + C(xGap + cW + kW / 2, yG + hG / 2, Math.min(7, kW / 2), 'sch-tool'))}
    ${G('gap', dimH(xGap, xC2, yG - 10, `разделение ${num(need)} мм`, arr, undefined, -6) +
      T(xGap + cW / 2, yG + 28, s.clearance ? `запас ${num(s.clearance)}` : '', 'sch-text') +
      T(xGap + cW + kW / 2, yG + 28, `рез Ø${num(s.toolDiameter)}`, 'sch-cut-text') +
      T(xGap + cW + kW + Math.max(0, gapW - cW - kW) / 2, yG + 28, s.clearance ? `запас ${num(s.clearance)}` : '', 'sch-text'))}
  </svg>`;
  return {
    id: 'iso',
    title: '2. Изоляция: что за что отвечает',
    svg,
    caption: `Разделение меди ${num(need)} мм = рез Ø${num(s.toolDiameter)} + запас ${num(s.clearance)} мм с двух сторон.`,
    parts: [
      { id: 'toold', label: 'ширина реза', hint: `Фреза снимает полосу ${num(s.toolDiameter)} мм. Для V-фрезы это ширина НА глубине реза, не диаметр хвостовика.` },
      { id: 'clearance', label: 'запас до меди', hint: `Воздух ${num(s.clearance)} мм между краем проектной меди и фрезой, чтобы не задеть дорожку.` },
      { id: 'gap', label: 'разделение меди', hint: `Между двумя дорожками нужно минимум ${num(need)} мм свободного места: запас ${num(s.clearance)} + рез ${num(s.toolDiameter)} + запас ${num(s.clearance)}. Это и есть зазор разделения меди.` },
      { id: 'depth', label: 'глубина реза', hint: `Фреза опускается на Z-${num(s.isolationDepth)} от поверхности — снимает фольгу (обычно 0,05…0,2 мм).` },
      { id: 'feed', label: 'подача XY', hint: `Скорость движения фрезы в плоскости — ${num(s.isolationFeed)} мм/мин. Больше — быстрее, но сильнее нагрузка.` },
      { id: 'plunge', label: 'врезание Z', hint: `Скорость погружения в материал — ${num(s.isolationPlunge)} мм/мин. Держите меньше подачи XY.` },
      { id: 'rpm', label: 'обороты S', hint: `Шпиндель ${num(s.isolationRpm)} об/мин. Универсального значения нет — сверяйтесь со своим станком и фрезой.` },
      { id: 'copper', label: 'медь', hint: 'Дорожки и площадки сначала объединяются, чтобы фреза не разрезала их электрическое соединение.' },
      { id: 'path', label: 'ход фрезы', hint: 'Траектория центра фрезы: снаружи объединённой меди на радиус инструмента + указанный запас.' },
    ],
  };
}

// ─────────────────────────── 3. Сверловка ───────────────────────────

export function drillScheme(s: CncSettings): BuiltScheme {
  const arr = 'sch-arr-drill';
  const depths = stepDepths(s.drillDepth, s.drillStep);
  const kv = Math.min(24, 80 / Math.max(s.drillDepth, 1));
  const ySurf = 122, depthSpan = s.drillDepth * kv;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 224" class="scheme-svg-root" role="img" aria-label="Схема сверловки">${arrDefs(arr)}
    ${T(160, 12, 'Сверху: с какой стороны сверлить')}
    ${G('drillside', R(20, 24, 130, 44, s.drillSide === 'top' ? 'sch-sel' : 'sch-stock', 4) + T(85, 42, 'сверху (до переворота)', 'sch-text') + T(85, 57, 'X = a + x', 'sch-text') +
      R(170, 24, 130, 44, s.drillSide === 'bottom' ? 'sch-sel' : 'sch-stock', 4) + T(235, 42, 'снизу (после переворота)', 'sch-text') + T(235, 57, 'X = a + w − x, зеркало', 'sch-text'))}
    ${T(160, 88, 'Сбоку: ступенчатое сверление')}
    ${G('board', R(90, ySurf, 150, 20, 'sch-board') + R(90, ySurf - 3, 150, 3, 'sch-copper'))}
    ${G('drilltool', R(156, 96, 16, 24, 'sch-tool') + `<path d="M156 120 L172 120 L164 ${ySurf + depthSpan} z" class="sch-tool" />`)}
    ${G('drillstep', depths.slice(0, -1).map((d) =>
      L(92, ySurf + Number(d) * kv, 246, ySurf + Number(d) * kv, 'sch-cut-dash') + T(250, ySurf + Number(d) * kv + 3, `Z-${d}`, 'sch-text', 'start')).join('') +
      T(250, ySurf + depthSpan + 3, `Z-${num(s.drillDepth)}`, 'sch-cut-text', 'start') +
      dimV(132, ySurf, ySurf + s.drillStep * kv, `шаг ${num(s.drillStep)}`, arr))}
    ${G('drilldepth', dimV(80, ySurf, ySurf + depthSpan, `Z-${num(s.drillDepth)}`, arr))}
    ${G('drillfeed', T(160, ySurf + depthSpan + 28, `врез F${num(s.drillFeed)} · между шагами подъём на +${num(s.safeZ)} мм`, 'sch-text'))}
    ${G('rpm', T(160, ySurf + depthSpan + 44, `шпиндель S${num(s.drillRpm)} об/мин`, 'sch-text'))}
    ${T(160, 218, 'Каждый диаметр — отдельный .nc; сверло меняется руками.', 'sch-warn-text')}
  </svg>`;
  return {
    id: 'drill',
    title: '3. Сверловка: глубина, шаг и сторона',
    svg,
    caption: 'Отверстия сверлятся ступенями Z с подъёмом; сторона задаёт, зеркалировать ли X.',
    parts: [
      { id: 'drillside', label: 'сторона сверловки', hint: s.drillSide === 'top' ? 'Сверлим сверху до переворота: X не зеркалируется.' : 'Сверлим снизу после переворота: X зеркалируется, как у нижней меди.' },
      { id: 'drilldepth', label: 'глубина', hint: `Сверло идёт до Z-${num(s.drillDepth)} — с запасом прохода через плату на подложку. Проверьте толщину платы и длину сверла.` },
      { id: 'drillstep', label: 'шаг по Z', hint: `Ступени по ${num(s.drillStep)} мм с подъёмом на безопасный Z между ними (протяжка стружки).` },
      { id: 'drillfeed', label: 'подача Z', hint: `Скорость погружения сверла — ${num(s.drillFeed)} мм/мин.` },
      { id: 'rpm', label: 'обороты S', hint: `Шпиндель при сверловке — ${num(s.drillRpm)} об/мин; для разных свёрл задайте свой режим вручную.` },
    ],
  };
}

// ─────────────────────────── 4. Переворот лево/право ───────────────────────────

export function flipScheme(doc: Doc, s: CncSettings): BuiltScheme {
  const arr = 'sch-arr-flip';
  const px = Math.max(2, Math.round(doc.w / 5)), py = Math.max(2, Math.round(doc.h / 2));
  const mx = num(s.originX + doc.w - px), my = num(s.originY + py);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 202" class="scheme-svg-root" role="img" aria-label="Схема переворота платы">${arrDefs(arr)}
    ${T(78, 12, 'K1 — до переворота')}
    ${T(242, 12, 'K2 — после переворота')}
    ${G('flip', R(28, 22, 100, 70, 'sch-board', 2) + T(78, 52, 'верх', 'sch-copper-text'))}
    ${G('formula', C(48, 72, 3.5, 'sch-cut') + T(78, 108, `P (${px}, ${py})`, 'sch-text') + T(78, 122, `X = ${num(s.originX)} + x = ${num(s.originX + px)}`, 'sch-text'))}
    ${G('flip', `<path d="M140 64 Q160 50 180 64" class="sch-dim" fill="none" marker-end="url(#${arr})" />` + T(160, 22, 'переворот', 'sch-text') + T(160, 33, 'лево/право', 'sch-text') + T(160, 44, 'вокруг оси Y', 'sch-text'))}
    ${G('mirror', R(192, 22, 100, 70, 'sch-board', 2) + T(242, 52, 'низ', 'sch-copper-text') + C(272, 72, 3.5, 'sch-cut') + T(242, 108, `P′ (${num(doc.w - px)}, ${py})`, 'sch-text') + T(242, 122, `X′ = ${num(s.originX)} + ${num(doc.w)} − x = ${mx}`, 'sch-text'))}
    ${T(160, 142, `Y не меняется: Y = ${num(s.originY)} + y = ${my}`, 'sch-text')}
    ${T(160, 162, s.drillSide === 'bottom'
      ? 'Сверловка снизу: X отверстий тоже зеркальный (_niz_zerkalo_x).'
      : 'Сверловка сверху: X отверстий НЕ зеркалируется.', 'sch-warn-text')}
    ${T(160, 180, 'Привязка при перевороте — критична.', 'sch-warn-text')}
    ${T(160, 194, 'X/Y не перенастраивать, Z0 — заново.', 'sch-warn-text')}
  </svg>`;
  return {
    id: 'flip',
    title: '4. Переворот и зеркало X',
    svg,
    caption: 'Низ фрезеруется только после физического переворота лево/право в той же оснастке.',
    parts: [
      { id: 'flip', label: 'переворот', hint: 'Заготовка переворачивается лево/право (вокруг вертикальной оси Y), а не верх/низ. Тот же рабочий ноль X/Y и та же привязка платы.' },
      { id: 'formula', label: 'X верха', hint: `На K1 координата X = a + x = ${num(s.originX)} + x.` },
      { id: 'mirror', label: 'X низа', hint: `На K2 после переворота X′ = a + ширина − x. Пример: x=${px} → X′=${mx}. Дополнительное отражение в УП станка включать НЕЛЬЗЯ.` },
    ],
  };
}

// ─────────────────────────── 5. Вырез контура ───────────────────────────

export function outlineScheme(doc: Doc, s: CncSettings): BuiltScheme {
  const arr = 'sch-arr-out';
  const o = 7 + s.outlineDiameter * 3;
  const cutR = Math.max(3.5, s.outlineDiameter * 3.2);
  const depths = stepDepths(s.outlineDepth, s.outlineStep);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 182" class="scheme-svg-root" role="img" aria-label="Схема вырезания контура">${arrDefs(arr)}
    ${T(130, 12, 'Сверху: фреза идёт снаружи платы')}
    ${G('board', R(70, 36, 120, 80, 'sch-board', 2) + T(130, 80, `плата ${num(doc.w)} × ${num(doc.h)}`, 'sch-copper-text'))}
    ${G('outlined', R(70 - o, 36 - o, 120 + o * 2, 80 + o * 2, 'sch-path', 6) + C(130, 36 - o, cutR, 'sch-tool') +
      L(130 + cutR, 36 - o, 156, 22, 'sch-dim') + T(158, 24, `Ø ${num(s.outlineDiameter)} мм`, 'sch-text', 'start'))}
    ${G('outlinestep', T(258, 44, 'проходы по Z:', 'sch-text') +
      depths.map((d, i) => T(258, 62 + i * 15, `Z-${d}${i === depths.length - 1 ? ' — полная' : ''}`, 'sch-text')).join('') +
      T(258, 62 + depths.length * 15 + 2, `шаг ${num(s.outlineStep)} мм`, 'sch-text') +
      T(258, 62 + depths.length * 15 + 16, `подача F${num(s.outlineFeed)}`, 'sch-text'))}
    ${G('tabs', R(28, 142, 264, 30, 'sch-warn-box', 6) + T(160, 155, 'БЕЗ удерживающих перемычек!', 'sch-warn-text') + T(160, 168, 'Закрепите плату до конца последнего прохода.', 'sch-warn-text'))}
  </svg>`;
  return {
    id: 'out',
    title: '5. Вырез прямоугольного контура',
    svg,
    caption: 'Контур вырезается последним файлом, по ступеням Z, вокруг платы.',
    parts: [
      { id: 'outlined', label: 'диаметр фрезы', hint: `Фреза Ø${num(s.outlineDiameter)} мм идёт по контуру на полдиаметра СНАРУЖИ от платы — плата получается точно ${num(doc.w)} × ${num(doc.h)} мм.` },
      { id: 'outlinestep', label: 'ступени Z', hint: `Глубина ${num(s.outlineDepth)} мм набирается ступенями по ${num(s.outlineStep)} мм — всего ${depths.length} проход(а/ов).` },
      { id: 'tabs', label: 'без перемычек', hint: 'Вырез идёт без удерживающих перемычек: в конце плата может оторваться. Надёжно закрепите заготовку до конца обработки.' },
    ],
  };
}

// ─────────────────────────── 6. Файлы ZIP: что за что отвечает ───────────────────────────

export interface FilesSchemeInfo {
  topLoops: number;
  bottomLoops: number;
  drills: { diameter: number; count: number; filename: string }[];
  outlinePasses: number;
}

export function filesScheme(doc: Doc, s: CncSettings, info: FilesSchemeInfo): BuiltScheme {
  const arr = 'sch-arr-files';
  type Row = { part: string; name: string; role: string; kind: 'doc' | 'iso' | 'drill' | 'cut'; flip?: boolean };
  const rows: Row[] = [
    { part: 'readme', name: '00_PROCHTITE_PERED_ZAPUSKOM.txt', role: 'прочитайте первым: нули, инструменты, порядок', kind: 'doc' },
    { part: 'schemes', name: '00b_SHEMY_PARAMETROV.svg', role: 'эти схемы: печатайте у станка', kind: 'doc' },
  ];
  if (s.drillSide === 'top') for (const d of info.drills)
    rows.push({ part: `drill-${d.filename}`, name: d.filename, role: `сверло Ø${num(d.diameter)} мм, ${d.count} отв. — сверху`, kind: 'drill' });
  if (info.topLoops) rows.push({ part: 'iso-top', name: '01_verh_k1.nc', role: `изоляция K1, ${info.topLoops} контуров`, kind: 'iso' });
  if (info.bottomLoops) rows.push({ part: 'iso-bottom', name: '02_niz_k2_zerkalo_x.nc', role: `изоляция K2, ${info.bottomLoops} контуров — после переворота`, kind: 'iso', flip: true });
  if (s.drillSide === 'bottom') for (const d of info.drills)
    rows.push({ part: `drill-${d.filename}`, name: d.filename, role: `сверло Ø${num(d.diameter)} мм, ${d.count} отв. — после переворота`, kind: 'drill', flip: true });
  if (info.outlinePasses) rows.push({ part: 'outline', name: '99_kontur_poslednim.nc', role: `вырез ${info.outlinePasses} проходов — ПОСЛЕДНИМ, без перемычек`, kind: 'cut' });

  // Строки двухстрочные: имя файла и его роль; перед первым «после переворота» — метка.
  let y = 34;
  let prevFlip = false;
  const boxes: string[] = [];
  const arrows: string[] = [];
  let prevBottom = 0;
  for (const r of rows) {
    const note = r.flip && !prevFlip;
    prevFlip = prevFlip || !!r.flip;
    if (note) {
      boxes.push(T(160, y + 4, '▼ после физического переворота лево/право ▼', 'sch-warn-text'));
      y += 14;
    }
    if (prevBottom) arrows.push(L(160, prevBottom, 160, y, 'sch-flow'));
    boxes.push(G(r.part,
      R(24, y, 272, 30, 'sch-box-' + r.kind, 5) +
      T(32, y + 13, r.name, 'sch-box-name', 'start') +
      T(32, y + 25, r.role, 'sch-box-role', 'start')));
    prevBottom = y + 30;
    y += 30 + 8;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 ${y + 12}" class="scheme-svg-root" role="img" aria-label="Схема файлов архива и порядка запуска">${arrDefs(arr)}
    ${T(160, 12, 'Порядок запуска: каждый файл — после смены инструмента')}
    ${arrows.join('')}${boxes.join('')}
    ${T(160, y + 4, 'M6/T-команд нет: инструмент меняется руками, Z0 — заново.', 'sch-warn-text')}
  </svg>`;
  return {
    id: 'files',
    title: '6. Файлы архива: какой файл за что отвечает',
    svg,
    caption: `Плата «${doc.name}»: ${rows.length} файлов, запускайте только нужный после установки инструмента.`,
    parts: rows.map((r) => ({
      id: r.part,
      label: r.name,
      hint: r.role + (r.flip ? '. Координаты уже зеркальные — после переворота платы лево/право.' : '.'),
    })),
  };
}

// ─────────────────────────── Сборка всех схем ───────────────────────────

export function buildCncSchemes(doc: Doc, s: CncSettings, info: FilesSchemeInfo): BuiltScheme[] {
  return [
    workZeroScheme(doc, s),
    isolationScheme(s),
    drillScheme(s),
    flipScheme(doc, s),
    outlineScheme(doc, s),
    filesScheme(doc, s, info),
  ];
}

/** Перенос текста по словам — для подписей в standalone-файле схем. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

const STANDALONE_STYLE = `
  .sch-bg { fill: #ffffff; }
  text { font-family: 'Segoe UI', 'DejaVu Sans', sans-serif; fill: #1d2733; font-size: 9px; }
  .sch-title { font-size: 12px; font-weight: 700; fill: #10243a; }
  .sch-sub { font-size: 9px; fill: #5b6b7c; }
  .sch-warn-text { fill: #a2451b; }
  .sch-text { fill: #33445a; }
  .sch-board { fill: #dce6f1; stroke: #47637e; stroke-width: 1; }
  .sch-stock { fill: #f4f7fa; stroke: #8fa3b8; stroke-width: 1; stroke-dasharray: 5 3; }
  .sch-copper { fill: #e9b63f; stroke: #b8891f; stroke-width: 1; }
  .sch-copper-text { fill: #7a5a12; font-size: 8.5px; }
  .sch-path { fill: none; stroke: #0f9db8; stroke-width: 1.6; stroke-dasharray: 4 2.5; }
  .sch-path-text { fill: #0f9db8; font-size: 8.5px; }
  .sch-tool { fill: #5c6b7a; stroke: #35424e; stroke-width: 1; }
  .sch-dim { stroke: #7c8ea1; stroke-width: 1; }
  .sch-dim-head { fill: #7c8ea1; }
  .sch-dim-bg { fill: #ffffff; opacity: .92; }
  .sch-dim-text { font-size: 8.5px; fill: #33445a; }
  .sch-line { stroke: #33445a; stroke-width: 1.2; }
  .sch-safe { stroke: #2e9e4f; stroke-width: 1.4; stroke-dasharray: 6 3; }
  .sch-cut { stroke: #d84a3c; stroke-width: 1.3; fill: none; }
  .sch-cut-text { fill: #d84a3c; font-size: 8.5px; }
  .sch-kerf { fill: #3d2418; stroke: #d84a3c; stroke-width: 0.8; }
  .sch-keep { fill: #f7edd4; stroke: none; }
  .sch-cut-dash { stroke: #d84a3c; stroke-width: 1; stroke-dasharray: 4 3; }
  .sch-clamp { fill: #9aa7b4; stroke: #6b7885; stroke-width: 1; }
  .sch-sel { fill: #d9edf7; stroke: #0f9db8; stroke-width: 1.6; }
  .sch-warn-box { fill: #fdeee4; stroke: #c96c3c; stroke-width: 1; }
  .sch-box-doc { fill: #eef1f5; stroke: #8fa3b8; stroke-width: 1; }
  .sch-box-iso { fill: #ddf2f6; stroke: #0f9db8; stroke-width: 1; }
  .sch-box-drill { fill: #e6e9fb; stroke: #5566c9; stroke-width: 1; }
  .sch-box-cut { fill: #fdeee4; stroke: #c96c3c; stroke-width: 1; }
  .sch-box-name { font-size: 8.5px; font-family: ui-monospace, monospace; fill: #17222e; }
  .sch-box-role { font-size: 8px; fill: #5b6b7c; }
  .sch-flow { stroke: #8fa3b8; stroke-width: 1.4; marker-end: url(#sch-arr-files); }
  .sch-part-title { font-size: 11px; font-weight: 700; fill: #10243a; }
  .sch-legend-text { font-size: 8.5px; fill: #33445a; }
  .sch-legend-hint { font-size: 8px; fill: #5b6b7c; }
`;

/** Standalone-файл для ZIP: все схемы с подписями, белый фон — можно распечатать у станка. */
export function cncSchemesSvg(doc: Doc, s: CncSettings, info: FilesSchemeInfo): string {
  const schemes = buildCncSchemes(doc, s, info);
  let y = 66;
  const chunks: string[] = [];
  for (const sc of schemes) {
    const h = Number(/viewBox="0 0 320 (\d+)"/.exec(sc.svg)?.[1] ?? 180);
    chunks.push(`<text x="16" y="${y}" class="sch-part-title">${esc(sc.title)}</text>`);
    y += 8;
    chunks.push(`<svg x="8" y="${y}" width="344" height="${(h * 344) / 320}" viewBox="0 0 320 ${h}">${sc.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg>`);
    y += (h * 344) / 320 + 8;
    for (const p of sc.parts) {
      const lines = wrap(`${p.label} — ${p.hint}`, 46);
      lines.forEach((line, i) => {
        chunks.push(`<text x="22" y="${y}" class="${i === 0 ? 'sch-legend-text' : 'sch-legend-hint'}">${i === 0 ? '▪ ' : '   '}${esc(line)}</text>`);
        y += i === 0 ? 11 : 10;
      });
      y += 1;
    }
    y += 14;
  }
  const head = `<text x="16" y="24" class="sch-title">PSBees — схемы к параметрам ЧПУ</text>
    <text x="16" y="40" class="sch-sub">Плата «${esc(doc.name)}» ${esc(num(doc.w))}×${esc(num(doc.h))} мм — что за что отвечает</text>
    <text x="16" y="52" class="sch-sub">Значения совпадают с 00_PROCHTITE_PERED_ZAPUSKOM.txt</text>`;
  const foot = `<text x="16" y="${y + 6}" class="sch-warn-text">Универсальных режимов резания нет — сверяйте значения со своим станком.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="${y + 22}" viewBox="0 0 360 ${y + 22}" font-family="Segoe UI, DejaVu Sans, sans-serif">
    <style>${STANDALONE_STYLE}</style>
    <rect width="360" height="${y + 22}" class="sch-bg" />
    ${head}${chunks.join('\n')}${foot}
  </svg>`;
}
