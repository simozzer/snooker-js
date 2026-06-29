// engine.js — the event-driven loop for snooker (two-phase rolling balls).
//
// Identical in spirit to carrom's loop — pop the earliest predicted event, advance every ball
// to it along its closed-form plan, resolve, re-detect only the 1–2 balls whose velocity just
// changed — with two differences that the two-phase model forces:
//   • Each ball carries a motion PLAN (slide→roll) built at absolute time `t0`. Advancing a
//     ball EVALUATES its plan at (t − t0); it does NOT rebuild the plan (so the plan's internal
//     slide→roll transition is handled inside posAt/velAt, and other balls' cached events stay
//     valid). The plan is rebuilt only when a collision changes that ball's velocity/spin.
//   • Event detection runs per trajectory segment (motion.segments), so the slide→roll bend is
//     never an explicit event — it's baked into each ball's predicted wall/pair/pocket times.
//
// Emits a timeline of post-event snapshots (positions, velocities, spin) for replay.

import * as v from './vec2.js';
import { detectWall, detectPair, detectPocket } from './events.js';
import { resolvePair, resolveWall } from './collisions.js';
import { BALL_RESTITUTION, CUSHION_RESTITUTION, BALL_FRICTION_T, CUSHION_FRICTION_T, SPIN_GAIN } from './snooker.js';

const MAX_EVENTS = 100000;

const snap = (balls, t, kind, intensity = 0, hit = null) => ({
  t,
  kind, // 'start' | 'pair' | 'wall' | 'pocket' | 'end'
  intensity, // impact speed (m/s) — drives collision-sound volume
  hit, // ids involved: {a,b} for a pair, {id} for a wall/pocket — used to classify the shot
  balls: balls.map((b) => ({
    id: b.id,
    pos: { x: b.pos.x, y: b.pos.y },
    vel: { x: b.vel.x, y: b.vel.y },
    spin: { x: b.spin.x, y: b.spin.y, z: b.spin.z },
    pocketed: b.pocketed,
  })),
});

const stopAbs = (b) => b.t0 + b.plan.tStop; // absolute time this ball comes to rest
const isMoving = (b, t) => !b.pocketed && stopAbs(b) > t + 1e-12;

// Advance every active ball to absolute time T by evaluating its plan (no replan).
function advance(balls, T) {
  for (const b of balls) {
    if (b.pocketed) continue;
    const localT = T - b.t0;
    b.pos = b.posAt(localT);
    b.vel = b.velAt(localT);
    b.spin = b.spinAt(localT);
  }
}

// Convert a cue strike (direction + power + tip offset) into the cue ball's launch state.
//   spin = { side: −1..1 (left/right English), vert: −1..1 (draw/follow) }
export function strike(ball, angle, speed, spin = {}) {
  const dir = v.fromAngle(angle);
  ball.vel = v.scale(dir, speed);
  const vert = spin.vert || 0;
  const side = spin.side || 0;
  // horizontal-axis spin along perp(dir): + = topspin/follow (same sense as natural roll)
  const sh = v.scale(v.perp(dir), (vert * SPIN_GAIN * speed) / ball.radius);
  ball.spin = { x: sh.x, y: sh.y, z: (side * SPIN_GAIN * speed) / ball.radius };
}

const KIND_RANK = { pocket: 0, wall: 1, pair: 2 };

