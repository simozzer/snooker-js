// rack.js — the opening layout: cue ball in the D, 15 reds in a triangle behind the pink,
// the 6 colours on their spots. Returns plain piece descriptors {id, color, kind, pos};
// game.js turns them into physics balls.

import { BALL } from './snooker.js';
import { spots, dCentre } from './table.js';

const GAP = 0.0004; // tiny spacing so no two balls start in exact contact (a chaotic break)

export function openingPieces() {
  const r = BALL.radius;
  const s = spots();
  const pieces = [];

  // cue ball: a typical break position in the D, out toward the yellow/green side
  const d = dCentre();
  pieces.push({ id: 'cue', color: 'cue', kind: 'cue', pos: { x: d.x, y: 0.15 } });

  // colours on their spots
  for (const color of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) {
    pieces.push({ id: color, color, kind: 'colour', pos: { x: s[color].x, y: s[color].y } });
  }

  // 15 reds: triangle with its apex just behind the pink, widening toward the black (+x)
  const apexX = s.pink.x + 2 * r + GAP;
  const rowDx = r * Math.sqrt(3) + GAP; // close-packed row spacing
  let id = 0;
  for (let row = 0; row < 5; row++) {
    const x = apexX + row * rowDx;
    for (let i = 0; i <= row; i++) {
      const y = (i - row / 2) * (2 * r + GAP);
      pieces.push({ id: `r${id}`, color: 'red', kind: 'red', pos: { x, y } });
      id += 1;
    }
  }
  return pieces;
}
