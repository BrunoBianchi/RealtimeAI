const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, indexHtml, render, tags, settle } = require('./helpers/renderer');
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
  assert.deepStrictEqual(tags(nav, { 'data-action': 'go' }).map((t) => t['data-to']), ['home', 'sessions', 'history', 'files', 'questions', 'mock', 'pair', 'live', 'settings']);
  assert.ok(/class="nav-item active"[^>]*data-to="sessions"/.test(nav), 'current route is highlighted');
  assert.ok(nav.includes('<span class="nav-count">2</span>'), 'active (non-archived) sessions are counted');
  assert.match(nav, /aria-current="page"/);
  assert.match(nav, /nav-count">new<\/span>/);
  assert.match(nav, /nav-live-dot" title="Ready"/);

  const next = r.page('sidebarNext').innerHTML;
  assert.ok(next.includes('Up next') && next.includes('company-tile nubank') && next.includes('Backend') && next.includes('15:00') && next.includes('in 2d'));
  assert.ok(!next.includes('Itaú'), 'archived sessions are not "up next"');

  assert.strictEqual(r.page('engineStatusLabel').textContent, 'Ready', 'both keys configured');
});

test('Home uses the scheduled job for preparation and links each recent record to its review', async () => {
  const date = new Date(Date.now() + 5 * 864e5);
  const iso = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((v) => String(v).padStart(2, '0')).join('-');
  const agent = {
    id: 'a1', company: 'Itaú Unibanco', role: 'Data Analyst', next_interview_date: iso,
    job_description: 'SQL role', documents: [{ title: 'CV', tag: 'resume' }]
  };
  const r = loadRenderer({
    state: {
      agents: [agent],
      sessions: [{ id: 's1', goalLabel: 'Itaú Unibanco · Data Analyst', startedAt: new Date(Date.now() - 864e5).toISOString(), jevScore: 78, questionsCount: 6 }],
      meeting: { active: [{ name: 'Meet' }] },
      questionBank: { companies: [{ id: 'itau', name: agent.company, questions: Array.from({ length: 5 }, (_, n) => ({ text: `SQL question ${n}` })) }] }
    },
    api: {
      mockList: async () => [{ id: 'm1', agentId: 'other', startedAt: Date.now(), role: 'Backend', company: 'Nubank', evaluation: { score: 84, items: [{}] } }],
      saveChecklist: async (_id, state) => ({ ok: true, agents: [{ ...agent, checklist_state: state }] })
    }
  });
  r.Cue.loadMockRecords();
  await settle();
  const home = render(r.Cue, 'home');
  assert.match(home, /3 prep steps left/);
  assert.match(home, /Practice 5 SQL questions from the bank/);
  assert.match(home, /data-action="mock-for-agent" data-agent="a1"/);
  assert.match(home, /Meet detected/);
  assert.match(home, /data-action="mock-open" data-id="m1"[\s\S]*data-to="review\/s1"/);
  assert.match(home, /company-tile itau/);

  await r.Cue.actions['home-checklist']({ dataset: { agent: 'a1', key: 'home_audio_tested' } });
  assert.deepEqual(r.called('saveChecklist'), [['a1', { home_audio_tested: true }]]);
  assert.match(render(r.Cue, 'home'), /2 prep steps left/);
  await r.Cue.actions['home-practice-questions']({ dataset: { agent: 'a1' } });
  assert.equal(r.S.ui.qCompany, 'itau');
  assert.equal(r.S.ui.qQuery, 'SQL');
  assert.equal(r.location.hash, '#/questions');
  r.Cue.actions['mock-open']({ dataset: { id: 'm1' } });
  assert.equal(r.location.hash, '#/mock');
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
