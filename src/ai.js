// ai.js — the computer opponent, variant-driven.
//
// candidateShots — ghost-ball aims (strike the target one ball-diameter back along the line
//   from the pocket), generated from the variant's legal targets and pockets, ranked by
//   geometry. When ball-in-hand, the variant supplies candidate cue placements.
// chooseShot — simulation-scored selection: run the real engine to rest over a small
//   power × angle × spin grid around each top candidate and keep the best-scoring outcome
//   (legal first contact, pot the ball-on, no scratch). Optional robustness pass averages the
//   score over an execution-error box so the AI plays to its own reliability.

import * as v from './vec2.js';
import { simulate } from './simulate.js';
import { buildBalls } from './game.js';
import { MAX_SPEED, MU_ROLL, GRAVITY } from './snooker.js';

const A_ROLL = MU_ROLL * GRAVITY;

function candidatesFrom(state, cuePos) {
  const variant = state.variant;
  const R = variant.ball.radius;
  const out = [];
  for (const T of variant.aiTargets(state)) {
    for (const pk of variant.pockets()) {
      const toP = v.sub(pk.center, T.pos);
      const dP = v.len(toP);
      if (dP < 1e-6) continue;
      const dir = v.scale(toP, 1 / dP);
      const ghost = v.sub(T.pos, v.scale(dir, 2 * R));
      const sc = v.sub(ghost, cuePos);
      const scLen = v.len(sc);
      if (scLen < 1e-6) continue;
      const align = v.dot(v.scale(sc, 1 / scLen), dir);
      if (align <= 0.25) continue;
      const pathLen = scLen + dP;
      const speed = Math.max(1.0, Math.min(MAX_SPEED, Math.sqrt(2 * A_ROLL * pathLen) * 1.6 + 0.6));
      out.push({ cuePos: { ...cuePos }, angle: Math.atan2(sc.y, sc.x), speed, geom: align - 0.15 * pathLen });
    }
  }
  return out;
}

function candidateShots(state) {
  const variant = state.variant;
  // pocketless games (carom) can't use ghost-ball-into-a-pocket aiming — they supply their own
  if (variant.aiCandidates) return variant.aiCandidates(state).sort((a, b) => b.geom - a.geom);
  const cue = state.pieces.find((p) => p.id === 'cue');
  let out = [];
  if (state.frame.ballInHand || !cue) {
    for (const cp of variant.aiPlacements(state)) out = out.concat(candidatesFrom(state, cp));
  } else {
    out = candidatesFrom(state, cue.pos);
  }
  out.sort((a, b) => b.geom - a.geom);
  return out;
}

// --- positional play (Tier 2: feasibility-aware leave) ---
// A secondary term that rewards leaving the cue ball where the NEXT shot is actually MAKEABLE. It
// is a single-ply look-ahead that REUSES what we already computed: the shot is simulated to rest,
// so the cue ball's resting position and the surviving layout are in `res`. We learn the next
// ball-on (and whether we keep the table) by replaying the variant's OWN rules on a throwaway copy
// of the frame, then score the best next pot from the cue's rest spot — not by raw geometry, but
// by a pot-PROBABILITY proxy that accounts for cut angle, shot length, and OBSTRUCTION of both the
// cue→ghost and ball→pocket lines. Weighted below a pot, so it only biases the leave.
const POSITION_WEIGHT = 36;
const LEAVE_EFOLD = 1.6; // metres: shot-length e-folding in the pot-probability proxy

// Distance from point C to segment A→B (both endpoints inclusive).
function segPointDist(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(cx - px, cy - py);
}

// Is the straight corridor from A to B clear of every blocker centre (ignoring ids in `skip`)?
function pathClear(A, B, blockers, clearance, skip) {
  for (const b of blockers) {
    if (skip.has(b.id)) continue;
    if (segPointDist(A.x, A.y, B.x, B.y, b.pos.x, b.pos.y) < clearance) return false;
  }
  return true;
}

