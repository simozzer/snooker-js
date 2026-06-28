// game.js — ties the physics engine to a game VARIANT (snooker or pool). The variant supplies
// geometry, rack, rules, AI targeting and rendering; this file is variant-agnostic glue:
//   1. build physics balls from the pieces (placing the cue in-hand if owed),
//   2. simulate to rest,
//   3. classify the cue's first contact + what was potted,
//   4. apply the variant's rules, then reconcile the table (drop potted, re-spot, update rests).

import { Ball } from './motion.js';
import { simulate } from './simulate.js';
import { snooker } from './variants/snooker.js';

// A really-small random nudge to each racked ball (~0.25 mm) so no two frames play out
// identically — a break is chaotically sensitive, so even a sub-visible offset diverges the run.
// The magnitude is far below the rack gaps, so it can't create an initial overlap; we still clamp
// to the table for safety. Pass { jitter: 0 } (or a seeded rng) for a deterministic layout.
const PLACEMENT_JITTER = 0.00025; // metres

function jitterPlacements(pieces, r, b, mag, rng) {
  if (mag <= 0) return;
  for (const p of pieces) {
    const x = p.pos.x + (rng() * 2 - 1) * mag;
    const y = p.pos.y + (rng() * 2 - 1) * mag;
    p.pos = { x: Math.max(b.minX + r, Math.min(b.maxX - r, x)), y: Math.max(b.minY + r, Math.min(b.maxY - r, y)) };
  }
}

export function newGame(variant = snooker, { jitter = PLACEMENT_JITTER, rng = Math.random } = {}) {
  const pieces = variant.rack();
  jitterPlacements(pieces, variant.ball.radius, variant.bounds(), jitter, rng);
  return { variant, frame: variant.newFrame(), pieces };
}

export function buildBalls(pieces, ball) {
  return pieces.map(
    (p) => new Ball({ id: p.id, kind: p.kind, color: p.color, pos: { x: p.pos.x, y: p.pos.y }, radius: ball.radius, mass: ball.mass }),
  );
}

// Final-state de-overlap: a velocity impulse can't undo positional interpenetration, so a tight
// cluster can settle with balls overlapping by a hair. This relaxes the SETTLED positions only
// (a constraint sweep: push overlapping pairs apart, keep them on the table) — it doesn't touch
// the replayed dynamics, just guarantees a clean resting layout. Uniform radius per variant.
function relaxOverlaps(pieces, r, b, iters = 20) {
  const minD = 2 * r;
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i].pos;
        const c = pieces[j].pos;
        const dx = a.x - c.x;
        const dy = a.y - c.y;
        let d = Math.hypot(dx, dy);
        if (d >= minD - 1e-9) continue;
        if (d < 1e-9) { d = 1e-9; } // coincident: nudge along x
        const nx = d > 1e-9 ? dx / d : 1;
        const ny = d > 1e-9 ? dy / d : 0;
        const push = (minD - d) / 2 + 1e-6;
        a.x += nx * push; a.y += ny * push;
        c.x -= nx * push; c.y -= ny * push;
        moved = true;
      }
    }
    for (const p of pieces) {
      p.pos.x = Math.max(b.minX + r, Math.min(b.maxX - r, p.pos.x));
      p.pos.y = Math.max(b.minY + r, Math.min(b.maxY - r, p.pos.y));
    }
    if (!moved) break;
  }
}

// Take a shot. cuePlacement (a legal in-hand position) is used when the frame owes ball-in-hand.
// spin = { side, vert } cue-tip offsets in −1..1.
export function takeShot(state, { angle, speed, spin = {}, cuePlacement = null } = {}) {
  const variant = state.variant;
  let cue = state.pieces.find((p) => p.id === 'cue');
  if (state.frame.ballInHand) {
    const pos = cuePlacement || variant.defaultPlacement(state);
    if (cue) cue.pos = { ...pos };
    else {
      cue = { id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...pos } };
      state.pieces.push(cue);
    }
    state.frame.ballInHand = false;
  }

  const balls = buildBalls(state.pieces, variant.ball);
  const pieceById = new Map(state.pieces.map((p) => [p.id, p]));
  const meta = new Map(
    balls.map((b) => {
      const p = pieceById.get(b.id);
      return [b.id, { radius: b.radius, fill: variant.colorOf(p), stripe: variant.isStripe(p), label: variant.label(p) }];
    }),
  );
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle, speed, spin }, { contactBall: 'cue' });

  const byId = new Map(balls.map((b) => [b.id, b]));
  const pottedIds = new Set(res.pocketed);
  const cuePotted = pottedIds.has('cue');
  const potted = [];
  for (const id of pottedIds) {
    if (id === 'cue') continue;
    potted.push(pieceById.get(id));
  }
  const firstContact = res.firstContact ? pieceById.get(res.firstContact) : null;
  const cueContacts = (res.cueContacts || []).map((id) => pieceById.get(id)).filter(Boolean);

  const outcome = variant.applyOutcome(state.frame, { firstContact, potted, cuePotted, cueContacts, cushionHits: res.cushionHits || 0 });

  // reconcile the table: keep survivors at their settled positions
  state.pieces = state.pieces
    .filter((p) => !pottedIds.has(p.id))
    .map((p) => ({ ...p, pos: { x: byId.get(p.id).pos.x, y: byId.get(p.id).pos.y } }));

  // re-spot whatever the rules return (snooker colours; pool returns nothing)
  for (const color of outcome.respot) {
    const rp = variant.respotPiece(state, color);
    if (rp) state.pieces.push(rp);
  }

  // clean up any hair-thin interpenetration left by a tight cluster settling
  relaxOverlaps(state.pieces, variant.ball.radius, variant.bounds());

  return { timeline: res.timeline, meta, outcome };
}
