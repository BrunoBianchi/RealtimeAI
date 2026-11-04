const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, indexHtml, tags, settle } = require('./helpers/renderer');
const { css } = require('./helpers/css');

test('Clean Sidebar: brand, new session, navigation, next interviews, usage and profile', () => {
  const aside = indexHtml.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)[1];
  assert.ok(aside.includes('id="engineStatusPill"'), 'engine status next to the brand');
  assert.ok(/id="btnNewSession"[^>]*data-action="new-session"/.test(aside));
  for (const id of ['sideNav', 'sidebarNext', 'sidebarUsage', 'profileRow']) assert.ok(aside.includes(`id="${id}"`), id);
  assert.match(css, /--sidebar-w:\s*\d+px/, 'sidebar width is a token');

  const soon = new Date(Date.now() + 2 * 86400000);
  const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const r = loadRenderer({
    state: {
      agents: [
        { id: 'a1', company: 'Nubank', role: 'Backend', next_interview_date: iso, next_interview_time: '15:00' },
        { id: 'a2', company: 'Stone', role: 'SRE' },
        { id: 'a3', company: 'Itaú', role: 'Dados', archived: true, next_interview_date: iso }
      ],
      config: { has_deepgram_key: true, has_llm_key: true }
    }
  });
  r.Cue.state.route = { view: 'sessions', parts: [] };
  r.Cue.renderShell();

  const nav = r.page('sideNav').innerHTML;
  assert.deepStrictEqual(tags(nav, { 'data-action': 'go' }).map((t) => t['data-to']), ['home', 'sessions', 'history', 'files', 'questions', 'mock', 'live', 'settings']);
  assert.ok(/class="nav-item active"[^>]*data-to="sessions"/.test(nav), 'current route is highlighted');
  assert.ok(nav.includes('<span class="nav-count">2</span>'), 'active (non-archived) sessions are counted');

  const next = r.page('sidebarNext').innerHTML;
  assert.ok(next.includes('Up next') && next.includes('Nubank · Backend') && next.includes('15:00') && next.includes('in 2 days'));
  assert.ok(!next.includes('Itaú'), 'archived sessions are not "up next"');

  assert.strictEqual(r.page('engineStatusLabel').textContent, 'Ready', 'both keys configured');
});

test('Easy Goal Creation: the new-session wizard asks the essentials and creates the session', async () => {
  const saved = [];
  const r = loadRenderer({
    state: { agents: [] },
    api: {
      saveAgent: async (a) => {
        saved.push(a);
        return { ok: true, agents: [a], saved: a };
      },
      scheduleInterview: async () => ({ ok: true, agents: [], calendar: { ok: true, skipped: true } })
    }
  });
  r.Cue.openModal('new-session');
  const step1 = r.modals.last;
  assert.ok(step1.includes('New session') && step1.includes('Step 1 / 2'));
  for (const id of ['nsRole', 'nsCompany', 'nsDate', 'nsTime', 'nsJob']) assert.ok(step1.includes(`id="${id}"`), id);
  assert.ok(/id="nsRole"[^>]*autofocus/.test(step1), 'role field is focused first');
  assert.ok(tags(step1).filter((t) => t['data-ns-format']).length >= 4, 'interview formats');

  const box = r.dialogs[0].querySelector('#nsModal');
  const clickOn = (attr) => box.fire('click', { target: { closest: (sel) => (sel === `[${attr}]` ? { dataset: {} } : null) } });
  const field = (id, value) => (box.querySelector(`#${id}`).value = value);

  // Nothing typed: the wizard refuses to continue.
  await clickOn('data-ns-next');
  assert.ok(r.toasts().some((t) => t.error && t.text === 'Enter at least the role or the company.'));
  assert.ok(box.innerHTML.includes('Step 1 / 2'));

  field('nsRole', 'Backend Engineer');
  field('nsCompany', 'nubank.com.br');
  field('nsDate', '2099-02-01');
  field('nsTime', '11:00');
  field('nsJob', 'Go e Kafka');
  await clickOn('data-ns-next');
  assert.ok(box.innerHTML.includes('Step 2 / 2') && box.innerHTML.includes('id="nsResearch"'));
  box.querySelector('#nsResearch').checked = false;
  await clickOn('data-ns-next');
  await settle();

  assert.strictEqual(saved.length, 1);
  const a = saved[0];
  assert.strictEqual(a.company, 'Nubank', 'a domain becomes the brand name');
  assert.strictEqual(a.role, 'Backend Engineer');
  assert.strictEqual(a.job_description, 'Go e Kafka');
  assert.strictEqual(a.next_interview_date, '2099-02-01');
  assert.strictEqual(r.called('companyRecon').length, 0, 'research switched off');
  assert.deepStrictEqual(r.called('scheduleInterview'), [[{ goalId: a.id, date: '2099-02-01', time: '11:00' }]]);
  assert.strictEqual(r.location.hash, `#/session/${a.id}`, 'opens the new session');
});
