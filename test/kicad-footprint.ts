// KiCad footprint parser: quote/comment handling, SMD/PTH/NPTH, layers and drawings.
import { bboxOf } from '../src/pcb/footprint';
import { parseKicadFootprint } from '../src/pcb/kicad-footprint';

const fail = (message: string): never => { throw new Error(message); };
const assert = (condition: unknown, message: string): void => { if (!condition) fail(message); };
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;

const soic = String.raw`(footprint "SOIC-8_3.9x4.9mm_P1.27mm" (version 20250101) (generator pcbnew)
  (descr "An escaped quote: \" and slash \\")
  (fp_line (start -2.6 -2.4) (end 2.6 -2.4) (stroke (width 0.12) (type default)) (layer "F.SilkS"))
  (fp_rect (start -2.1 -1.9) (end 2.1 1.9) (stroke (width 0.1) (type default)) (fill none) (layer "F.Fab"))
  (fp_circle (center 0 0) (end 0 0.5) (stroke (width 0.12) (type default)) (fill none) (layer "B.SilkS"))
  (fp_arc (start -1 -1) (mid 0 -2) (end 1 -1) (stroke (width 0.12) (type default)) (layer "F.SilkS"))
  (fp_text reference "REF**" (at 0 -3) (layer "F.SilkS") (effects (font (size 1 1)) (hide yes)))
  (fp_text user "PIN 1" (at 0 0 90) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))))
  (pad "1" smd roundrect (at -1.905 -1.27 90) (size 1.1 0.55) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.2))
  (pad "2" smd rect (at 0 -1.27) (size 1.1 0.55) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "3" smd rect (at 1.905 -1.27) (size 1.1 0.55) (layers "B.Cu" "B.Paste" "B.Mask"))
  (pad "4" smd rect (at 1.905 1.27) (size 1.1 0.55) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "5" smd rect (at 0 1.27) (size 1.1 0.55) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "6" smd rect (at -1.905 1.27) (size 1.1 0.55) (layers "F.Cu" "F.Paste" "F.Mask"))
)`;
const parsed = parseKicadFootprint(soic);
assert(parsed.name === 'SOIC-8_3.9x4.9mm_P1.27mm', 'footprint name');
assert(parsed.stats.smd === 6, `SMD pads: ${parsed.stats.smd}`);
assert(parsed.stats.plated === 0 && parsed.stats.holes === 0, 'no PTH/NPTH');
assert(parsed.els.filter((e) => e.kind === 'smd').length === 6, 'six converted SMD pads');
const pad1 = parsed.els.find((e) => e.kind === 'smd' && e.x < -1.9);
assert(pad1?.kind === 'smd' && pad1.layer === 'k1' && pad1.rot === 90, 'SMD layer and 90° rotation');
assert(near(pad1.y, 1.27), 'KiCad Y axis converted to PSBees Y-up');
assert(parsed.els.some((e) => e.kind === 'rect' && e.layer === 's1'), 'F.Fab rectangle imported');
assert(parsed.els.some((e) => e.kind === 'circle' && e.layer === 's2'), 'B.SilkS circle imported to bottom silk');
assert(parsed.els.filter((e) => e.kind === 'line').length > 3, 'line + tessellated arc imported');
assert(parsed.els.some((e) => e.kind === 'text' && e.text === 'PIN 1'), 'user text imported');
assert(!parsed.els.some((e) => e.kind === 'text' && e.text === 'REF**'), 'reference placeholder omitted');
assert(parsed.bbox.every(Number.isFinite), 'bbox finite');
assert(JSON.stringify(parsed.bbox) === JSON.stringify(bboxOf(parsed.els)), 'bbox uses canonical geometry');

const throughHole = String.raw`(footprint "DIP-4"
  ; old KiCad files may still use line comments
  (pad "1" thru_hole rect (at -3.81 -1.27) (size 1.8 2.2) (drill 0.8) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole circle (at -3.81 1.27) (size 1.7 1.7) (drill oval 0.8 1.2) (layers "*.Cu" "*.Mask"))
  (pad "3" np_thru_hole circle (at 3.81 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask"))
)`;
const th = parseKicadFootprint(throughHole);
assert(th.stats.plated === 2 && th.stats.holes === 1, 'PTH/NPTH counted');
const pth = th.els.filter((e) => e.kind === 'pad');
assert(pth.length === 2 && pth[0].kind === 'pad' && pth[0].shape === 'square', 'rectangular PTH conservatively approximated as square');
assert(pth[0].kind === 'pad' && near(pth[0].drill, 0.8), 'PTH drill preserved');
assert(th.els.some((e) => e.kind === 'hole' && near(e.d, 3.2)), 'NPTH hole imported');
assert(th.warnings.some((w) => w.includes('приближены')), 'lossy PTH approximation disclosed');

let rejected = false;
try { parseKicadFootprint('(not_footprint "x")'); } catch { rejected = true; }
assert(rejected, 'reject unrelated S-expression');
rejected = false;
try { parseKicadFootprint('(footprint "x"'); } catch { rejected = true; }
assert(rejected, 'reject unclosed S-expression');
rejected = false;
try { parseKicadFootprint('x'.repeat(4 * 1024 * 1024 + 1)); } catch { rejected = true; }
assert(rejected, 'enforce size limit');

console.log(`KiCad footprint parser OK (${parsed.els.length + th.els.length} primitives checked)`);
