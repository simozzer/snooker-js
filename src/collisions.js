// collisions.js — impulse resolution for snooker balls (uniform SPHERES).
//
// Normal: linear impulse along the contact normal with restitution e (conserves momentum;
//   elastic at e=1). Same core as carrom, but the masses/inertia are a sphere's.
// Tangential ("cut-induced throw" at ball–ball, "grip" at a cushion): friction impulse along
//   the contact tangent, Coulomb-clamped to muT·|jn|, exchanging side-spin (ω_z) and sideways
//   velocity. Only the VERTICAL-axis spin ω_z contributes to the in-plane tangential surface
//   velocity at the contact (the horizontal-axis spin's contribution is out-of-plane), so the
//   2D throw math is identical to carrom's — only the inertia factor differs.
// Follow/draw: the HORIZONTAL-axis spin (ω_x, ω_y) is deliberately left untouched by the
//   impact. The cue ball keeps its top/back spin through the collision, so when the engine
//   rebuilds its plan from the new (small/zero) velocity + retained spin, the next slide phase
//   produces follow-through / screw-back automatically. This is the whole point of two phases.

import * as v from './vec2.js';
import { INERTIA_FACTOR } from './snooker.js';

// Sphere: I = INERTIA_FACTOR · m r²  (= 2/5 m r²). So r²/I = 1/(INERTIA_FACTOR·m).
const inertiaOf = (b) => INERTIA_FACTOR * b.mass * b.radius * b.radius;

// Resolve a ball/ball collision in place. Mutates a.vel/b.vel and (if muT>0) a.spin.z/b.spin.z.
// Returns the normal closing speed (≥0) — the impact "hardness" for sound.
export function resolvePair(a, b, restitution, muT = 0) {
  const n = v.normalize(v.sub(a.pos, b.pos)); // contact normal, b → a
  const vrel = v.sub(a.vel, b.vel);
  const vn = v.dot(vrel, n);
  if (vn > 0) return 0; // separating already
  const closing = -vn;

  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const jn = (-(1 + restitution) * vn) / (invA + invB);
  a.vel = v.add(a.vel, v.scale(n, jn * invA));
  b.vel = v.sub(b.vel, v.scale(n, jn * invB));

  if (muT <= 0) return closing;

  const t = v.perp(n);
  const Ia = inertiaOf(a);
  const Ib = inertiaOf(b);
  // tangential relative SURFACE velocity (linear slip + side-spin slip)
  const ut = v.dot(vrel, t) - (a.spin.z * a.radius + b.spin.z * b.radius);
  const invMt = invA + invB + (a.radius * a.radius) / Ia + (b.radius * b.radius) / Ib;
  let jt = -ut / invMt;
  const cap = muT * Math.abs(jn);
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  a.vel = v.add(a.vel, v.scale(t, jt * invA));
  b.vel = v.sub(b.vel, v.scale(t, jt * invB));
  a.spin.z += (-a.radius * jt) / Ia;
  b.spin.z += (-b.radius * jt) / Ib;
  return closing;
}

// Reflect the normal velocity component off an axis-aligned cushion, scaled by restitution.
// restThreshold zeroes a tiny rebound (anti-Zeno). muT>0 adds cushion grip: ω_z ↔ tangential
// velocity. Returns the incoming normal speed (≥0). Horizontal-axis spin is left untouched —
// the engine's replan turns the post-bounce velocity + retained spin into a fresh slide.
export function resolveWall(ball, axis, restitution, restThreshold = 1e-3, muT = 0) {
  const vx = ball.vel.x;
  const vy = ball.vel.y;
  const impact = Math.abs(axis === 'x' ? vx : vy);

  let nvx = vx;
  let nvy = vy;
  if (axis === 'x') {
    nvx = -vx * restitution;
    if (Math.abs(nvx) < restThreshold) nvx = 0;
  } else {
    nvy = -vy * restitution;
    if (Math.abs(nvy) < restThreshold) nvy = 0;
  }
  ball.vel = { x: nvx, y: nvy };

  if (muT <= 0) return impact;

  const I = inertiaOf(ball);
  const invM = 1 / ball.mass;
  let nIx;
  let nIy;
  let jnMag;
  if (axis === 'x') {
    nIx = -Math.sign(vx);
    nIy = 0;
    jnMag = ball.mass * Math.abs(vx) * (1 + restitution);
  } else {
    nIx = 0;
    nIy = -Math.sign(vy);
    jnMag = ball.mass * Math.abs(vy) * (1 + restitution);
  }
  const tx = -nIy; // perp(n)
  const ty = nIx;
  const vt = ball.vel.x * tx + ball.vel.y * ty;
  const ut = vt - ball.spin.z * ball.radius;
  const invMt = invM + (ball.radius * ball.radius) / I;
  let jt = -ut / invMt;
  const cap = muT * jnMag;
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  ball.vel = { x: ball.vel.x + jt * invM * tx, y: ball.vel.y + jt * invM * ty };
  ball.spin.z += (-ball.radius * jt) / I;
  return impact;
}
