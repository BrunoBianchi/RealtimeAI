'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { entitlement, PRICING } = require('../src/main/plans');

test('purchased minutes let a Free account start after the trial', () => {
  const ent = entitlement({ plan: { id: 'free', minutes_used: 15, sessions_used: 1, credit_minutes: 60, max_session_minutes: 75 } });
  assert.strictEqual(ent.canStart, true);
  assert.strictEqual(ent.creditMinutes, 60);
  assert.strictEqual(ent.leftMinutes, 0);
  assert.strictEqual(ent.maxSessionMinutes, 60);
  assert.strictEqual(entitlement({ plan: { id: 'free', sessions_used: 1 } }).canStart, false);
});

test('a Free account with 15 minutes can train (one balance in minutes)', () => {
  const ent = entitlement({ plan: { id: 'free', minutes_limit: 15, minutes_used: 0, minutes_left: 15, training: { rate: 1, max_minutes: 15, free_under_s: 60 } } });
  assert.strictEqual(ent.minutesLeft, 15);
  assert.deepStrictEqual(ent.training, { maxMinutes: 15, freeUnderS: 60 });
  assert.strictEqual(ent.canMock, true);
  assert.strictEqual('mockTokens' in ent, false, 'no token wallet anymore');
});

test('minutes_left is the authority; without it the app derives it like the server', () => {
  assert.strictEqual(entitlement({ plan: { id: 'pro', minutes_left: 0.5 } }).canMock, false, 'under one minute');
  assert.strictEqual(entitlement({ plan: { id: 'free' } }).minutesLeft, 15);
  assert.strictEqual(entitlement({ plan: { id: 'free', sessions_used: 1, credit_minutes: 20 } }).minutesLeft, 20);
  assert.strictEqual(entitlement({ plan: { id: 'free', sessions_used: 1 } }).canMock, false);
  assert.strictEqual(entitlement({ plan: { id: 'pro', minutes_used: 50, credit_minutes: 10 } }).minutesLeft, 160);
  assert.strictEqual(entitlement({ plan: { id: 'pro', minutes_left: 30 } }).training, null, 'older server: no training block');
});

test('the Plan page shows the same catalog as plans.js and no mock packs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
  assert.ok(src.includes(`PRO_PRICE = ${PRICING.proMonthly}`));
  for (const p of PRICING.packs) assert.ok(src.includes(`{ id: '${p.id}', minutes: ${p.minutes}, price: ${p.price} }`), p.id);
  assert.strictEqual(PRICING.mockPacks, undefined);
  assert.doesNotMatch(src, /mock_tokens_\d+|MOCK_PACKS/);
});
