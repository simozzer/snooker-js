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
