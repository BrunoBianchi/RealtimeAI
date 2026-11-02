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
  assert.ok(card.includes('255 min restantes'), 'minutes left');
  assert.ok(card.includes('usage-ticks'), 'progress ticks while there is a limit');
  assert.strictEqual(free.page('profilePlan').textContent, 'Plano Free');

  // Premium has no monthly limit: no ticks, the count of sessions instead.
  const pro = loadRenderer({
    state: { profile: { plan: 'premium', transcriptionUsage: { limitMinutes: 300 } }, sessions: [thisMonth(1, 25)] }
  });
  pro.Cue.renderShell();
  const proCard = pro.page('sidebarUsage').innerHTML;
  assert.ok(proCard.includes('min transcritos') && !proCard.includes('usage-ticks'));
  assert.ok(proCard.includes('1 sessão'));
  assert.strictEqual(pro.page('profilePlan').textContent, 'Plano Pro');
});

test('Audio Usage & Premium: main.js provides default profile with plan and usage', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('plan'), 'main.js should reference plan in profile');
  assert.ok(mainJs.includes('transcriptionUsage'), 'main.js should reference transcriptionUsage');
  assert.ok(mainJs.includes('usedMinutes'), 'main.js should initialize usedMinutes');
  assert.ok(mainJs.includes('limitMinutes'), 'main.js should initialize limitMinutes');
});

test('Audio Usage & Premium: Settings > Plan shows the plan, the meter and usage by month', () => {
  const { Cue } = loadRenderer({
    state: {
      profile: { plan: 'free', email: 'ana@example.com', transcriptionUsage: { limitMinutes: 60 } },
      sessions: [thisMonth(1, 56)]
    }
  });
  const html = render(Cue, 'settings/plan');
  assert.ok(html.includes('60 minutos de transcrição por mês.'));
  assert.ok(html.includes('56 de 60 min'), 'this month against the limit');
  assert.ok(html.includes('class="bar danger"'), 'meter turns red above 90%');
  assert.ok(html.includes('Conta: ana@example.com'));
  assert.ok(html.includes('56 min · 1 sessão'), 'usage by month comes from the recorded sessions');

  // Nothing is invented when there is no data.
  const empty = loadRenderer({ state: { profile: { plan: 'premium' }, sessions: [] } });
  const none = render(empty.Cue, 'settings/plan');
  assert.ok(none.includes('Sem limite mensal de transcrição.'));
  assert.ok(none.includes('Nenhuma sessão gravada ainda.'));
});
