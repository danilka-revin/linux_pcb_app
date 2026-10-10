// Расчёт электрических свойств дорожки: допустимый ток (IPC-2221) и
// сопротивление меди. Формула IPC-2221 (график 6-1):
//   I = k · ΔT^0.44 · A^0.725,
// где A — сечение дорожки в mil² (ширина × толщина меди), ΔT — нагрев, °C,
// k = 0.048 для внешних слоёв и 0.024 для внутренних (у нас оба слоя внешние).
// Сопротивление: R = ρ · L / A, ρ меди ≈ 0,01724 Ом·мм²/м (при 20 °C).

export const COPPER_RESISTIVITY = 0.01724; // Ом·мм²/м, медь 99.9%
const MM_PER_MIL = 0.0254;

/** Толщина меди: 35 мкм = 1 oz/ft² («унция»), 70 мкм = 2 oz. */
export const COPPER_PRESETS: { um: number; label: string }[] = [
  { um: 18, label: '0,5 oz (18 мкм)' },
  { um: 35, label: '1 oz (35 мкм)' },
  { um: 70, label: '2 oz (70 мкм)' },
];

export interface TrackCalcInput {
  widthMm: number;
  lengthMm: number;
  thicknessUm: number; // толщина меди, мкм
  tempRiseC: number;   // допустимый нагрев, °C
  external?: boolean;  // внешний слой (по умолчанию да)
}

export interface TrackCalcResult {
  /** площадь сечения, мм² */
  areaMm2: number;
  /** допустимый ток по IPC-2221, А */
  currentA: number;
  /** сопротивление участка, Ом */
  resistanceOhm: number;
  /** падение напряжения при токе currentA, В */
  voltDrop: number;
}

/** Допустимый ток дорожки по IPC-2221, А. */
export function ipc2221Current(widthMm: number, thicknessUm: number, tempRiseC = 10, external = true): number {
  if (!(widthMm > 0) || !(thicknessUm > 0)) return 0;
  const rise = Math.min(Math.max(tempRiseC, 1), 100);
  // сечение в mil²
  const widthMil = widthMm / MM_PER_MIL;
  const thickMil = thicknessUm / 25.4;
  const areaMil2 = widthMil * thickMil;
  const k = external ? 0.048 : 0.024;
  return k * Math.pow(rise, 0.44) * Math.pow(areaMil2, 0.725);
}

/** Сопротивление участка дорожки, Ом (медь при 20 °C). */
export function trackResistance(widthMm: number, lengthMm: number, thicknessUm: number): number {
  if (!(widthMm > 0) || !(thicknessUm > 0) || !(lengthMm > 0)) return 0;
  const areaMm2 = widthMm * (thicknessUm / 1000);
  return (COPPER_RESISTIVITY * (lengthMm / 1000)) / areaMm2;
}

/** Полный расчёт: ток, сопротивление и падение напряжения на участке. */
export function trackCalc(i: TrackCalcInput): TrackCalcResult {
  const areaMm2 = Math.max(0, i.widthMm) * (Math.max(0, i.thicknessUm) / 1000);
  const currentA = ipc2221Current(i.widthMm, i.thicknessUm, i.tempRiseC, i.external !== false);
  const resistanceOhm = trackResistance(i.widthMm, i.lengthMm, i.thicknessUm);
  return { areaMm2, currentA, resistanceOhm, voltDrop: currentA * resistanceOhm };
}

/** «1,5 А», «0,12 В» — русская запятая, разумное число знаков. */
export function fmtAmp(v: number): string {
  return (v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace('.', ',');
}

export function fmtOhm(v: number): string {
  if (v >= 1) return v.toFixed(2).replace('.', ',');
  if (v >= 0.001) return (v * 1000).toFixed(1).replace('.', ',') + ' мОм';
  return (v * 1e6).toFixed(0).replace('.', ',') + ' мкОм';
}

export function fmtVolt(v: number): string {
  return (v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace('.', ',');
}

/** Длина ломаной по точкам, мм. */
export function polylineLength(pts: readonly { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}
