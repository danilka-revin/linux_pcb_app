import assert from 'node:assert/strict';
import { assemblySvg, bomCsv, buildBom, componentRows, metadataPatch, nextReference, pickPlaceCsv } from '../src/pcb/component-data';
import { newBoard, type Entity } from '../src/pcb/model';

const component = (id: string, opts: Partial<Extract<Entity, { kind: 'comp' }>> = {}): Extract<Entity, { kind: 'comp' }> => ({
  id, kind: 'comp', lib: 'lib', name: 'резистор 10k', x: 10, y: 20, rot: 0, side: 'top', bl: [8, 18, 12, 22], ents: [], ...opts,
});
const doc = newBoard(40, 30);
doc.name = 'Fixture <A>';
doc.entities = [
  component('r1', { ref: 'R1', value: '10k, 1%', footprint: '0603', manufacturer: 'ACME', mpn: 'A"B', datasheet: 'https://x.test/a?b=1&c=2' }),
  component('r2', { ref: 'R2', value: '10k, 1%', footprint: '0603', manufacturer: 'ACME', mpn: 'A"B' }),
  component('r3', { ref: 'R3', value: '10k, 1%', footprint: '0805', side: 'bottom', rot: 90, x: 25, y: 12 }),
  component('legacy', { ref: '', name: 'capacitor 1uF', value: '1uF', x: 6, y: 7 }),
];
const rows = componentRows(doc);
assert.deepEqual(rows.map((r) => r.ref), ['R1', 'R2', 'R3', 'C1'], 'legacy references generated stably by type');
assert.equal(rows[2].rotation, 270, 'bottom-side rotation is mirrored into pick-and-place coordinates');
assert.equal(rows[0].rotation, 0);
const bom = buildBom(rows);
assert.equal(bom.length, 3, 'different footprints remain separate BOM line items');
assert.equal(bom.find((r) => r.value === '10k, 1%')?.quantity, 2);
assert.deepEqual(bom.find((r) => r.value === '10k, 1%')?.references, ['R1', 'R2']);
const bomText = bomCsv(rows);
assert(bomText.includes('"10k, 1%"'));
assert(bomText.includes('"A""B"'));
assert(bomText.includes('https://x.test/a?b=1&amp;c=2') === false, 'CSV keeps URL raw and quotes only CSV syntax');
assert(bomText.includes('https://x.test/a?b=1&c=2'));
const pnp = pickPlaceCsv(rows);
assert(pnp.includes('R3,"10k, 1%",0805,25.0000,12.0000,270.0,BOTTOM'));
assert.equal(nextReference('resistor', doc.entities), 'R4');
assert.equal(nextReference('resistor', doc.entities, 'r2'), 'R2');
const patch = metadataPatch({ ...rows[0], ref: ' U1 ', value: '  MCU ', footprint: ' QFN ', manufacturer: ' M ', mpn: ' X ', datasheet: ' URL ' });
assert.deepEqual(patch, { ref: 'U1', value: 'MCU', footprint: 'QFN', manufacturer: 'M', mpn: 'X', datasheet: 'URL' });
const svg = assemblySvg(doc, rows, 'top');
assert(svg.includes('<svg') && svg.includes('Fixture &lt;A&gt;') && svg.includes('R1') && !svg.includes('R3'));
assert(svg.includes('viewBox=') && svg.includes('координаты мм'));
console.log('Manufacturing: references, grouped BOM, CSV escaping, mirrored pick-and-place and assembly SVG OK');
