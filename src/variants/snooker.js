// variants/snooker.js — the snooker game as a "variant": geometry, rack, rules, AI targeting
// and rendering, behind the common interface that game.js / ai.js / the renderer consume. It
// wraps the existing snooker modules (table.js, rack.js, rules.js) so they stay unit-tested.

import * as v from '../vec2.js';
import { BALL } from '../snooker.js';
import { bounds, pockets, spots, dCentre, inD, HX, HY, baulkX, TABLE } from '../table.js';
import { openingPieces } from '../rack.js';
import { newFrame, applyOutcome as rulesApply, ballOn, VALUES } from '../rules.js';

const COLORS = {
  cue: '#f5f3ea', red: '#c0241f', yellow: '#e7c63b', green: '#1f7a43',
  brown: '#7a4a24', blue: '#2156b0', pink: '#e58fa6', black: '#1a1a1a',
};
const R = BALL.radius;

const clear = (state, x, y) =>
  inD(x, y, R) && state.pieces.every((p) => p.id === 'cue' || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);

const isLegalPot = (on, color) => (on === 'red' ? color === 'red' : on === 'any-colour' ? color !== 'red' : color === on);

export const snooker = {
  id: 'snooker',
  name: 'Snooker',
  ball: { radius: BALL.radius, mass: BALL.mass },
  cloth: '#0e6b3d',
  cueColor: 'cue',
  rulesText: [
    'Pot a red (1 pt), then a colour (yellow 2 … black 7); the colour is re-spotted. Repeat until the reds are gone.',
    'Then clear the six colours in ascending order — these stay down once potted.',
    'Foul (wrong or no first contact, or potting the cue ball): the opponent scores 4–7.',
    'When all balls are gone, the higher score wins the frame.',
  ],
  bounds,
  pockets,
  rack: openingPieces,
  newFrame,

  // --- rules adapter: pieces → colour strings, then the pure snooker rule core ---
  applyOutcome(frame, info) {
    return rulesApply(frame, {
      firstContact: info.firstContact ? info.firstContact.color : null,
      potted: info.potted.map((p) => p.color),
      cuePotted: info.cuePotted,
    });
  },
  // a re-spotted colour → a piece placed on a free spot
  respotPiece(state, color) {
    return { id: color, color, kind: 'colour', pos: freeSpot(state, color) };
  },

  // --- ball-in-hand (the "D") ---
  ballInHandLabel: 'Place the cue ball in the "D"',
  placementLegal: (state, x, y) => clear(state, x, y),
  defaultPlacement(state) {
    const desired = { x: baulkX(), y: 0.2 };
    if (clear(state, desired.x, desired.y)) return desired;
    for (let rad = 2 * R; rad < 0.3; rad += R)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = desired.x + Math.cos(a) * rad;
        const y = desired.y + Math.sin(a) * rad;
        if (clear(state, x, y)) return { x, y };
      }
    return desired;
  },

  // --- AI targeting ---
  aiTargets(state) {
    const on = ballOn(state.frame);
    if (on === 'red') return state.pieces.filter((p) => p.color === 'red');
    if (on === 'any-colour') return state.pieces.filter((p) => p.kind === 'colour');
    return state.pieces.filter((p) => p.color === on);
  },
  aiLegalFirst(frame, piece) {
    return piece != null && isLegalPot(ballOn(frame), piece.color);
  },
  aiLegalPot(frame, piece) {
    return isLegalPot(ballOn(frame), piece.color);
  },
  aiValue: (frame, piece) => VALUES[piece.color] * 100,
  aiWinBonus: () => 0,
  aiPlacements(state) {
    const d = dCentre();
    const spotsList = [
      { x: d.x, y: 0.12 }, { x: d.x, y: -0.12 }, { x: d.x, y: 0.2 }, { x: d.x, y: -0.2 },
      { x: d.x - 0.12, y: 0.1 }, { x: d.x - 0.12, y: -0.1 },
    ];
    return spotsList.filter((p) => clear(state, p.x, p.y));
  },

  // --- rendering ---
  colorOf: (piece) => COLORS[piece.color] ?? piece.color,
  isStripe: () => false,
  label: () => '',
  drawMarkings(ctx, h) {
    const bx = baulkX();
    ctx.strokeStyle = 'rgba(230,230,230,0.5)';
    ctx.lineWidth = 1.2;
    const a = h.toPx(bx, HY);
    const b = h.toPx(bx, -HY);
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    const dc = h.toPx(dCentre().x, dCentre().y);
    ctx.beginPath(); ctx.arc(dc.px, dc.py, h.sPx(TABLE.dRadius), Math.PI / 2, (3 * Math.PI) / 2); ctx.stroke();
    ctx.fillStyle = 'rgba(230,230,230,0.55)';
    for (const s of Object.values(spots())) {
      const p = h.toPx(s.x, s.y);
      ctx.beginPath(); ctx.arc(p.px, p.py, 2, 0, Math.PI * 2); ctx.fill();
    }
  },

  // --- HUD ---
  sideValue: (frame, i) => String(frame.scores[i]),
  centerText: (frame) => (frame.frameOver ? '' : `on: ${ballOn(frame) ?? '—'}`),
};

// Free spot for a re-spotted colour: its own spot, else the higher-value spots, else step back
// along the centre line. (Snooker re-spot, simplified — needs table geometry, hence here.)
function freeSpot(state, color) {
  const s = spots();
  const occupied = (x, y) => state.pieces.some((p) => (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 < (2 * R) ** 2 * 0.999);
  const within = (x, y) => x >= -HX + R && x <= HX - R && y >= -HY + R && y <= HY - R;
  for (const name of [color, 'black', 'pink', 'blue', 'brown', 'green', 'yellow']) {
    const sp = s[name];
    if (within(sp.x, sp.y) && !occupied(sp.x, sp.y)) return { x: sp.x, y: sp.y };
  }
  let x = s[color].x;
  while (x < HX - R) {
    x += 2 * R;
    if (within(x, 0) && !occupied(x, 0)) return { x, y: 0 };
  }
  return { x: s[color].x, y: s[color].y };
}
