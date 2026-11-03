const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, indexHtml } = require('./helpers/renderer');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

// A session recorded on `day` of the current month.
function thisMonth(day, minutes) {
  const now = new Date();
  return { id: `s${day}`, startedAt: new Date(now.getFullYear(), now.getMonth(), day, 10).toISOString(), durationSeconds: minutes * 60 };
}

test('Audio Usage & Premium: sidebar usage card shows real minutes against the plan limit', () => {
  assert.ok(/id="sidebarUsage"[^>]*data-to="settings\/plan"/.test(indexHtml), 'usage card opens Settings > Plan');
  assert.ok(indexHtml.includes('id="profilePlan"'), 'profile row shows the plan');

  const free = loadRenderer({
    state: {
      profile: { name: 'Ana', plan: 'free', transcriptionUsage: { limitMinutes: 300 } },
      sessions: [thisMonth(1, 25), thisMonth(2, 20)]
    }
  });
  free.Cue.renderShell();
  const card = free.page('sidebarUsage').innerHTML;
  assert.ok(card.includes('>45<'), 'minutes transcribed this month');
  assert.ok(card.includes('/ 300 min'), 'monthly limit');
  assert.ok(card.includes('255 min left'), 'minutes left');
  assert.ok(card.includes('usage-ticks'), 'progress ticks while there is a limit');
  assert.strictEqual(free.page('profilePlan').textContent, 'Free plan');

  // Premium has no monthly limit: no ticks, the count of sessions instead.
  const pro = loadRenderer({
    state: { profile: { plan: 'premium', transcriptionUsage: { limitMinutes: 300 } }, sessions: [thisMonth(1, 25)] }
  });
  pro.Cue.renderShell();
  const proCard = pro.page('sidebarUsage').innerHTML;
  assert.ok(proCard.includes('min transcribed') && !proCard.includes('usage-ticks'));
  assert.ok(proCard.includes('1 session'));
  assert.strictEqual(pro.page('profilePlan').textContent, 'Pro plan');
});

test('Audio Usage & Premium: main.js provides default profile with plan and usage', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('plan'), 'main.js should reference plan in profile');
  assert.ok(mainJs.includes('transcriptionUsage'), 'main.js should reference transcriptionUsage');
  assert.ok(mainJs.includes('usedMinutes'), 'main.js should initialize usedMinutes');
  assert.ok(mainJs.includes('limitMinutes'), 'main.js should initialize limitMinutes');
});

test('Audio Usage & Premium: Settings > Plan shows the account plan, the meter and usage by month', () => {
  const { entitlement } = require('../src/main/plans');
  const pro = entitlement({ plan: { id: 'pro', minutes_limit: 200, minutes_used: 188, period_end: '2026-12-01' } });
  const { Cue } = loadRenderer({ state: { auth: { signedIn: true, entitlement: pro }, sessions: [thisMonth(1, 56)] } });
  const html = render(Cue, 'settings/plan');
  assert.ok(html.includes('188 of 200 min'), 'minutes of the month against the PRO limit');
  assert.ok(html.includes('12 min left'));
  assert.ok(html.includes('class="bar danger"'), 'meter turns red above 90%');
  assert.ok(html.includes('data-kind="portal"'), 'PRO manages the subscription');
  assert.ok(html.includes('56 min · 1 session'), 'usage by month comes from the recorded sessions');

  // Free whose single session is gone: the reason and the PRO checkout.
  const used = entitlement({ plan: { id: 'free', minutes_used: 15, sessions_used: 1 } });
  const free = loadRenderer({ state: { auth: { signedIn: true, entitlement: used }, sessions: [] } });
  const fh = render(free.Cue, 'settings/plan');
  assert.ok(fh.includes('You already used the free 15-minute session'));
  assert.ok(fh.includes('data-kind="checkout"'), 'Assinar PRO');
  assert.ok(fh.includes('No recorded sessions yet.'));

  // No plan read from the server: nothing is invented.
  const none = render(loadRenderer({ state: { sessions: [] } }).Cue, 'settings/plan');
  assert.ok(none.includes('Could not read the plan right now.'));
});
