'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { entitlement, PRICING } = require('../src/main/plans');

test('purchased tokens let a Free account start after the trial', () => {
  const ent = entitlement({ plan: { id: 'free', minutes_used: 15, sessions_used: 1, credit_minutes: 60, max_session_minutes: 75 } });
  assert.strictEqual(ent.canStart, true);
  assert.strictEqual(ent.creditMinutes, 60);
  assert.strictEqual(ent.leftMinutes, 0);
  assert.strictEqual(ent.maxSessionMinutes, 60);
  assert.strictEqual(entitlement({ plan: { id: 'free', sessions_used: 1 } }).canStart, false);
});

test('the Plan page shows the same catalog as plans.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
  assert.ok(src.includes(`PRO_PRICE = ${PRICING.proMonthly}`));
  for (const p of PRICING.packs) assert.ok(src.includes(`{ id: '${p.id}', minutes: ${p.minutes}, price: ${p.price} }`), p.id);
});
