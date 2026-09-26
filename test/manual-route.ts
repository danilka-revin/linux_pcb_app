import assert from 'node:assert/strict';
import { parseKicadFootprint } from '../src/pcb/kicad-footprint';
import { expandComp, libElsToEnts } from '../src/pcb/expand';
import { pickEndpoint } from '../src/pcb/autoroute';
import { terminalPath } from '../src/pcb/manual-route';
import type { Comp } from '../src/pcb/model';

const fp = parseKicadFootprint(`(footprint "catalog"
 (pad "1" thru_hole circle (at 1.27 2.54) (size 1.8 1.8) (drill 0.8) (layers "*.Cu" "*.Mask"))
 (pad "2" smd rect (at 5.08 2.54 90) (size 1 2) (layers "F.Cu"))
 (pad "3" smd rect (at 8.89 2.54) (size 1 2) (layers "B.Cu"))
 (fp_line (start 0 0) (end 1 1) (layer "B.SilkS") (width 0.15)))`);
for (const side of ['top', 'bottom'] as const) {
  for (const rot of [0, 90, 180, 270]) {
    const comp: Comp = { kind: 'comp', id: 'catalog', lib: '', name: fp.name, x: 20, y: 20, rot, side, bl: fp.bbox, ents: libElsToEnts(fp.els) };
    const flat = expandComp(comp);
    for (const pad of flat) {
      if (pad.kind !== 'pad' && pad.kind !== 'smd') continue;
      const end = pickEndpoint([comp], pad, 0.01);
      assert.ok(end);
      assert.equal(end.entId, pad.id);
      assert.deepEqual({ x: end.x, y: end.y }, { x: pad.x, y: pad.y });
      const layer = pad.kind === 'pad' ? 'k2' : pad.layer;
      assert.ok(pickEndpoint([comp], pad, 0.01, layer));
      assert.equal(pickEndpoint([comp], pad, 0.01, layer === 'k1' ? 'k2' : 'k1'), null);
      for (const angle of ['free', '45', '90'] as const) {
        const start = { x: 3.17, y: 4.29 };
        const path = terminalPath(start, end, angle);
        assert.equal(path.at(-1), end);
        let previous = start;
        for (const point of path) {
          const dx = Math.abs(point.x - previous.x), dy = Math.abs(point.y - previous.y);
          if (angle !== 'free') assert.ok(dx < 1e-6 || dy < 1e-6 || (angle === '45' && Math.abs(dx - dy) < 1e-6));
          previous = point;
        }
      }
    }
    const backPad = flat[2];
    assert.ok(backPad.kind === 'smd');
    assert.equal(backPad.layer, side === 'top' ? 'k2' : 'k1');
    const silk = flat[3];
    assert.ok(silk.kind === 'line');
    assert.equal(silk.layer, side === 'top' ? 's2' : 's1');
  }
}
assert.deepEqual(terminalPath({ x: 1, y: 2 }, { x: 1, y: 2 }, '45'), []);
console.log('Catalog terminals, layer transforms and exact manual routing OK');