// Best makeable next pot from `cuePos`, as a [0,1] pot-probability proxy. Considers every legal
// next target into every pocket: rejects thin cuts and blocked lines, then scores by cut angle
// (cos²) × shot-length decay. 0 means snookered / nothing on.
function bestNextPotProb(state, cuePos) {
  const variant = state.variant;
  const R = variant.ball.radius;
  const targets = variant.aiTargets(state);
  const pockets = variant.pockets();
  const blockers = state.pieces;
  const clearance = 2 * R - 1e-3;
  let best = 0;
  for (const T of targets) {
    const skipCG = new Set(['cue', T.id]); // cue→ghost: ignore the cue itself and the target
    const skipTP = new Set([T.id]); // target→pocket: ignore the target
    for (const pk of pockets) {
      const toP = v.sub(pk.center, T.pos);
      const dTP = v.len(toP);
      if (dTP < 1e-6) continue;
      const dir = v.scale(toP, 1 / dTP);
      const ghost = v.sub(T.pos, v.scale(dir, 2 * R));
      const sc = v.sub(ghost, cuePos);
      const dCG = v.len(sc);
      if (dCG < 1e-6) continue;
      const cosCut = v.dot(v.scale(sc, 1 / dCG), dir);
      if (cosCut <= 0.2) continue; // beyond ~78° cut: treat as unmakeable
      if (!pathClear(cuePos, ghost, blockers, clearance, skipCG)) continue;
      if (!pathClear(T.pos, pk.center, blockers, clearance, skipTP)) continue;
      const p = cosCut * cosCut * Math.exp(-(dCG + dTP) / LEAVE_EFOLD);
      if (p > best) best = p;
    }
  }
  return best;
}

function positionBonus(state, res, pieceById) {
  const variant = state.variant;
  if (!variant.applyOutcome || !variant.aiTargets) return 0;

  // build the rules info the variant expects (pieces, not ids)
  const potted = [];
  let cuePotted = false;
  for (const id of res.pocketed) {
    if (id === 'cue') { cuePotted = true; continue; }
    const p = pieceById.get(id);
    if (p) potted.push(p);
  }
  const firstContact = res.firstContact ? pieceById.get(res.firstContact) : null;
  const cueContacts = (res.cueContacts || []).map((id) => pieceById.get(id)).filter(Boolean);

  // ask the variant's real rules what happens next, on a disposable frame copy
  const nf = structuredClone(state.frame);
  let next;
  try {
    next = variant.applyOutcome(nf, { firstContact, potted, cuePotted, cueContacts, cushionHits: res.cushionHits || 0 });
  } catch {
    return 0;
  }
  if (!next || !next.continues || next.foul) return 0; // turn ends → our leave doesn't matter

  // cue's resting position; if it's gone (scratch) there's no position to value
  const cueBall = res.balls.find((b) => b.id === 'cue');
  if (!cueBall || cueBall.pocketed) return 0;

  // the surviving table after the shot, paired with the advanced (cloned) frame
  const survivors = res.balls
    .filter((b) => !b.pocketed)
    .map((b) => { const p = pieceById.get(b.id); return p ? { ...p, pos: { x: b.pos.x, y: b.pos.y } } : null; })
    .filter(Boolean);
  const nextState = { variant, frame: nf, pieces: survivors };

  const prob = bestNextPotProb(nextState, { x: cueBall.pos.x, y: cueBall.pos.y });
  if (prob <= 0) return -0.35 * POSITION_WEIGHT; // continued, but snookered / no makeable next shot
  return POSITION_WEIGHT * prob;
}

function scoreOutcome(state, res, pieceById) {
  const variant = state.variant;
  const frame = state.frame;
  if (variant.aiScore) return variant.aiScore(state, res, pieceById); // carom & other non-pot games
  let score = 0;
  let cuePotted = false;
  const potted = [];
  for (const id of res.pocketed) {
    if (id === 'cue') cuePotted = true;
    else potted.push(pieceById.get(id));
  }
  const fc = res.firstContact ? pieceById.get(res.firstContact) : null;
  if (!variant.aiLegalFirst(frame, fc)) score -= 300;
  if (cuePotted) score -= 400;
  for (const p of potted) {
    if (variant.aiLegalPot(frame, p)) score += variant.aiValue(frame, p) + (variant.aiWinBonus ? variant.aiWinBonus(frame, p) : 0);
    else score -= variant.aiPenalty ? variant.aiPenalty(frame, p) : variant.aiValue(frame, p);
  }
  score += positionBonus(state, res, pieceById);
  return score;
}

