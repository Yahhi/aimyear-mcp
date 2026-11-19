import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amount, hours, isHardWork, percent, roundHalf, share } from '../src/domain/numbers.js';

test('multiply before dividing: 23 of 40 is 58%, not 57%', () => {
  assert.equal(Math.round((23 / 40) * 100), 57); // the trap
  assert.equal(percent(23, 40), 58);
  assert.equal(share(23, 40), 0.58);
});

test('float noise does not decide a half: 0.285 and 0.575 round up', () => {
  assert.equal(Math.round(0.285 * 100), 28); // the trap
  assert.equal(roundHalf(0.285, 2), 0.29);
  assert.equal(roundHalf(0.575, 2), 0.58);
  assert.equal(roundHalf(2.15, 1), 2.2);
});

test('halves round away from zero below zero too', () => {
  assert.equal(Math.round(-12.5), -12); // the trap
  assert.equal(roundHalf(-12.5), -13);
  assert.equal(roundHalf(-0.125, 2), -0.13);
  assert.equal(roundHalf(-0.4), 0);
});

test('round once: the NPS example from Retently gives 66, not 67', () => {
  const p = 1742, d = 274, n = 2210;
  assert.equal(percent(p, n) - percent(d, n), 67); // rounding the parts first
  assert.equal(percent(p - d, n), 66);
});

test('pool, do not average: 2 of 3 and 1 of 7 is 30%, not 41%', () => {
  assert.equal(roundHalf((percent(2, 3) + percent(1, 7)) / 2), 41); // averaging the shares
  assert.equal(percent(2 + 1, 3 + 7), 30);
});

test('hours, amounts and empty wholes', () => {
  assert.equal(hours(75), 1.3);
  assert.equal(amount(2.25), '2.3');
  assert.equal(amount(1.45), '1.5');
  assert.equal(amount(3), '3');
  assert.equal(amount(null), '0');
  assert.equal(share(5, 0), 0);
});

test('hard work: the lever decides, the classification only without a lever', () => {
  const kind = (id: string | undefined) => (id === 'out' ? 'hard' : id === 'build' ? 'comfortable' : undefined);
  assert.equal(isHardWork({ classification: 'main_step', lever_id: 'build' }, kind), false);
  assert.equal(isHardWork({ classification: 'goal_comfortable', lever_id: 'out' }, kind), true);
  assert.equal(isHardWork({ classification: 'main_step' }, kind), true);
  assert.equal(isHardWork({ classification: 'goal_comfortable' }, kind), false);
});
