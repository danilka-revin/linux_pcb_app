// Расчёт дорожки: IPC-2221, сопротивление, падение напряжения, длина ломаной.
import assert from 'node:assert/strict';
import {
  COPPER_RESISTIVITY, fmtAmp, fmtOhm, fmtVolt, ipc2221Current,
  polylineLength, trackCalc, trackResistance,
} from '../src/pcb/trackcalc';

// ---------------------------------------------------------------- IPC-2221
// 10 mil × 1 oz (0,254 × 35 мкм) при ΔT=10 °C — классические «≈1 А»
const i10 = ipc2221Current(0.254, 35, 10);
assert(i10 > 0.7 && i10 < 1.1, `10 mil / 1 oz должен давать около 1 А, а ${i10.toFixed(2)} А`);

// шире → больше тока
assert(ipc2221Current(0.5, 35, 10) > i10, 'широкая дорожка держит больше тока');
// толще медь → больше тока
assert(ipc2221Current(0.254, 70, 10) > i10, '2 oz держит больше 1 oz');
// больший нагрев → больше ток
assert(ipc2221Current(0.254, 35, 20) > i10, 'при большем нагреве допуск выше');
// внутренний слой — вдвое строже (k=0.024)
const ext = ipc2221Current(0.3, 35, 10, true);
const int = ipc2221Current(0.3, 35, 10, false);
assert(Math.abs(ext / int - 2) < 0.01, 'внешний/внутренний ровно в 2 раза');

// вырожденные случаи
assert.equal(ipc2221Current(0, 35, 10), 0, 'нулевая ширина → 0');
assert.equal(ipc2221Current(0.3, 0, 10), 0, 'нулевая толщина → 0');
assert(Number.isFinite(ipc2221Current(0.3, 35, 0)), 'нулевой нагрев ограничен снизу');

// ------------------------------------------------------------- сопротивление
// 0,254 мм × 35 мкм, 100 мм: A ≈ 0,00889 мм², R ≈ 0,194 Ом
const r = trackResistance(0.254, 100, 35);
assert(Math.abs(r - 0.194) < 0.01, `сопротивление 100 мм 10 mil ≈ 0,19 Ом, а ${r.toFixed(3)}`);
// линейно по длине
assert(Math.abs(trackResistance(0.254, 200, 35) - 2 * r) < 1e-9, 'сопротивление линейно по длине');
assert.equal(trackResistance(0.254, 0, 35), 0, 'нулевая длина → 0');
assert(COPPER_RESISTIVITY > 0.017 && COPPER_RESISTIVITY < 0.018, 'ρ меди в разумных пределах');

// -------------------------------------------------------------- полный расчёт
const c = trackCalc({ widthMm: 0.254, lengthMm: 100, thicknessUm: 35, tempRiseC: 10 });
assert(Math.abs(c.currentA - i10) < 1e-9, 'ток совпадает с ipc2221Current');
assert(Math.abs(c.resistanceOhm - r) < 1e-9, 'сопротивление совпадает');
assert(Math.abs(c.voltDrop - c.currentA * c.resistanceOhm) < 1e-9, 'падение = I·R');
assert(c.areaMm2 > 0.008 && c.areaMm2 < 0.01, 'сечение ≈ 0,0089 мм²');

// ------------------------------------------------------------------- форматы
assert.equal(fmtAmp(1.532), '1,53');
assert.equal(fmtAmp(12.34), '12,3');
assert.equal(fmtOhm(0.194), '194,0 мОм');
assert.equal(fmtOhm(2.5), '2,50');
assert.equal(fmtVolt(0.123), '0,123');
assert.equal(fmtVolt(2.5), '2,50');

// -------------------------------------------------------------- длина ломаной
assert.equal(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
assert.equal(polylineLength([{ x: 0, y: 0 }]), 0);
assert.equal(polylineLength([]), 0);
assert.equal(
  polylineLength([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]),
  2,
);

console.log('trackcalc: ok');
