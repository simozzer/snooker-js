// events.js — analytic event detection over two-phase (slide→roll) trajectories.
//
// Every ball's path is a list of polynomial segments in absolute time (motion.segments):
// position = P + V·t + C·t² on (lo, hi]. Within a single segment the coefficients are
// constant, so each event type reduces to the SAME closed-form solve carrom uses — just run
// once per segment (and, for pairs, once per overlapping segment×segment window):
//   wall   — per-axis quadratic            → smallestPositiveQuadratic
//   pair   — |Δp(t)|² = R² ⇒ quartic        → firstQuarticRoot
//   pocket — same quartic vs a fixed circle → firstQuarticRoot
//
// All times returned are ABSOLUTE; callers pass tNow as the lower bound for a valid event.

import * as v from './vec2.js';
import { firstQuarticRoot, cubicRoots } from './roots.js';
import { segments, segmentsToHorizon } from './motion.js';

const TIME_EPS = 1e-9;
const CONTACT_EPS = 1e-7; // metres: treat as already-touching
const BISECT_TOL = 1e-10;

// First t in (lo, hi] where the quadratic g(t) = a2 t² + a1 t + a0 crosses DOWNWARD (from > 0
// to ≤ 0). Used for cushions with g = signed gap to the wall: this catches the ball reaching
// the cushion while moving TOWARD it, and skips a ball sitting on a cushion moving away (or a
// spin-curved path that would otherwise tunnel straight back through), the wall analog of
// firstApproachInWindow for pairs.
function firstApproachQuad(a2, a1, a0, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const g = (t) => (a2 * t + a1) * t + a0;
  const crit = Math.abs(a2) > 1e-15 ? -a1 / (2 * a2) : Infinity; // single extremum of a parabola
  const pts = crit > lo && crit < hi ? [lo, crit, hi] : [lo, hi];
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i];
    const x1 = pts[i + 1];
    if (g(x0) > 0 && g(x1) <= 0) {
      let a = x0;
      let b = x1;
      while (b - a > BISECT_TOL) {
        const m = 0.5 * (a + b);
        if (g(m) <= 0) b = m;
        else a = m;
      }
      return 0.5 * (a + b);
    }
  }
  return Infinity;
}

// First t in (lo, hi] where |A + B t + C t²| = R (the contact quartic), or Infinity.
function contactInWindow(A, B, C, R, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const k4 = v.dot(C, C);
  const k3 = 2 * v.dot(B, C);
  const k2 = v.dot(B, B) + 2 * v.dot(A, C);
  const k1 = 2 * v.dot(A, B);
  const k0 = v.dot(A, A) - R * R;
  const t = firstQuarticRoot(k4, k3, k2, k1, k0, lo, hi);
  return t > lo && t < Infinity ? t : Infinity;
}

// First t in (lo, hi] where the gap g(t) = |A + B t + C t²|² − R² crosses DOWNWARD (from > 0
// to ≤ 0) — i.e. the balls are touching while APPROACHING. Crucially this skips a separating
// crossing (a pair that just resolved is moving apart, g rising), so we never re-detect the
// contact we just resolved, yet we still catch a later re-approach along the same trajectories
// (which the old "touching ⇒ Infinity" guard wrongly discarded, letting slow pairs tunnel).
function firstApproachInWindow(A, B, C, R, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const k4 = v.dot(C, C);
  const k3 = 2 * v.dot(B, C);
  const k2 = v.dot(B, B) + 2 * v.dot(A, C);
  const k1 = 2 * v.dot(A, B);
  const k0 = v.dot(A, A) - R * R;
  const q = (t) => (((k4 * t + k3) * t + k2) * t + k1) * t + k0;
  // monotonic sub-intervals are bounded by the quartic's critical points (roots of q')
  const crit = cubicRoots(4 * k4, 3 * k3, 2 * k2, k1).filter((t) => t > lo && t < hi).sort((x, y) => x - y);
  const pts = [lo, ...crit, hi];
  for (let i = 0; i < pts.length - 1; i++) {
    let x0 = pts[i];
    const x1 = pts[i + 1];
    if (q(x0) > 0 && q(x1) <= 0) {
      let a = x0;
      let b = x1;
      while (b - a > BISECT_TOL) {
        const m = 0.5 * (a + b);
        if (q(m) <= 0) b = m;
        else a = m;
      }
      return 0.5 * (a + b);
    }
  }
  return Infinity;
}

