// Набор SVG-иконок в стиле тёмной темы.
import type { ReactNode } from 'react';

const P = (d: string): ReactNode => <path d={d} />;
const C = (cx: number, cy: number, r: number, fill = false): ReactNode =>
  <circle cx={cx} cy={cy} r={r} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : undefined} />;
const R = (x: number, y: number, w: number, h: number, rx = 0): ReactNode =>
  <rect x={x} y={y} width={w} height={h} rx={rx} />;

export const ICONS: Record<string, ReactNode> = {
  inventory: <>{C(5, 6, 2)}{C(5, 12, 2)}{C(5, 18, 2)}{P('M10 6h10M10 12h10M10 18h10')}</>,
  select: <>{P('M4 3v17.5l4.6-4.5 2.6 4.8 3-1.4-2.5-4.7 5.8-1.2z')}</>,
  track: <>{P('M4 19h6l6-11h4')}{C(4, 19, 1.7, true)}{C(20, 8, 1.7, true)}</>,
  route: <>{P('M4 18h5l3-5h3l3-5h2')}{C(4, 18, 1.8, true)}{C(20, 8, 1.8, true)}{P('M13 4l1 2 2 .5-1.5 1.5.3 2-1.8-1-1.8 1 .3-2L10.5 6.5l2-.5z')}</>,
  pad: <>{C(12, 12, 7.5)}{C(12, 12, 2, true)}</>,
  smd: <>{R(4, 8.5, 16, 7, 1)}{P('M8.5 8.5v7M15.5 8.5v7')}</>,
  via: <>{C(12, 12, 8)}{C(12, 12, 4)}</>,
  hole: <circle cx="12" cy="12" r="6.5" strokeDasharray="3.5 2.5" />,
  line: <>{P('M5 19L19 5')}</>,
  rect: <>{R(4, 6, 16, 12)}</>,
  circle: <>{C(12, 12, 8)}</>,
  fill: (
    <>
      {R(4, 5, 16, 14)}
      <path d="M7 19L17 5M4.5 13.5L10.5 5M13.5 19.5L19.5 10" strokeWidth="1.2" />
    </>
  ),
  text: <>{P('M5.5 5h13M12 5v13.5M9 18.5h6')}</>,
  ruler: (
    <>
      {P('M3.5 15.5l12-12 5 5-12 12z')}
      {P('M7.5 11.5l1.8 1.8M11 8l1.8 1.8M14.5 4.5l1.8 1.8')}
    </>
  ),
  comp: (
    <>
      {R(7.5, 7.5, 9, 9, 1)}
      {P('M10 7.5V3.5M14 7.5V3.5M10 20.5v-4M14 20.5v-4M7.5 10h-4M7.5 14h-4M20.5 10h-4M20.5 14h-4')}
    </>
  ),
  zoomin: <>{C(10.5, 10.5, 6.5)}{P('M15.5 15.5L21 21M10.5 8v5M8 10.5h5')}</>,
  zoomout: <>{C(10.5, 10.5, 6.5)}{P('M15.5 15.5L21 21M8 10.5h5')}</>,
  fit: <>{P('M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5')}</>,
  mirror: (
    <>
      {P('M12 3v18')}
      <path d="M9.5 8l-5.5 4 5.5 4zM14.5 8l5.5 4-5.5 4z" fill="currentColor" stroke="none" />
    </>
  ),
  new: <>{P('M6 3h8l4 4v14H6z')}{P('M12 11v6M9 14h6')}</>,
  open: <>{P('M3 19V8a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V19a2 2 0 01-2 2H5a2 2 0 01-2-2z')}</>,
  save: <>{P('M5 3h11l3 3v15H5z')}{P('M8.5 3v5h7V3M8 21v-7h8v7')}</>,
  gerber: <>{P('M12 3v9.5M8 9l4 4 4-4')}{P('M4.5 16h15M4.5 20h15')}</>,
  png: (
    <>
      {R(3, 5, 18, 14, 2)}
      {C(8.8, 10.2, 1.7)}
      {P('M4.5 17l5.5-4.5 4 3.2 3-2.2 2.5 2')}
    </>
  ),
  panel: <>{R(3.5, 3.5, 7.5, 7.5)}{R(13, 3.5, 7.5, 7.5)}{R(3.5, 13, 7.5, 7.5)}{R(13, 13, 7.5, 7.5)}</>,
  undo: <>{P('M9 14.5L4 10l5-4.5')}{P('M4 10h8.5a6.5 6.5 0 016.5 6.5v0a6.5 6.5 0 01-6.5 6.5H9')}</>,
  redo: <>{P('M15 14.5L20 10l-5-4.5')}{P('M20 10h-8.5A6.5 6.5 0 005 16.5v0A6.5 6.5 0 0011.5 23H15')}</>,
  angle45: <>{P('M5 19h14M5 19L16 8')}</>,
  angle90: <>{P('M5 19h14M5 19V7')}</>,
  anglefree: <>{P('M5 19h14M5 19L15 12')}</>,
  about: <>{C(12, 12, 9)}{P('M12 11v5.5')}<circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" /></>,
  eye: (
    <>
      {P('M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z')}
      {C(12, 12, 2.6)}
    </>
  ),
};

export function Ic({ n, size = 18 }: { n: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[n] ?? null}
    </svg>
  );
}
