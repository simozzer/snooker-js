import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { chooseShot } from '../src/ai.js';
import { HX, HY } from '../src/table.js';

// With a red sitting in front of a corner pocket and the cue behind it, the AI should find a
// positive-scoring potting line — and executing it through the game must actually pot the red.
test('the AI finds and executes a clear pot', () => {
  const g = newGame();
  g.pieces = [
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: 0.9, y: -0.45 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: HX - 0.35, y: -HY + 0.35 } },
  ];
  g.frame.reds = 1;
  g.frame.ballInHand = false;

  const shot = chooseShot(g);
  assert.ok(shot.score > 0, `AI found no pot (score ${shot.score})`);

  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin });
  assert.ok(!outcome.foul, `AI shot fouled: ${outcome.message}`);
  assert.equal(g.frame.scores[0], 1, `expected a pot; got ${outcome.message}`);
});

// On the opening break (ball-in-hand), the AI returns a legal placement in the D and a shot
// that doesn't immediately foul (it should at least strike a red).
test('the AI plays a legal break', () => {
  const g = newGame();
  const shot = chooseShot(g);
  // cue placement must be in the D region (behind the baulk line, −x side)
  assert.ok(shot.cuePos.x <= 0, 'break cue placed on the baulk side');
  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePos });
  assert.ok(!outcome.foul, `break fouled: ${outcome.message}`);
});
