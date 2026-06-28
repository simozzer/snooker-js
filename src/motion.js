// motion.js — two-phase rolling-ball trajectory (the snooker physics core).
//
// A struck/collided ball generally SLIDES then ROLLS:
//
//   slide phase [0, tRoll]:  the contact patch slips. Kinetic friction acts opposite to the
//     slip velocity u, which (classic result) keeps a CONSTANT direction and shrinks
//     linearly, so the friction force — hence the centre acceleration aSlide — is a CONSTANT
//     vector. The centre therefore follows a PARABOLA  p0 + v0 t + ½ aSlide t².  This is
//     where follow/draw/swerve curve comes from.
//   roll phase  [tRoll, tStop]:  slip is gone; the ball rolls without slipping under small
//     rolling resistance anti-parallel to v — a STRAIGHT line (carrom's single-phase model).
//
// Both phases are degree ≤ 2 in t per axis, so the engine's quadratic (wall) and quartic
// (ball/pocket) solvers apply unchanged — they just run piecewise over the two segments.
//
// Spin is a 3-vector {x,y,z}: (x,y) is the horizontal-axis angular velocity (drives
// roll / follow / draw / swerve via the slip), z is the vertical axis (side / "English",
// which doesn't translate the ball but matters at cushion & ball contacts).

import * as v from './vec2.js';
import { GRAVITY, MU_SLIDE, MU_ROLL, SLIP_FACTOR, SIDE_DECEL } from './snooker.js';

const REST = 1e-9;
const A_SLIDE = MU_SLIDE * GRAVITY; // centre deceleration magnitude while sliding
const A_ROLL = MU_ROLL * GRAVITY; // rolling-resistance deceleration

// Slip velocity of the bottom contact point: u = v + R·perp(s_h), s_h = (spin.x, spin.y).
// (Derivation: u = v + ω × (−R ẑ); the z component contributes nothing at the bottom point.)
export function slip(vel, spin, R) {
  return v.add(vel, v.scale(v.perp({ x: spin.x, y: spin.y }), R));
}

// Inverse of perp: given w = perp(s_h), recover s_h. (perp(perp(a)) = −a.)
const invPerp = (w) => ({ x: w.y, y: -w.x });

// Build the closed-form two-phase plan from a starting state. Pure. The returned object
// feeds posAt / velAt / spinAt below — the renderer and engine share this one source.
export function twoPhasePlan(pos, vel, spin, R) {
  const p0 = { x: pos.x, y: pos.y };
  const v0 = { x: vel.x, y: vel.y };
  const u0 = slip(v0, spin, R);
  const su = v.len(u0);

  // Already rolling (slip ~ 0): single straight roll phase (or fully at rest).
  if (su <= REST) {
    const sp = v.len(v0);
    if (sp <= REST) {
      return { p0, v0, spin0: { ...spin }, aSlide: v.vec(0, 0), tRoll: 0, pRoll: p0, vRoll: v.vec(0, 0), tStop: 0, R };
    }
    const tStop = sp / A_ROLL;
    return { p0, v0, spin0: { ...spin }, aSlide: v.vec(0, 0), tRoll: 0, pRoll: p0, vRoll: v0, tStop, R };
  }

  // Slide phase: constant centre acceleration opposite the slip; slip dies at tRoll.
  const uhat = v.scale(u0, 1 / su);
  const aSlide = v.scale(uhat, -A_SLIDE);
  const tRoll = su / (SLIP_FACTOR * A_SLIDE);
  const pRoll = {
    x: p0.x + v0.x * tRoll + 0.5 * aSlide.x * tRoll * tRoll,
    y: p0.y + v0.y * tRoll + 0.5 * aSlide.y * tRoll * tRoll,
  };
  const vRoll = v.add(v0, v.scale(aSlide, tRoll));
  const sRoll = v.len(vRoll);
  const tStop = sRoll <= REST ? tRoll : tRoll + sRoll / A_ROLL;
  return { p0, v0, spin0: { ...spin }, aSlide, tRoll, pRoll, vRoll, tStop, R };
}

// Position at absolute time t along the plan (clamped at rest).
export function posAt(plan, t) {
  const tt = Math.max(0, Math.min(t, plan.tStop));
  if (tt <= plan.tRoll) {
    return {
      x: plan.p0.x + plan.v0.x * tt + 0.5 * plan.aSlide.x * tt * tt,
      y: plan.p0.y + plan.v0.y * tt + 0.5 * plan.aSlide.y * tt * tt,
    };
  }
  const tau = tt - plan.tRoll;
  const sp = v.len(plan.vRoll);
  if (sp <= REST) return { x: plan.pRoll.x, y: plan.pRoll.y };
  const dir = v.scale(plan.vRoll, 1 / sp);
  const s = sp * tau - 0.5 * A_ROLL * tau * tau;
  return v.add(plan.pRoll, v.scale(dir, s));
}

// Velocity at absolute time t (zero once stopped).
export function velAt(plan, t) {
  if (t >= plan.tStop) return v.vec(0, 0);
  if (t <= plan.tRoll) return v.add(plan.v0, v.scale(plan.aSlide, Math.max(0, t)));
  const tau = t - plan.tRoll;
  const sp = v.len(plan.vRoll);
  if (sp <= REST) return v.vec(0, 0);
  const left = sp - A_ROLL * tau;
  return left <= 0 ? v.vec(0, 0) : v.scale(plan.vRoll, left / sp);
}