// layout: { balls: Ball[], bounds: {minX,maxX,minY,maxY}, pockets: [{center,radius}] }
// shot:   { ballId, angle, speed, spin:{side,vert} } | null
export function runEngine(layout, shot, opts = {}) {
  // The loop runs to `cap`; a caller may pass a SMALLER opts.maxEvents (e.g. the renderer's
  // shallow trajectory preview). `hitCap` below deliberately reports only the hard MAX_EVENTS
  // safety ceiling, NOT a caller's smaller cap — so a truncated preview isn't flagged as runaway.
  const cap = opts.maxEvents ?? MAX_EVENTS;
  const wantTimeline = opts.timeline !== false;
  const contactBall = opts.contactBall ?? null; // track this ball's contacts (snooker/pool/carom)
  let firstContact = null;
  const cueContacts = []; // every ball `contactBall` touches, in order (for carom scoring)
  let cushionHits = 0; // how many cushions `contactBall` hits (for cushion-count games)
  const balls = layout.balls;
  const bounds = layout.bounds;
  const pocketList = layout.pockets;

  if (shot) {
    const cue = balls.find((b) => b.id === shot.ballId);
    if (!cue) throw new Error(`shot.ballId ${shot.ballId} not found`);
    strike(cue, shot.angle, shot.speed, shot.spin || {});
    cue.replan();
    cue.t0 = 0;
  }

  let t = 0;
  const timeline = wantTimeline ? [snap(balls, 0, 'start')] : [];
  let count = 0;

  const N = balls.length;
  const evWall = new Array(N).fill(null);
  const evPock = new Array(N).fill(null);
  const evPair = new Array(N * N).fill(null);

  const setWall = (i) => {
    evWall[i] = null;
    const b = balls[i];
    if (!isMoving(b, t)) return;
    const w = detectWall(b, bounds, t);
    if (w) evWall[i] = { time: w.time, kind: 'wall', i, axis: w.axis };
  };
  const setPock = (i) => {
    evPock[i] = null;
    const b = balls[i];
    if (!isMoving(b, t)) return;
    const pk = detectPocket(b, pocketList, t);
    if (pk) evPock[i] = { time: pk.time, kind: 'pocket', i, pocketIndex: pk.pocketIndex };
  };
  const setPair = (i, j) => {
    evPair[i * N + j] = null;
    const a = balls[i];
    const b = balls[j];
    if (a.pocketed || b.pocketed) return;
    if (!isMoving(a, t) && !isMoving(b, t)) return;
    const tp = detectPair(a, b, t);
    if (tp < Infinity) evPair[i * N + j] = { time: tp, kind: 'pair', i, j };
  };
  const recompute = (k) => {
    setWall(k);
    setPock(k);
    for (let m = 0; m < N; m++) {
      if (m === k) continue;
      if (k < m) setPair(k, m);
      else setPair(m, k);
    }
  };
  const clearBody = (i) => {
    evWall[i] = null;
    evPock[i] = null;
    for (let m = 0; m < N; m++) {
      if (m === i) continue;
      evPair[i < m ? i * N + m : m * N + i] = null;
    }
  };

  for (let i = 0; i < N; i++) {
    setWall(i);
    setPock(i);
    for (let j = i + 1; j < N; j++) setPair(i, j);
  }

  while (count < cap) {
    const horizon = balls.reduce((m, b) => (isMoving(b, t) ? Math.max(m, stopAbs(b)) : m), t);
    if (horizon <= t) break; // everything at rest or pocketed

    let next = null;
    const consider = (ev) => {
      if (!ev || ev.time <= t) return;
      if (!next || ev.time < next.time - 1e-12) {
        next = ev;
      } else if (ev.time <= next.time + 1e-12) {
        const a = [KIND_RANK[ev.kind], ev.i, ev.j ?? -1];
        const b = [KIND_RANK[next.kind], next.i, next.j ?? -1];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) next = ev;
      }
    };
    for (let i = 0; i < N; i++) {
      consider(evWall[i]);
      consider(evPock[i]);
      for (let j = i + 1; j < N; j++) consider(evPair[i * N + j]);
    }

    if (!next) {
      advance(balls, horizon); // coast to rest
      t = horizon;
      if (wantTimeline) timeline.push(snap(balls, t, 'end'));
      break;
    }

    advance(balls, next.time);
    t = next.time;

    let intensity = 0;
    let hit = null;
    if (next.kind === 'wall') {
      const b = balls[next.i];
      intensity = resolveWall(b, next.axis, CUSHION_RESTITUTION, 1e-3, CUSHION_FRICTION_T);
      hit = { id: b.id };
      if (contactBall && b.id === contactBall) cushionHits += 1;
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'pocket') {
      const b = balls[next.i];
      b.pocketed = true;
      b.vel = v.vec(0, 0);
      b.spin = { x: 0, y: 0, z: 0 };
      b.pocket = next.pocketIndex;
      hit = { id: b.id };
      clearBody(next.i);
    } else {
      const a = balls[next.i];
      const b = balls[next.j];
      intensity = resolvePair(a, b, BALL_RESTITUTION, BALL_FRICTION_T);
      hit = { a: a.id, b: b.id };
      if (contactBall && (a.id === contactBall || b.id === contactBall)) {
        const other = a.id === contactBall ? b.id : a.id;
        if (firstContact === null) firstContact = other;
        cueContacts.push(other);
      }
      a.replan();
      a.t0 = t;
      b.replan();
      b.t0 = t;
      recompute(next.i);
      recompute(next.j);
    }

    if (wantTimeline) timeline.push(snap(balls, t, next.kind, intensity, hit));
    count += 1;
  }

  return {
    balls,
    timeline,
    pocketed: balls.filter((b) => b.pocketed).map((b) => b.id),
    firstContact, // id of the first object ball `contactBall` touched, or null
    cueContacts, // ids of every ball `contactBall` touched, in order
    cushionHits, // number of cushions `contactBall` hit
    settled: balls.every((b) => b.pocketed || !isMoving(b, t)),
    events: count,
    hitCap: count >= MAX_EVENTS,
  };
}
