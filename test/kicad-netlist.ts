import assert from 'node:assert/strict';
import { mapKicadNetlist, mergeImportedNets, parseKicadNetlist } from '../src/pcb/kicad-netlist';
import { newBoard, type Comp, type Net } from '../src/pcb/model';

const source = String.raw`(export
  (version "E")
  (components
    (comp (ref "U1") (value "MCU \"X\"") (footprint "Package:QFN-32"))
    (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0603")))
  (nets
    (net (code "1") (name "GND") (node (ref "U1") (pin "1")) (node (ref "R1") (pin "2")))
    (net (code "2") (name "/DATA[0]") (node (ref "U1") (pin "2")) (node (ref "MISSING") (pin "3")))
    (net (code "3") (name "SINGLE") (node (ref "U1") (pin "4")))))`;
const parsed = parseKicadNetlist(source);
assert.equal(parsed.components.length, 2);
assert.equal(parsed.components[0].value, 'MCU "X"');
assert.equal(parsed.nets[1].name, '/DATA[0]');
assert.deepEqual(parsed.nets[0].nodes, [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '2' }]);
const comp = (id: string, ref: string, pins: string[]): Comp => ({
  id, kind: 'comp', ref, lib: 'x', name: ref, x: 0, y: 0, rot: 0, side: 'top', bl: [0, 0, 4, 4],
  ents: pins.map((pin) => ({ id: `${id}-pin-${pin}`, kind: 'pad', x: 0, y: 0, shape: 'round', size: 1, drill: .4, pin })),
});
const doc = newBoard(30, 20);
doc.entities = [comp('u', 'U1', ['1', '2', '4']), comp('r', 'R1', ['2'])];
const mapped = mapKicadNetlist(parsed, doc);
assert.equal(mapped.matchedComponents, 2);
assert.equal(mapped.matchedPads, 4);
assert.deepEqual(mapped.nets[0].pads, ['u:0', 'r:0']);
assert.equal(mapped.nets.length, 1, 'single mapped pin is not manufactured into a fake two-pin net');
assert.deepEqual(mapped.componentUpdates.get('u'), { value: 'MCU "X"', footprint: 'Package:QFN-32' });
assert(mapped.unmatchedRefs.includes('MISSING'));
assert(mapped.warnings.some((w) => w.includes('только один')));
assert(mapped.warnings.some((w) => w.includes('не найдены обозначения')));
const dup = mapKicadNetlist(parsed, { ...doc, entities: [...doc.entities, comp('u2', 'u1', ['1'])] });
assert(dup.warnings.some((w) => w.includes('встречается на плате несколько раз')));
const existing: Net[] = [
  { id: 'manual-overlap', name: 'old', pads: ['u:0', 'free'] },
  { id: 'manual-safe', name: 'keep', pads: ['other-a', 'other-b'] },
  { id: 'old-kicad', name: 'old import', pads: ['u:0'], source: 'kicad' },
];
const merged = mergeImportedNets(existing, mapped.nets);
assert.deepEqual(merged.removedManual, ['old']);
assert.deepEqual(merged.nets.map((n) => n.name), ['keep', 'GND']);
console.log('KiCad netlist: S-expression parsing, component/pin mapping, warnings and safe net merge OK');
