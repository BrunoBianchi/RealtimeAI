const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, render, el, tags, settle } = require('./helpers/renderer');

test('Feature: Plan & usage come from the local profile and the recorded sessions', () => {
  const now = new Date();
  const thisMonth = (min) => ({ startedAt: new Date(now.getFullYear(), now.getMonth(), 1, 9).toISOString(), durationSeconds: min * 60, questionsCount: 3, suggestions: 5 });
  const lastYear = { startedAt: new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString(), durationSeconds: 3600 };
  const usage = (profile, sessions) => loadRenderer({ state: { profile, sessions } }).Cue.usage();

  const free = usage({ plan: 'free', transcriptionUsage: { limitMinutes: 120 } }, [thisMonth(30), thisMonth(60), lastYear]);
  assert.strictEqual(free.planLabel, 'Free');
  assert.strictEqual(free.usedMin, 90, 'only this month counts');
  assert.strictEqual(free.limit, 120);
  assert.strictEqual(free.pct, 75);
  assert.strictEqual(free.left, 30);
  assert.strictEqual(free.sessions, 2);
  assert.strictEqual(free.questions, 6);
  assert.strictEqual(free.answers, 10);

  const pro = usage({ plan: 'premium', transcriptionUsage: { limitMinutes: 120 } }, [thisMonth(500)]);
  assert.strictEqual(pro.planLabel, 'Pro');
  assert.strictEqual(pro.limit, null, 'Pro has no monthly limit');
  assert.strictEqual(pro.pct, null);

  const over = usage({ plan: 'free', transcriptionUsage: { limitMinutes: 60 } }, [thisMonth(90)]);
  assert.strictEqual(over.pct, 100, 'meter is capped');
  assert.strictEqual(over.left, 0);

  const unset = usage({}, []);
  assert.strictEqual(unset.planLabel, 'Free');
  assert.strictEqual(unset.limit, null, 'no limit set: none is invented');
});

test('Feature: Library (Arquivos) lists every file with its session, type and status', () => {
  const agents = [
    { id: 'a1', company: 'Nubank', role: 'Backend', documents: [{ title: 'cv.pdf', tag: 'resume', content: 'Go' }, { title: 'scan.pdf', tag: 'material', content: '' }] },
    { id: 'a2', company: 'Stone', role: 'SRE', documents: [{ title: 'vaga.txt', tag: 'job', content: 'SRE' }] }
  ];
  const r = loadRenderer({ state: { agents } });
  let html = render(r.Cue, 'files');
  assert.ok(html.includes('3 files'));
  assert.ok(tags(html, { 'data-action': 'files-pick' }).length === 1 && html.includes('id="filesDrop"'), 'drop zone / picker');
  assert.deepStrictEqual(tags(html, { 'data-change': 'files-target' }).length, 1, 'choose the session new files go to');
  assert.ok(/data-to="session\/a2"[^>]*>Stone · SRE</.test(html), 'each file links to its session');
  assert.strictEqual((html.match(/>Indexado</g) || []).length, 2);
  assert.strictEqual((html.match(/>Sem texto</g) || []).length, 1, 'a scan with no readable text is flagged');
  assert.ok(/data-change="doc-tag"[^>]*data-agent="a1" data-idx="0">[\s\S]*?<option value="resume" selected>/.test(html), 'type is editable');

  // Search filters by name, session or type.
  r.S.ui.filesQuery = 'stone';
  html = render(r.Cue, 'files');
  assert.ok(html.includes('1 file') && html.includes('vaga.txt') && !html.includes('cv.pdf'));
  r.S.ui.filesQuery = 'zzz';
  assert.ok(render(r.Cue, 'files').includes('No files match this search.'));

  // No session yet: the page offers to create one instead of a dead drop zone.
  const none = render(loadRenderer().Cue, 'files');
  assert.ok(none.includes('Create a session to attach files') && tags(none, { 'data-action': 'new-session' }).length === 1);
});

test('Feature: playbooks are chosen per session and applied with their settings', async () => {
  const pb = { name: 'Conciso', answer_length: 'Concise', behavioral_structure: 'Auto', lead_with_answer: true, name_tradeoffs: false };
  const agent = { id: 'a1', company: 'Nubank', role: 'Backend' };
  const r = loadRenderer({
    state: { agents: [agent], playbooks: [pb] },
    api: { saveAgent: async (a) => ({ ok: true, agents: [a], saved: a }) }
  });
  const html = render(r.Cue, 'session/a1');
  const select = html.slice(html.indexOf('data-change="agent-playbook"'));
  assert.ok(select.includes('<option value="Conciso"') && select.includes('<option value="Standard STAR" selected>'), 'saved playbooks plus the default');

  await r.Cue.changes['agent-playbook'](el({ agent: 'a1' }, { value: 'Conciso' }));
  await settle();
  const [[saved]] = r.called('saveAgent');
  assert.strictEqual(saved.playbook_name, 'Conciso');
  assert.strictEqual(saved.playbook_answer_length, 'Concise');
  assert.strictEqual(saved.playbook_lead_with_answer, true);
  assert.ok(r.toasts().some((t) => t.text === 'Playbook "Conciso" applied.'));
});

test('Feature: the Ctrl+K palette finds actions, sessions, files and questions', async () => {
  const r = loadRenderer({
    state: {
      agents: [{ id: 'a1', company: 'Nubank', role: 'Backend', documents: [{ title: 'portfolio.pdf', tag: 'portfolio', content: 'x' }] }],
      questionBank: { companies: [{ id: 'nu', name: 'Nubank', questions: [{ text: 'Como você escala Kafka?' }, { text: 'Segredo', locked: true }] }] }
    }
  });
  r.Cue.openModal('palette');
  const L = r.dialogs[0];
  const list = L.querySelector('#pcList');
  assert.ok(list.innerHTML.includes('New session') && list.innerHTML.includes('Go to'), 'empty query: actions and destinations');
  const search = async (q) => {
    L.querySelector('#pcQuery').value = q;
    await L.querySelector('#pcQuery').fire('input');
    return list.innerHTML;
  };
  assert.ok((await search('nubank')).includes('Nubank · Backend'), 'sessions');
  assert.ok((await search('portfolio')).includes('portfolio.pdf'), 'files');
  assert.ok((await search('kafka')).includes('Como você escala Kafka?'), 'unlocked questions');
  assert.ok(!(await search('segredo')).includes('Segredo'), 'locked questions stay hidden');
  assert.ok((await search('xyzzy')).includes('Nothing found.'));
});
