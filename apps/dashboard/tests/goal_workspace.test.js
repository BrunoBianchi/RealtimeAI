const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, indexHtml, tags } = require('./helpers/renderer');

const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

const AGENT = {
  id: 'a1',
  company: 'Nubank',
  role: 'Backend Engineer',
  job_description: 'Go e Kafka',
  next_interview_date: '2099-01-10',
  next_interview_time: '10:00',
  documents: [{ title: 'cv.pdf', tag: 'resume', content: 'x'.repeat(2048) }],
  playbook_name: 'STAR executivo',
  answer_language: 'en-US',
  coding_language: 'Go',
  stage: 'Technical'
};

function workspace(agent = AGENT, state = {}) {
  const r = loadRenderer({ state: { agents: [agent], playbooks: [{ name: 'STAR executivo' }, { name: 'Conciso' }], ...state } });
  return { ...r, html: render(r.Cue, `session/${agent.id}`) };
}

const actions = (html) => tags(html, { 'data-action': true }).map((t) => t['data-action']);

test('Task 5.1 / Property 1: header of a session (back, title, date, edit, schedule, simulate, go live)', () => {
  const { html } = workspace();
  assert.ok(/data-action="go" data-to="sessions"/.test(html), 'back to Sessões');
  assert.ok(html.includes('Nubank · Backend Engineer'));
  assert.ok(html.includes('10 jan · 10:00'), 'interview date and time');
  for (const a of ['edit-session', 'open-scheduler', 'start-copilot']) assert.ok(actions(html).includes(a), a);
  const starts = tags(html, { 'data-action': 'start-copilot' });
  assert.deepStrictEqual(starts.map((s) => s['data-demo'] || ''), ['1', ''], 'Simular (demo) and Iniciar ao vivo');
  assert.ok(html.includes('Reagendar'), 'scheduled: Reagendar');

  // While this session is live the button jumps to the live view instead.
  const live = workspace(AGENT, { overlayStatus: { running: true, agentId: 'a1', mode: 'live' } });
  assert.ok(live.html.includes('Ao vivo agora') && /data-action="go" data-to="live"/.test(live.html));

  // Unknown id: a way back, not a crash.
  const r = loadRenderer();
  const missing = render(r.Cue, 'session/nope');
  assert.ok(missing.includes('Sessão não encontrada') && missing.includes('data-to="sessions"'));
});

test('Task 5.1 / Property 2: playbook and scheduler dialogs', async () => {
  const r = loadRenderer({
    state: { agents: [AGENT] },
    api: {
      savePlaybook: async (pb) => ({ ok: true, playbooks: [pb] }),
      saveAgent: async (a) => ({ ok: true, agents: [a], saved: a }),
      clearInterview: async () => ({ ok: true, calendar: { skipped: true } })
    }
  });

  r.Cue.openModal('playbook', 'a1');
  const pb = r.modals.last;
  for (const id of ['pbName', 'pbLen', 'pbStruct', 'pbLead', 'pbTrade', 'pbSave']) assert.ok(pb.includes(`id="${id}"`), id);
  assert.deepStrictEqual(tags(pb).filter((t) => t['data-v']).map((t) => t['data-v']), ['Concise', 'Balanced', 'Thorough']);
  const dlg = r.dialogs[0];
  dlg.querySelector('#pbName').value = '';
  await dlg.querySelector('#pbSave').fire('click');
  assert.strictEqual(r.called('savePlaybook').length, 0, 'a playbook needs a name');
  dlg.querySelector('#pbName').value = 'Direto';
  dlg.querySelector('#pbStruct').value = 'CAR (Context, Action, Result)';
  dlg.querySelector('#pbLead').checked = true;
  dlg.querySelector('#pbTrade').checked = true;
  await dlg.querySelector('#pbSave').fire('click');
  assert.deepStrictEqual(r.called('savePlaybook'), [[{ name: 'Direto', answer_length: 'Balanced', behavioral_structure: 'CAR (Context, Action, Result)', lead_with_answer: true, name_tradeoffs: true }]]);
  const applied = r.called('saveAgent')[0][0];
  assert.strictEqual(applied.playbook_name, 'Direto', 'saved playbook is applied to the session');

  r.Cue.openModal('scheduler', 'a1');
  const sc = r.modals.last;
  for (const id of ['scAgent', 'scDate', 'scTime', 'scSave', 'scClear']) assert.ok(sc.includes(`id="${id}"`), id);
  assert.ok(sc.includes('value="2099-01-10"') && sc.includes('value="10:00"'), 'opens on the saved date');
  const sched = r.dialogs[1];
  sched.querySelector('#scAgent').value = 'a1';
  await sched.querySelector('#scClear').fire('click');
  assert.deepStrictEqual(r.called('clearInterview'), [['a1']]);
});

