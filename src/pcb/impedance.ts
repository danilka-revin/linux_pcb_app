// Приближённый расчёт микрополоскового импеданса (Hammerstad–Jensen + поправка пары).
// Оценка не заменяет полевой решатель и stackup от конкретного производителя.
export interface MicrostripStackup {
  dielectricMm: number;
  dielectricEr: number;
  copperUm: number;
}
export interface DiffImpedanceResult {
  singleEndedOhm: number;
  differentialOhm: number;
  widthMm: number;
  gapMm: number;
}

function valid(width: number, stack: MicrostripStackup): boolean {
  return width > 0 && stack.dielectricMm > 0 && stack.dielectricEr > 1 && stack.copperUm >= 0;
}

/** Single-ended surface microstrip impedance, Ω. Solder-mask dielectric is omitted. */
export function microstripImpedance(widthMm: number, stack: MicrostripStackup): number {
  if (!valid(widthMm, stack)) return 0;
  const h = stack.dielectricMm;
  const t = stack.copperUm / 1000;
  let u = widthMm / h;
  if (t > 0) {
    const th = t / h;
    const correction = (th / Math.PI) * Math.log(1 + (4 * Math.E / th) * Math.tanh(Math.sqrt(6.517 * u)) ** 2);
    u += Math.max(0, correction);
  }
  const er = stack.dielectricEr;
  const ee = u <= 1
    ? (er + 1) / 2 + (er - 1) / 2 * (1 / Math.sqrt(1 + 12 / u) + 0.04 * (1 - u) ** 2)
    : (er + 1) / 2 + (er - 1) / (2 * Math.sqrt(1 + 12 / u));
  const z0 = u <= 1
    ? 60 / Math.sqrt(ee) * Math.log(8 / u + 0.25 * u)
    : 120 * Math.PI / (Math.sqrt(ee) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
  return Number.isFinite(z0) ? z0 : 0;
}

/** First-order odd/even-mode approximation for a symmetric surface differential pair. */
export function differentialImpedance(widthMm: number, gapMm: number, stack: MicrostripStackup): DiffImpedanceResult {
  const singleEndedOhm = microstripImpedance(widthMm, stack);
  if (!(singleEndedOhm > 0) || !(gapMm >= 0)) return { singleEndedOhm: 0, differentialOhm: 0, widthMm, gapMm };
  const coupling = 0.48 * Math.exp(-0.96 * gapMm / stack.dielectricMm);
  return { singleEndedOhm, differentialOhm: 2 * singleEndedOhm * (1 - coupling), widthMm, gapMm };
}

/** Solve conductor width for target Zdiff using bounded bisection; returns null if out of range. */
export function solveDifferentialWidth(targetOhm: number, gapMm: number, stack: MicrostripStackup): number | null {
  if (!(targetOhm > 0) || !(gapMm >= 0) || !(stack.dielectricMm > 0) || !(stack.dielectricEr > 1)) return null;
  let lo = 0.03, hi = Math.min(5, stack.dielectricMm * 80);
  const zLo = differentialImpedance(lo, gapMm, stack).differentialOhm;
  const zHi = differentialImpedance(hi, gapMm, stack).differentialOhm;
  if (!zLo || !zHi || targetOhm > zLo || targetOhm < zHi) return null;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (differentialImpedance(mid, gapMm, stack).differentialOhm > targetOhm) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
