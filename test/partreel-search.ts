import { parsePartReelIndex, searchPartReel } from '../scripts/partreel-search.mjs';

const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const index = parsePartReelIndex({
  count: 21668,
  parts: [
    {
      id: 'usb_c_16p', name: 'USB Type-C Receptacle 16-pin (USB 2.0)', category: 'connector', family: 'USB-C',
      manufacturer: 'HRO / Generic', mpn_pattern: 'TYPE-C-31-M-12',
      description: 'SMD with through-hole shield tabs', parameters: { contacts: 16, mounting: 'SMD+THT' },
      keywords: ['usb', 'usb-c', 'type-c', 'receptacle', '16pin'], verified: true,
    },
    {
      id: 'bme280_breakout', name: 'BME280 environmental sensor breakout', category: 'sensor', family: 'breakout',
      manufacturer: 'Generic', keywords: ['sensor', 'module', 'i2c'], pins: 6, verified: false,
    },
    {
      id: 'arduino_nano', name: 'Arduino Nano', category: 'module', family: 'Arduino',
      manufacturer: 'Arduino', keywords: ['development board', 'atmega328p'], pins: 30, verified: true,
    },
    {
      id: 'r_0805', name: 'R_0805_2012Metric', category: 'passive', family: 'resistor',
      manufacturer: 'KiCad', keywords: ['SMD', '0805'], verified: true,
    },
  ],
});
assert(index.total === 21668 && index.parts.length === 4, 'catalog count and index rows');

const usb = searchPartReel(index, { query: 'TYPE-C-31-M-12', category: 'smd' });
assert(usb.count === 1 && usb.results[0].id === 'usb_c_16p', 'MPN pattern + SMD filter');
assert(usb.results[0].pins === 16, 'contact count normalized from PartReel parameters');

const sensor = searchPartReel(index, { query: 'BME280', category: 'modules' });
assert(sensor.count === 1 && sensor.results[0].id === 'bme280_breakout', 'sensor module category');

const arduino = searchPartReel(index, { query: 'arduino nano', category: 'modules', verifiedOnly: true });
assert(arduino.count === 1 && arduino.results[0].id === 'arduino_nano', 'Arduino search and verified filter');
const unverifiedOnly = searchPartReel(index, { query: 'BME280', verifiedOnly: true });
assert(unverifiedOnly.count === 0, 'do not label unverified entries as verified');

const many = parsePartReelIndex({ parts: Array.from({ length: 45 }, (_, i) => ({
  id: `test_part_${i}`, name: `Test Part ${i}`, category: 'passive', family: 'test', keywords: ['bulkmatch'],
})) });
const capped = searchPartReel(many, { query: 'bulkmatch', limit: 999 });
assert(capped.count === 45 && capped.results.length === 40, 'response capped at 40 without losing match count');
assert(searchPartReel(index, { query: '' }).count === 0, 'empty query does not return the catalog');

console.log('PartReel server-side search OK');