test('Task 5.1 / Property 3: readiness, context and memory sections', () => {
  const { html } = workspace();
  assert.ok(html.includes('>Preparo<') && html.includes('>50%<'), 'résumé (30) + job (20)');
  assert.strictEqual((html.match(/class="check-item done"/g) || []).length, 2);
  assert.strictEqual((html.match(/class="check-item /g) || []).length, 6);
  for (const id of ['ctxJob', 'ctxResearch', 'ctxInstr']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('>Go e Kafka</textarea>'));
  assert.ok(actions(html).includes('save-context') && actions(html).includes('company-recon'));

  // Copilot memory: empty state, then what the debriefs learned.
  assert.ok(html.includes('Gere um debrief depois de uma sessão'));
  const filled = workspace({ ...AGENT, next_focus: 'Focus on: métricas', goal_memory: { strengths: ['Clareza'], improve: ['Ser mais breve'] } }).html;
  assert.ok(filled.includes('Próximo foco') && filled.includes('>métricas<'), 'next focus without the prefix');
  assert.ok(filled.includes('<div class="bullet">Clareza</div>') && filled.includes('<div class="bullet neutral">Ser mais breve</div>'));
});

test('Task 5.1 / Property 4: answer defaults (playbook, language, code, stage) and linked files', () => {
  const { html } = workspace();
  assert.ok(/data-change="agent-playbook"[^>]*>[\s\S]*?<option value="STAR executivo" selected>/.test(html));
  assert.ok(actions(html).includes('new-playbook'));
  const fields = tags(html, { 'data-change': 'agent-field' }).map((t) => t['data-field']);
  assert.deepStrictEqual(fields, ['answer_language', 'coding_language', 'stage']);
  assert.ok(html.includes('<option value="en-US" selected>') && html.includes('<option value="Go" selected>') && html.includes('<option value="Technical" selected>'));

  // Files: the résumé is listed; without one the drop zone asks for it.
  assert.ok(html.includes('cv.pdf') && html.includes('2.0 KB'));
  assert.ok(actions(html).includes('preview-doc') && actions(html).includes('remove-doc'));
  assert.ok(!html.includes('Anexe seu currículo'));
  const noCv = workspace({ ...AGENT, documents: [] }).html;
  assert.ok(noCv.includes('Anexe seu currículo') && /data-action="add-docs"[^>]*data-tag="resume"/.test(noCv));
});

test('Task 5.1 / Property 5: recorded sessions of this goal', () => {
  const empty = workspace().html;
  assert.ok(empty.includes('Nenhuma sessão gravada para esta vaga ainda.'));
  const withRecs = workspace(AGENT, {
    sessions: [{ id: '2026-10-01_10-00-00_ab12', goalLabel: 'Nubank · Backend Engineer', startedAt: '2026-10-01T13:00:00Z', durationSeconds: 1800, mode: 'demo' }]
  }).html;
  assert.ok(/data-action="go" data-to="review\/2026-10-01_10-00-00_ab12"/.test(withRecs), 'a recorded session opens its review');
  assert.ok(withRecs.includes('Simulação') && withRecs.includes('30 min'));
  assert.ok(actions(withRecs).includes('archive-session') && actions(withRecs).includes('delete-session'));
});

test('Task 5.1 / Property 6: Preload API exports para Goal Workspace (Requirements: 3.1, 11.1, 15.1)', () => {
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');

  assert.ok(preloadJs.includes('getPlaybooks:'), 'preload must export getPlaybooks');
  assert.ok(preloadJs.includes('savePlaybook:'), 'preload must export savePlaybook');
  assert.ok(preloadJs.includes('scheduleInterview:'), 'preload must export scheduleInterview');
  assert.ok(preloadJs.includes('clearInterview:'), 'preload must export clearInterview');
  assert.ok(preloadJs.includes('generateDebrief:'), 'preload must export generateDebrief');
  assert.ok(preloadJs.includes('saveChecklist:'), 'preload must export saveChecklist');
});

test('Task 5.1 / Property 7: Main Process IPC Handlers registrados (Requirements: 3.2, 11.1, 15.2)', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes("'rtai:get-playbooks'"), 'IPC rtai:get-playbooks must be registered');
  assert.ok(mainJs.includes("'rtai:save-playbook'"), 'IPC rtai:save-playbook must be registered');
  assert.ok(mainJs.includes("'rtai:schedule-interview'"), 'IPC rtai:schedule-interview must be registered');
  assert.ok(mainJs.includes("'rtai:clear-interview'"), 'IPC rtai:clear-interview must be registered');
  assert.ok(mainJs.includes("'rtai:generate-debrief'"), 'IPC rtai:generate-debrief must be registered');
  assert.ok(mainJs.includes("'rtai:save-checklist'"), 'IPC rtai:save-checklist must be registered');
  assert.ok(mainJs.includes('DEFAULT_PLAYBOOKS'), 'DEFAULT_PLAYBOOKS constant must exist');
});

test('Task 5.1 / Property 8: the sessions list splits upcoming and past, archived on demand', () => {
  const agents = [
    { id: 'a1', company: 'Nubank', role: 'Backend' },
    { id: 'a2', company: 'Stone', role: 'SRE', archived: true }
  ];
  const r = loadRenderer({ state: { agents } });
  const upcoming = render(r.Cue, 'sessions');
  assert.ok(upcoming.includes('Nubank') && !upcoming.includes('Stone'), 'archived sessions are hidden by default');
  assert.ok(tags(upcoming, { 'data-change': 'toggle-archived' }).length === 1);
  r.S.ui.showArchived = true;
  assert.ok(render(r.Cue, 'sessions').includes('Stone'));
});

test('Task 5.1 / Property 9: Persistência e Limpeza de Data da Entrevista (Requirements: 2.1, 3.2, 7.2)', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');

  // main.js must read next_interview_date cleanly and sync next_interview object
  assert.ok(mainJs.includes('const rawDate = agent.next_interview_date'), 'saveAgentToDisk must extract rawDate');
  assert.ok(mainJs.includes('data.next_interview_date = nextDate'), 'loadAllAgents must set next_interview_date');
  assert.ok(mainJs.includes('goal.next_interview_date = cleanDate'), 'schedule-interview IPC must set next_interview_date');

  // preload.js must support both object and positional args
  assert.ok(preloadJs.includes('goalIdOrObj'), 'preload.js scheduleInterview must handle flexible arguments');

  // The renderer reads both shapes (flat fields and the next_interview object).
  const { Cue } = loadRenderer();
  const flat = Cue.agentInterview({ next_interview_date: '2099-05-02', next_interview_time: '09:15' });
  const nested = Cue.agentInterview({ next_interview: { date: '2099-05-02', time: '09:15' } });
  for (const iv of [flat, nested]) {
    assert.strictEqual(iv.date, '2099-05-02');
    assert.strictEqual(iv.hasTime, true);
    assert.strictEqual(iv.at.getHours(), 9);
  }
  assert.strictEqual(Cue.agentInterview({ next_interview_date: 'amanhã' }), null, 'invalid dates are ignored');
});

test('Task 5.1 / Property 10: Remoção visual dos botões extras do topo e links funcionais (User Request)', () => {
  const header = indexHtml.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1];
  assert.ok(!header.includes('TranscriptionMode'), 'the transcription-only toggle lives in the live view, not the top bar');
  assert.ok(!/data-demo=/.test(header), 'no demo launcher in the top bar');
  assert.ok(header.includes('id="btnGoLive"'), 'top bar keeps Go Live');
});