// Earliest cushion contact for a ball against axis-aligned bounds. { time, axis } or null.
//
// Each cushion is found as the first DOWNWARD crossing of its signed gap g(t) (positive inside
// the table, 0 at contact). This catches the ball arriving at the cushion while moving toward
// it, and inherently skips a cushion the ball is resting against / separating from — so a
// spin-curved slide can't tunnel back through a wall it just left (which let balls escape).
export function detectWall(ball, bounds, tNow) {
  const r = ball.radius;
  const xMin = bounds.minX + r;
  const xMax = bounds.maxX - r;
  const yMin = bounds.minY + r;
  const yMax = bounds.maxY - r;
  let best = Infinity;
  let axis = null;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    // gap to each wall as a quadratic a2 t² + a1 t + a0 (positive while inside the table):
    const consider = (a2, a1, a0, ax) => {
      const t = firstApproachQuad(a2, a1, a0, lo, s.hi);
      if (t < best) { best = t; axis = ax; }
    };
    consider(s.C.x, s.V.x, s.P.x - xMin, 'x'); // left:   x − xMin
    consider(-s.C.x, -s.V.x, xMax - s.P.x, 'x'); // right:  xMax − x
    consider(s.C.y, s.V.y, s.P.y - yMin, 'y'); // bottom: y − yMin
    consider(-s.C.y, -s.V.y, yMax - s.P.y, 'y'); // top:    yMax − y
  }
  return axis ? { time: best, axis } : null;
}

// Earliest contact time between two balls (absolute), or Infinity.
export function detectPair(a, b, tNow) {
  const R = a.radius + b.radius;

  // Currently in contact AND approaching → resolve immediately. Otherwise fall through: the
  // downward-crossing search below skips the (separating) contact we may be sitting on and
  // finds the next genuine approach, so a just-resolved pair isn't re-detected at dt~0.
  const dp = v.sub(a.pos, b.pos);
  if (v.len(dp) - R <= CONTACT_EPS) {
    const vn = v.dot(v.sub(a.vel, b.vel), v.normalize(dp));
    if (vn < 0) return tNow + TIME_EPS;
  }

  const horizon = Math.max(a.t0 + a.plan.tStop, b.t0 + b.plan.tStop);
  if (horizon <= tNow) return Infinity;
  const segA = segmentsToHorizon(a, tNow, horizon);
  const segB = segmentsToHorizon(b, tNow, horizon);

  let best = Infinity;
  for (const sa of segA) {
    for (const sb of segB) {
      const lo = Math.max(sa.lo, sb.lo, tNow);
      const hi = Math.min(sa.hi, sb.hi);
      if (lo >= hi) continue;
      const A = v.sub(sa.P, sb.P);
      const B = v.sub(sa.V, sb.V);
      const C = v.sub(sa.C, sb.C);
      const t = firstApproachInWindow(A, B, C, R, lo, hi);
      if (t < best) best = t;
    }
  }
  return best;
}

// Earliest pocket capture for a ball. { time, pocketIndex } or null. A ball is captured when
// its centre falls within a pocket's radius.
export function detectPocket(ball, pocketList, tNow) {
  for (let p = 0; p < pocketList.length; p++) {
    if (v.len(v.sub(ball.pos, pocketList[p].center)) <= pocketList[p].radius) {
      return { time: tNow + TIME_EPS, pocketIndex: p };
    }
  }
  let best = Infinity;
  let idx = -1;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    for (let p = 0; p < pocketList.length; p++) {
      const A = v.sub(s.P, pocketList[p].center);
      const t = contactInWindow(A, s.V, s.C, pocketList[p].radius, lo, s.hi);
      if (t < best) {
        best = t;
        idx = p;
      }
    }
  }
  return idx >= 0 ? { time: best, pocketIndex: idx } : null;
}