// Spin 3-vector at absolute time t. Horizontal part is recovered from the current slip
// state (s_h = perp⁻¹((v − u)/R)); the vertical (side) part decays linearly toward zero.
export function spinAt(plan, t) {
  const tt = Math.max(0, Math.min(t, plan.tStop));
  const vel = velAt(plan, tt);
  let u;
  if (tt < plan.tRoll) {
    // slip shrinks linearly in its fixed initial direction
    const u0 = slip(plan.v0, plan.spin0, plan.R);
    const su0 = v.len(u0);
    const left = su0 - SLIP_FACTOR * A_SLIDE * tt;
    u = left <= 0 ? v.vec(0, 0) : v.scale(u0, left / su0);
  } else {
    u = v.vec(0, 0); // rolling without slipping
  }
  const sh = invPerp(v.scale(v.sub(u, vel), 1 / plan.R)); // perp(s) = (u − v)/R
  // vertical (side) spin decay
  const z0 = plan.spin0.z || 0;
  const dz = SIDE_DECEL * tt;
  const z = Math.abs(z0) <= dz ? 0 : z0 - Math.sign(z0) * dz;
  return { x: sh.x, y: sh.y, z };
}

// Express the plan as polynomial segments in ABSOLUTE time, given t0 (the absolute time at
// which the plan was built). Each segment is { lo, hi, P, V, C } with
//   position(t) = P + V·t + C·t²   for t in (lo, hi],
// where C is HALF the acceleration — matching the engine's quartic A + B t + C t² convention,
// so the existing quadratic (wall) and quartic (ball/pocket) solvers run per segment.
export function segments(plan, t0 = 0) {
  const out = [];
  // local-time coeffs (origin at the plan build) → absolute time via τ = t − t0
  const push = (loL, hiL, P, V, C) => {
    const Cabs = C;
    const Vabs = v.sub(V, v.scale(C, 2 * t0));
    const Pabs = v.add(v.sub(P, v.scale(V, t0)), v.scale(C, t0 * t0));
    out.push({ lo: t0 + loL, hi: t0 + hiL, P: Pabs, V: Vabs, C: Cabs });
  };
  if (plan.tStop <= 0) return out;
  if (plan.tRoll > 0) {
    // slide: p0 + v0 τ + ½ aSlide τ²
    push(0, plan.tRoll, plan.p0, plan.v0, v.scale(plan.aSlide, 0.5));
  }
  if (plan.tStop > plan.tRoll) {
    const sp = v.len(plan.vRoll);
    if (sp > 1e-12) {
      const dir = v.scale(plan.vRoll, 1 / sp);
      const C = v.scale(dir, -0.5 * A_ROLL); // ½ accel (rolling resistance)
      const V = v.scale(dir, sp + A_ROLL * plan.tRoll); // dir·sp + A_ROLL·dir·tRoll
      const tR = plan.tRoll;
      const P = v.sub(v.sub(plan.pRoll, v.scale(V, tR)), v.scale(C, tR * tR)); // pRoll − V·tR − C·tR²
      push(plan.tRoll, plan.tStop, P, V, C);
    }
  }
  return out;
}

// Segments clamped to start at tNow and extended with a trailing constant "rest" segment out
// to `horizon`, so a moving ball vs a resting one (and stop-time mismatches between two balls)
// fall out of the same per-segment pair search. A fully-resting ball yields one rest segment.
export function segmentsToHorizon(ball, tNow, horizon) {
  const segs = segments(ball.plan, ball.t0).filter((s) => s.hi > tNow);
  if (!segs.length) {
    return horizon > tNow ? [{ lo: tNow, hi: horizon, P: { x: ball.pos.x, y: ball.pos.y }, V: v.vec(0, 0), C: v.vec(0, 0) }] : [];
  }
  const lastHi = segs[segs.length - 1].hi;
  if (horizon > lastHi) {
    const restPos = posAt(ball.plan, ball.plan.tStop);
    segs.push({ lo: lastHi, hi: horizon, P: restPos, V: v.vec(0, 0), C: v.vec(0, 0) });
  }
  return segs;
}

// A snooker ball: position, velocity, full spin vector, and a cached motion plan that is
// rebuilt whenever the velocity/spin changes (at a strike or a collision). The engine sets
// `t0` to the absolute time at which the current plan was built.
export class Ball {
  constructor({ id, kind, pos, vel = v.vec(0, 0), spin = { x: 0, y: 0, z: 0 }, radius, mass, color }) {
    this.id = id;
    this.kind = kind; // 'cue' | 'red' | 'colour'
    this.color = color;
    this.pos = pos;
    this.vel = vel;
    this.spin = { x: spin.x || 0, y: spin.y || 0, z: spin.z || 0 };
    this.radius = radius;
    this.mass = mass;
    this.pocketed = false;
    this.t0 = 0; // absolute time the current plan was built (set by the engine)
    this.replan();
  }

  // Rebuild the closed-form plan from the current pos/vel/spin.
  replan() {
    this.plan = twoPhasePlan(this.pos, this.vel, this.spin, this.radius);
  }

  get speed() {
    return v.len(this.vel);
  }
  // A ball still has motion ahead if its plan reaches rest in the future. This is true even
  // when the CENTRE is momentarily still but residual spin will drive it (post-collision
  // follow/draw) — twoPhasePlan folds that slip into tStop.
  get moving() {
    return this.plan.tStop > REST;
  }
  // Time until this ball comes to rest (end of the roll phase).
  stopTime() {
    return this.plan.tStop;
  }
  // Slide→roll transition time (0 if it starts already rolling / at rest).
  rollTime() {
    return this.plan.tRoll;
  }
  posAt(t) {
    return posAt(this.plan, t);
  }
  velAt(t) {
    return velAt(this.plan, t);
  }
  spinAt(t) {
    return spinAt(this.plan, t);
  }
}