function simScore(state, cuePos, angle, speed, spin) {
  const variant = state.variant;
  const pieces = state.pieces.map((p) => (p.id === 'cue' ? { ...p, pos: { ...cuePos } } : p));
  if (!pieces.some((p) => p.id === 'cue')) pieces.push({ id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...cuePos } });
  const balls = buildBalls(pieces, variant.ball);
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle, speed, spin }, { timeline: false, contactBall: 'cue' });
  return scoreOutcome(state, res, pieceById);
}

// Pick a shot. Returns { cuePos, angle, speed, spin:{side,vert}, score }. The caller maps
// cuePos → cuePlacement when the frame owes ball-in-hand. opts: maxCandidates / powerScales /
// angleOffsets / spins (search) and robust:{ angleErr, speedPct, keep } (play-to-reliability).
export function chooseShot(state, opts = {}) {
  const variant = state.variant;
  const maxCandidates = opts.maxCandidates ?? 8;
  const powerScales = opts.powerScales ?? [0.85, 1.0, 1.25, 1.6];
  const angleOffsets = opts.angleOffsets ?? [-0.012, -0.004, 0, 0.004, 0.012];
  const spins = opts.spins ?? [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }];
  const robust = opts.robust ?? null;
  const cands = candidateShots(state).slice(0, maxCandidates);

  const scored = [];
  for (const c of cands) {
    for (const ps of powerScales) {
      const speed = Math.max(1.0, Math.min(MAX_SPEED, c.speed * ps));
      for (const ao of angleOffsets) {
        const angle = c.angle + ao;
        for (const sp of spins) {
          const score = simScore(state, c.cuePos, angle, speed, sp) + c.geom;
          scored.push({ cuePos: c.cuePos, angle, speed, spin: sp, score });
        }
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);

  let best = scored[0] ?? null;
  if (best && robust && (robust.angleErr > 0 || robust.speedPct > 0)) {
    const keep = Math.min(robust.keep ?? 5, scored.length);
    best = null;
    for (const cand of scored.slice(0, keep)) {
      let sum = cand.score;
      let n = 1;
      for (const da of [-1, 0, 1]) {
        for (const ds of [-1, 0, 1]) {
          if (da === 0 && ds === 0) continue;
          const angle = cand.angle + da * robust.angleErr;
          const speed = Math.max(1.0, Math.min(MAX_SPEED, cand.speed * (1 + ds * robust.speedPct)));
          sum += simScore(state, cand.cuePos, angle, speed, cand.spin);
          n += 1;
        }
      }
      const expected = sum / n;
      if (!best || expected > best.score) best = { ...cand, score: expected };
    }
  }
  if (best && best.score > 0) return best;

  // No clean pot found: roll toward the nearest legal target (avoids a no-hit foul).
  const cue = state.pieces.find((p) => p.id === 'cue');
  const cuePos = state.frame.ballInHand || !cue ? variant.defaultPlacement(state) : cue.pos;
  const targets = variant.aiTargets(state);
  let tgt = targets[0];
  let dmin = Infinity;
  for (const t of targets) {
    const d = (t.pos.x - cuePos.x) ** 2 + (t.pos.y - cuePos.y) ** 2;
    if (d < dmin) { dmin = d; tgt = t; }
  }
  const angle = tgt ? Math.atan2(tgt.pos.y - cuePos.y, tgt.pos.x - cuePos.x) : 0;
  return { cuePos, angle, speed: 1.6, spin: { side: 0, vert: 0 }, score: best ? best.score : -1000 };
}

// Execution error applied to the chosen shot: a random ±angleErr (rad) on the aim and
// ±speedPct on the power. Larger = an easier, less accurate opponent. cuePos is left as chosen.
export function applyError(shot, { angleErr = 0, speedPct = 0 } = {}, rng = Math.random) {
  return {
    ...shot,
    angle: shot.angle + (rng() * 2 - 1) * angleErr,
    speed: Math.max(0.4, Math.min(MAX_SPEED, shot.speed * (1 + (rng() * 2 - 1) * speedPct))),
  };
}
