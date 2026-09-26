// Открытие предпросмотра ЧПУ в отдельном окне — просмотр не обязателен для скачивания,
// но доступен по кнопке «в отдельном окне». Работает и в браузере, и в Electron
// (main.mjs разрешает about:blank и same-origin попапы).

import type { Doc } from '../pcb/model';
import type { CncJob } from '../pcb/cnc';
import type { CncSettings } from '../pcb/cnc-settings';
import { isolationNeed, isolationKerf } from '../pcb/cnc-settings';

type Side = 'top' | 'bottom';

const n = (v: number) => String(Number(v.toFixed(3)));

function svgPath(paths: { x: number; y: number }[][], closed = true): string {
  return paths
    .map((path) => {
      if (!path.length) return '';
      const d = `M${path.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}`;
      return closed ? `${d}Z` : d;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function buildHtml(doc: Doc, settings: CncSettings, job: CncJob, initialSide: Side): string {
  const data = {
    doc: { w: doc.w, h: doc.h, name: doc.name },
    settings: {
      originX: settings.originX,
      originY: settings.originY,
      toolDiameter: settings.toolDiameter,
      clearance: settings.clearance,
      drillSide: settings.drillSide,
    },
    job: {
      preview: job.preview,
      topLoops: job.topLoops,
      bottomLoops: job.bottomLoops,
      drills: job.drills,
    },
    initialSide,
  };

  // Минимальные стили для автономного окна — тёмная тема, как в основном приложении.
  const css = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #0f1115; color: #d8e0ea; font: 13px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    body { padding: 16px; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    .muted { color: #8a9bb0; font-size: 12px; }
    .stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 10px; font-size: 12px; color: #8a9bb0; }
    .stats b { color: #f0c040; font-variant-numeric: tabular-nums; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; align-items: center; }
    .btn { appearance: none; border: 1px solid #2a3442; background: #1a2330; color: #d8e0ea; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
    .btn:hover { background: #223044; }
    .btn.primary { background: #f0c040; color: #111; border-color: #f0c040; font-weight: 600; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.on { background: #2a3a52; border-color: #3a5a8a; }
    .preview-wrap { border: 1px solid #2a3442; border-radius: 12px; overflow: hidden; background: #0e151d; }
    svg.cnc-preview { display: block; width: 100%; height: min(70vh, 720px); background: #0e151d; }
    .cnc-preview-stock { fill: #0e151d; stroke: #5b6b7c; stroke-width: 1; stroke-dasharray: 4 3; }
    .cnc-preview-board { fill: #1c2835; stroke: #b7c4d3; stroke-width: 1.2; }
    .cnc-preview-copper { fill: rgba(255, 194, 51, .72); }
    .cnc-preview-kerf { fill: none; stroke: #3d2418; stroke-linejoin: round; stroke-linecap: round; opacity: .92; }
    .cnc-preview-path { fill: none; stroke: #72e8f4; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
    .cnc-preview-rapid { fill: none; stroke: #8b98a6; stroke-width: 1.1; stroke-dasharray: 5 4; }
    .cnc-preview-hole { fill: #ff6a64; stroke: #fff; stroke-width: .8; }
    .cnc-preview-tool-body { fill: rgba(114, 232, 244, .35); stroke: #72e8f4; stroke-width: .08; }
    .cnc-preview-tool-halo { fill: none; stroke: #fff; stroke-width: 2; }
    .cnc-preview-tool-cross { stroke: #fff; stroke-width: 1.4; vector-effect: non-scaling-stroke; }
    .bar { height: 6px; margin-top: 8px; border-radius: 99px; background: #1a2330; border: 1px solid #2a3442; overflow: hidden; }
    .fill { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #0f9db8, #72e8f4); }
    .status { color: #8a9bb0; font-size: 12px; min-width: 12em; margin-left: 4px; }
    .legend { margin-top: 8px; color: #8a9bb0; font-size: 11.5px; }
    .footer { margin-top: 14px; display: flex; gap: 8px; }
  `;

  const need = isolationNeed(settings as any);
  const kerf = isolationKerf(settings as any);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ЧПУ предпросмотр — ${escapeHtml(doc.name)} — ${initialSide === 'top' ? 'K1' : 'K2'}</title>
<style>${css}</style>
</head>
<body>
  <h1>ЧПУ предпросмотр — ${escapeHtml(doc.name)} <span class="muted">${doc.w} × ${doc.h} мм</span></h1>
  <div class="stats">
    <span>Разделение меди <b>${n(need)} мм</b></span>
    <span>Рез <b>Ø${n(kerf)}</b></span>
    <span>Запас <b>${n(settings.clearance)} мм</b></span>
    <span>Верх K1: <b id="statTop">${job.topLoops}</b> конт.</span>
    <span>Низ K2: <b id="statBottom">${job.bottomLoops}</b> конт.</span>
    <span>Ход <b id="statLen">—</b></span>
  </div>

  <div class="toolbar" role="tablist" aria-label="Сторона платы">
    <button class="btn" id="btnTop" role="tab" aria-selected="${initialSide === 'top'}">Верх K1</button>
    <button class="btn" id="btnBottom" role="tab" aria-selected="${initialSide === 'bottom'}">Низ K2 — зеркально</button>
    <span style="flex:1"></span>
    <button class="btn" id="btnClose" title="Закрыть окно">Закрыть</button>
  </div>

  <div class="preview-wrap">
    <svg id="svg" class="cnc-preview" role="img" aria-label="Ход фрезы"></svg>
  </div>
  <div class="bar" aria-hidden="true"><span id="fill" class="fill"></span></div>

  <div class="toolbar">
    <button class="btn primary" id="btnPlay">Старт — ход станка</button>
    <button class="btn" id="btnReset">Сначала</button>
    <span style="display:inline-flex; gap:4px; margin-left:4px" role="group" aria-label="Скорость">
      <button class="btn" data-speed="0.5">×0.5</button>
      <button class="btn on" data-speed="1">×1</button>
      <button class="btn" data-speed="2">×2</button>
    </span>
    <span class="status" id="status">Нажмите «Старт» — фреза пойдёт по контуру.</span>
  </div>

  <div class="legend">
    Жёлтое — оставляемая медь; тёмная полоса — канавка реза шириной Ø${n(kerf)} мм;
    голубая линия — центр фрезы; пунктир — перелёт; кружок с крестом — фреза;
    красные точки — сверловка. Разделение меди ${n(need)} мм = рез + запас ${n(settings.clearance)} мм с двух сторон.<br/>
    Это окно независимо от основного — его можно держать рядом со станком. Просмотр не обязателен для скачивания ZIP.
  </div>

  <script type="application/json" id="__DATA__">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  <script>
  (function(){
    const raw = document.getElementById('__DATA__').textContent;
    const DATA = JSON.parse(raw);
    const doc = DATA.doc;
    const settings = DATA.settings;
    const job = DATA.job;
    let side = DATA.initialSide;

    const svg = document.getElementById('svg');
    const fillEl = document.getElementById('fill');
    const statusEl = document.getElementById('status');
    const statLen = document.getElementById('statLen');
    const btnTop = document.getElementById('btnTop');
    const btnBottom = document.getElementById('btnBottom');
    const btnPlay = document.getElementById('btnPlay');
    const btnReset = document.getElementById('btnReset');
    const btnClose = document.getElementById('btnClose');

    const dist = (a,b) => Math.hypot(b.x-a.x, b.y-a.y);
    const loopLen = (path) => {
      if (path.length < 2) return 0;
      let L=0;
      for (let i=1;i<path.length;i++) L+=dist(path[i-1], path[i]);
      if (path.length>2) L+=dist(path[path.length-1], path[0]);
      return L;
    };
    const atLen = (path, s) => {
      if (path.length===1) return path[0];
      let rest = Math.max(0,s);
      for (let i=1;i<path.length;i++){
        const d=dist(path[i-1], path[i]);
        if (rest<=d || i===path.length-1){
          const t = d>0 ? Math.min(1, rest/d) : 0;
          return { x: path[i-1].x + (path[i].x-path[i-1].x)*t, y: path[i-1].y + (path[i].y-path[i-1].y)*t };
        }
        rest-=d;
      }
      return path[path.length-1];
    };
    const segsOf = (loops) => {
      const segs=[];
      let last=null, loop=0;
      for (const raw of (loops||[])){
        if (raw.length<3) continue;
        const closed=[...raw, raw[0]];
        if (last) segs.push({ kind:'rapid', path:[last, closed[0]], length: Math.max(dist(last, closed[0]),0.001), loop });
        segs.push({ kind:'cut', path: closed, length: Math.max(loopLen(raw),0.001), loop });
        last=closed[0]; loop++;
      }
      return segs;
    };
    const sample = (segs, d) => {
      const total=segs.reduce((a,s)=>a+s.length,0);
      const cuts=segs.filter(s=>s.kind==='cut').length;
      if (!segs.length || total<=0) return { p:{x:0,y:0}, kind:'cut', loop:0, cuts };
      let rest=((d%total)+total)%total;
      for (const seg of segs){
        if (rest<=seg.length) return { p: atLen(seg.path, rest), kind: seg.kind, loop: seg.loop, cuts };
        rest-=seg.length;
      }
      const last=segs[segs.length-1];
      return { p:last.path[last.path.length-1], kind:last.kind, loop:last.loop, cuts };
    };
    const svgPath = (paths, closed=true) => {
      return paths.map(path=>{
        if (!path.length) return '';
        const d='M'+path.map(p=> p.x.toFixed(3)+' '+p.y.toFixed(3)).join('L');
        return closed? d+'Z' : d;
      }).join('');
    };

    let segs=[], cutLen=0, totalLen=0, playing=false, speed=1, distPos=0, raf=0, reduce=false;
    try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}

    let toolG=null;

    function setStatus(t){ statusEl.textContent=t; }

    function render(){
      const loops = side==='top' ? job.preview.top : job.preview.bottom;
      const copper = side==='top' ? job.preview.copperTop : job.preview.copperBottom;
      const drills = job.preview.drills || [];
      const vbX = -settings.originX, vbY = -settings.originY;
      const vbW = doc.w + 2*settings.originX, vbH = doc.h + 2*settings.originY;
      const r = Math.max(0.05, settings.toolDiameter/2);
      const kerf = settings.toolDiameter; // для отображения ширины реза

      segs = segsOf(loops||[]);
      cutLen = segs.filter(s=>s.kind==='cut').reduce((a,s)=>a+s.length,0);
      totalLen = segs.reduce((a,s)=>a+s.length,0);
      statLen.textContent = cutLen ? (cutLen.toFixed(1)+' мм') : '—';

      const rapids = segs.filter(s=>s.kind==='rapid').map(s=>s.path);
      const first = loops && loops[0] && loops[0][0];

      svg.setAttribute('viewBox', vbX+' '+vbY+' '+vbW+' '+vbH);
      // очистить
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('transform','translate(0 '+doc.h+') scale(1 -1)');
      svg.appendChild(g);

      const stock = document.createElementNS('http://www.w3.org/2000/svg','rect');
      stock.setAttribute('x', vbX); stock.setAttribute('y', vbY);
      stock.setAttribute('width', vbW); stock.setAttribute('height', vbH);
      stock.setAttribute('class','cnc-preview-stock');
      g.appendChild(stock);

      const board = document.createElementNS('http://www.w3.org/2000/svg','rect');
      board.setAttribute('x','0'); board.setAttribute('y','0');
      board.setAttribute('width', doc.w); board.setAttribute('height', doc.h);
      board.setAttribute('class','cnc-preview-board');
      g.appendChild(board);

      if (copper && copper.length){
        const p=document.createElementNS('http://www.w3.org/2000/svg','path');
        p.setAttribute('d', svgPath(copper));
        p.setAttribute('fill-rule','evenodd');
        p.setAttribute('class','cnc-preview-copper');
        g.appendChild(p);
      }
      if (loops && loops.length){
        const p=document.createElementNS('http://www.w3.org/2000/svg','path');
        p.setAttribute('d', svgPath(loops));
        p.setAttribute('class','cnc-preview-kerf');
        p.setAttribute('stroke-width', kerf);
        g.appendChild(p);
      }
      if (loops && loops.length){
        const p=document.createElementNS('http://www.w3.org/2000/svg','path');
        p.setAttribute('d', svgPath(loops));
        p.setAttribute('class','cnc-preview-path');
        g.appendChild(p);
      }
      if (rapids.length){
        const p=document.createElementNS('http://www.w3.org/2000/svg','path');
        p.setAttribute('d', svgPath(rapids,false));
        p.setAttribute('class','cnc-preview-rapid');
        g.appendChild(p);
      }
      if (settings.drillSide===side){
        const holeR = Math.max(0.15, Math.min(doc.w, doc.h)/140);
        for (let i=0;i<drills.length;i++){
          const pt=drills[i];
          const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
          c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', holeR);
          c.setAttribute('class','cnc-preview-hole');
          g.appendChild(c);
        }
      }
      if (first){
        toolG=document.createElementNS('http://www.w3.org/2000/svg','g');
        toolG.setAttribute('class','cnc-walk-tool');
        toolG.setAttribute('transform','translate('+first.x+' '+first.y+')');
        toolG.setAttribute('data-phase','cut');
        const body=document.createElementNS('http://www.w3.org/2000/svg','circle');
        body.setAttribute('r', r); body.setAttribute('class','cnc-preview-tool-body');
        const halo=document.createElementNS('http://www.w3.org/2000/svg','circle');
        halo.setAttribute('r', r); halo.setAttribute('class','cnc-preview-tool-halo');
        const l1=document.createElementNS('http://www.w3.org/2000/svg','line');
        l1.setAttribute('x1', -r*1.6); l1.setAttribute('x2', r*1.6); l1.setAttribute('y1','0'); l1.setAttribute('y2','0');
        l1.setAttribute('class','cnc-preview-tool-cross');
        const l2=document.createElementNS('http://www.w3.org/2000/svg','line');
        l2.setAttribute('y1', -r*1.6); l2.setAttribute('y2', r*1.6); l2.setAttribute('x1','0'); l2.setAttribute('x2','0');
        l2.setAttribute('class','cnc-preview-tool-cross');
        toolG.appendChild(body); toolG.appendChild(halo); toolG.appendChild(l1); toolG.appendChild(l2);
        g.appendChild(toolG);
      } else {
        toolG=null;
      }
      distPos=0;
      place(0);
    }

    function place(d){
      if (!segs.length) return;
      const { p, kind, loop, cuts } = sample(segs, d);
      if (toolG){
        toolG.setAttribute('transform','translate('+p.x+' '+p.y+')');
        toolG.setAttribute('data-phase', kind);
      }
      let walked = totalLen>0 ? ((d%totalLen)+totalLen)%totalLen : 0;
      let cut=0;
      for (const s of segs){
        const take=Math.min(s.length, walked);
        if (s.kind==='cut') cut+=take;
        walked-=take;
        if (walked<=0) break;
      }
      const pct = cutLen>0 ? Math.min(100, (cut/cutLen)*100) : 0;
      fillEl.style.width = pct+'%';
      setStatus(kind==='rapid' ? 'Перелёт к контуру '+(loop+1)+' из '+cuts : 'Режет контур '+(loop+1)+' из '+cuts+' · '+cut.toFixed(1)+' мм из '+cutLen.toFixed(1)+' мм');
    }

    function tick(now, last){
      if (!playing) return;
      const mmPerSec = Math.max(12, (cutLen||40)/7) * speed;
      const dt = (now-last)/1000;
      distPos += dt * mmPerSec;
      if (totalLen>0 && distPos>=totalLen){
        distPos=totalLen;
        place(distPos);
        playing=false;
        btnPlay.textContent='Старт — ход станка';
        setStatus('Проход закончен — можно просмотреть ещё раз.');
        return;
      }
      place(distPos);
      raf = requestAnimationFrame((n)=>tick(n, now));
    }

    btnTop.addEventListener('click', ()=>{ side='top'; btnTop.classList.add('on'); btnTop.setAttribute('aria-selected','true'); btnBottom.classList.remove('on'); btnBottom.setAttribute('aria-selected','false'); document.title='ЧПУ предпросмотр — '+doc.name+' — K1'; render(); });
    btnBottom.addEventListener('click', ()=>{ side='bottom'; btnBottom.classList.add('on'); btnBottom.setAttribute('aria-selected','true'); btnTop.classList.remove('on'); btnTop.setAttribute('aria-selected','false'); document.title='ЧПУ предпросмотр — '+doc.name+' — K2'; render(); });
    btnClose.addEventListener('click', ()=>window.close());

    btnPlay.addEventListener('click', ()=>{
      if (reduce){ setStatus('Анимация отключена (уменьшение движения). Контуры показаны целиком.'); return; }
      if (!segs.length) return;
      if (playing){
        playing=false;
        cancelAnimationFrame(raf);
        btnPlay.textContent='Старт — ход станка';
        return;
      }
      if (totalLen>0 && distPos>=totalLen-1e-6) distPos=0;
      playing=true;
      btnPlay.textContent='Пауза';
      let last=performance.now();
      raf=requestAnimationFrame((now)=>tick(now, last));
    });
    btnReset.addEventListener('click', ()=>{
      playing=false;
      cancelAnimationFrame(raf);
      btnPlay.textContent='Старт — ход станка';
      distPos=0;
      place(0);
      setStatus('Нажмите «Старт» — фреза пойдёт по контуру.');
    });
    document.querySelectorAll('[data-speed]').forEach(b=>{
      b.addEventListener('click', ()=>{
        document.querySelectorAll('[data-speed]').forEach(x=>x.classList.remove('on'));
        b.classList.add('on');
        speed=parseFloat(b.getAttribute('data-speed'));
      });
    });

    // init
    if (side==='top'){ btnTop.classList.add('on'); } else { btnBottom.classList.add('on'); }
    render();
  })();
  </script>
</body>
</html>`;
}

export function openCncPreviewWindow(doc: Doc, settings: CncSettings, job: CncJob, side: Side = 'top'): Window | null {
  const html = buildHtml(doc, settings, job, side);

  // Попытка открыть отдельное окно. В Electron main.mjs теперь разрешает about:blank и same-origin.
  const win = window.open('', '_blank', 'width=1100,height=800,menubar=no,toolbar=no,location=no,status=no');

  if (!win) {
    // Попап заблокирован — пробуем открыть через Blob URL как fallback.
    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const fallback = window.open(url, '_blank');
      if (fallback) {
        // Освободить URL после загрузки
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return fallback;
      }
      // Если и это не сработало — предложим скачать html
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(doc.name || 'board').replace(/[^\\wа-яА-ЯёЁ-]+/g, '_')}_preview_${side}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      alert('Попап заблокирован браузером. Предпросмотр сохранён как HTML-файл.');
      return null;
    } catch {
      alert('Не удалось открыть отдельное окно предпросмотра — браузер заблокировал попап. Разрешите всплывающие окна для этого сайта.');
      return null;
    }
  }

  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
  } catch (e) {
    // В некоторых браузерах document.write в about:blank может быть ограничен
    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      win.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      console.error('preview window write failed', e);
    }
  }

  return win;
}
