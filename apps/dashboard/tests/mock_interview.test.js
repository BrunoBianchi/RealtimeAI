'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockInterviews, buildIndex, retrieve, takeSentences, LANGUAGES, bankQuestionsFor, createInterview, prepareTurn, commitTurn, coverageFor, resolveQAndA } = require('../src/main/mock_interview');
const { entitlement, PRICING } = require('../src/main/plans');

const job = {
  id: 'g1', company: 'Acme', role: 'Backend', job_description: 'Go e Kafka',
  documents: [{ title: 'CV', tag: 'resume', content: 'Bruno liderou a migração para Kafka no Nubank.' }, { title: 'Notas', tag: 'material', content: 'Gosto de jardinagem.' }]
};
const other = { id: 'g2', documents: [{ title: 'Portfólio', tag: 'material', content: 'Projeto de observabilidade com Prometheus.' }, job.documents[0]] };

test('retrieval ranks current job sources and does not mix companies or repeat overlapping material', () => {
  const scoped = {
    ...job, company_research: 'Our culture emphasizes collaboration and accountability.',
    job_description: 'Go e Kafka. The internship includes an onboarding mentor.',
  };
  const index = buildIndex(scoped, [other]);
  assert.strictEqual(retrieve(index, 'como foi a migração kafka?')[0].title, 'CV');
  assert.strictEqual(retrieve(index, 'Como é a colaboração e a cultura?')[0].type, 'company');
  assert.strictEqual(retrieve(index, 'Como é a integração?', 5, ['job', 'company'])[0].type, 'job');
  assert.deepStrictEqual(retrieve(index, 'prometheus observabilidade'), []);
  assert.deepStrictEqual(retrieve(index, 'xyzzy'), []);
  assert.strictEqual(index.chunks.filter((c) => c.type === 'resume').length, 1);
  assert.strictEqual(retrieve(buildIndex({ ...job, documents: [] }, [other]), 'migração kafka')[0].type, 'resume');
});

test('the internship plan keeps mandatory topics, retrieves evidence and assesses a custom goal', () => {
  const agent = { ...job, role: 'Estágio Backend', company_research: 'Valorizamos a autonomia em equipes pequenas.' };
  const state = createInterview(agent, [], null, 'pt-BR', 'basic', { persona: 'manager', depth: 0, goal: 'Explicar meus resultados' }, 1800);
  assert.deepStrictEqual(state.topics, ['trajectory', 'culture', 'academics', 'availability', 'motivation', 'questions']);
  const opening = prepareTurn(state, '', '', 1800);
  assert.match(opening.direct, /trajetória/);
  commitTurn(state, opening, opening.direct);
  const culture = prepareTurn(state, 'Trabalhei com Kafka.', '', 1700);
  assert.match(culture.messages[0].content, /gestor da área.*prioridades/);
  assert.match(culture.messages[0].content, /Explicar meus resultados/);
  assert.match(culture.messages[0].content, /Valorizamos a autonomia/);
  assert.equal(culture.messages.at(-1).content, 'Trabalhei com Kafka.');
  commitTurn(state, culture, 'Como você tomou uma decisão com autonomia?');
  for (const [topic, question] of [['academics', 'Quando você se forma?'], ['availability', 'Qual é sua disponibilidade?'], ['motivation', 'O que te interessa na vaga?']]) {
    const next = prepareTurn(state, 'Minha resposta.', '', 1500);
    assert.equal(state.topics[next.topicIndex], topic);
    commitTurn(state, next, question);
  }
  const qAndA = prepareTurn(state, 'Quero aprender Go.', '', 1000);
  assert.match(qAndA.direct, /perguntas.*gostaria de fazer/);
  commitTurn(state, qAndA, qAndA.direct);
  assert.equal(coverageFor(state).at(-1).status, 'offered');
});

test('candidate Q&A requires the exact source and can close independently', () => {
  const state = createInterview({ ...job, job_description: 'The internship includes a mentor for onboarding.' }, [], null, 'en', 'basic', { depth: 0 }, 1800);
  state.messages.push({ role: 'assistant', content: 'Your questions?' });
  state.topicIndex = state.topics.length - 1;
  const turn = prepareTurn(state, 'Is there an onboarding mentor?', '', 900);
  assert.equal(turn.sources.length, 1);
  assert.match(resolveQAndA(state, turn, '{"fonte":"D1","citacao":"The company pays a bonus","resposta":"There is a bonus."}'), /missing from/);
  assert.deepStrictEqual(resolveQAndA(state, turn, JSON.stringify({
    fonte: turn.sources[0].id, citacao: 'includes a mentor for onboarding', resposta: 'The materials mention a mentor for onboarding. Anything else?'
  })), 'The materials mention a mentor for onboarding. Anything else?');
  assert.match(resolveQAndA(state, turn, JSON.stringify({
    fonte: turn.sources[0].id, citacao: 'includes a mentor for onboarding', resposta: 'You get 50 mentoring hours.'
  })), /missing from/);
  assert.match(resolveQAndA(state, turn, '[FIM]'), /missing from/);
  const unsupported = prepareTurn(state, 'What is the salary?', '', 900);
  assert.match(unsupported.direct, /missing from/);
  const ending = prepareTurn(state, 'No more questions, thank you.', '', 900);
  assert.equal(ending.finished, true);
  assert.match(ending.direct, /concludes our interview/);
});

test('speech is cut into complete sentences while it streams', () => {
  assert.deepStrictEqual(takeSentences('Olá, tudo bem? Me conte'), { sentences: ['Olá, tudo bem?'], rest: ' Me conte' });
  assert.deepStrictEqual(takeSentences('Sem ponto', true), { sentences: ['Sem ponto'], rest: '' });
  assert.ok(takeSentences('a '.repeat(200)).sentences[0].length <= 221);
});

function fakeDeps(apiResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const said = [];
  const calls = [];
  const encoder = new TextEncoder();
  return {
    said, calls, dir,
    deps: {
      dataDir: () => dir, agents: () => [job, other], now: () => 1000, emit: (e) => said.push(e.text),
      url: (p) => p, headers: () => ({}),
      api: async (m, p) => { calls.push(p); return p === '/v1/mock/start' ? apiResult : { ok: true, data: { refunded: false } }; },
      fetch: async (url, init) => {
        calls.push(url);
        const body = JSON.parse(init.body);
        if (body.stream === false) return { ok: true, json: async () => ({ choices: [{ message: { content: 'Nota 7.' } }] }) };
        return { ok: true, body: [encoder.encode('data: {"choices":[{"delta":{"content":"Bom dia. Fale "}}]}\n'), encoder.encode('data: {"choices":[{"delta":{"content":"de você. [FIM]"}}]}\n\ndata: [DONE]\n')] };
      }
    }
  };
}

test('the opening leads with trajectory, model markers cannot end it, and feedback is kept', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_1', max_s: 1800, source: 'plan', stt: { token: 't' } } });
  const m = createMockInterviews(f.deps);
  assert.strictEqual((await m.start({ agentId: 'g1', lang: 'pt-BR' })).maxS, 1800);
  const opening = await m.turn('');
  assert.match(f.said.join(' '), /trajetória/);
  assert.strictEqual(opening.finished, false);
  const response = await m.turn('Trabalhei com Kafka.');
  assert.strictEqual(response.finished, false);
  assert.equal(f.calls.at(-1), '/v1/mock/mock_1/chat');
  assert.deepStrictEqual(f.said.slice(-2), ['Bom dia.', 'Fale de você.']);
  const done = await m.end();
  assert.strictEqual(done.record.feedback, 'Nota 7.');
  assert.deepStrictEqual(m.list().map((r) => r.id), ['mock_1']);
  assert.ok(f.calls.indexOf('/v1/mock/mock_1/end') > f.calls.lastIndexOf('/v1/mock/mock_1/chat'), 'feedback before the end');
  fs.rmSync(f.dir, { recursive: true });
});

test('a text interview follows its plan, grounds candidate Q&A, and keeps the scored answers', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_e2e', mode: 'basic', max_s: 1800 } });
  f.deps.agents = () => [{ ...job, job_description: 'The role includes weekly mentoring sessions.' }];
  const encoder = new TextEncoder();
  const responses = [
    'How did you collaborate with your team?',
    'What interests you about this role?',
    JSON.stringify({ fonte: 'D1', citacao: 'The role includes weekly mentoring sessions.', resposta: 'The role includes weekly mentoring sessions. Anything else?' })
  ];
  f.deps.fetch = async (url) => {
    assert.equal(url, '/v1/mock/mock_e2e/chat');
    const content = responses.shift();
    assert.ok(content, 'no model call for missing sources or for closing');
    const event = JSON.stringify({ choices: [{ delta: { content } }] });
    return { ok: true, body: [encoder.encode('data: ' + event)] };
  };
  let judged;
  f.deps.evaluate = async (pairs, _agent, _lang, context) => {
    judged = { pairs, context };
    return { score: 80 };
  };
  const mock = createMockInterviews(f.deps);
  await mock.start({ agentId: job.id, lang: 'en', mode: 'basic', settings: { depth: 0, goal: 'Explain team impact' } });
  assert.equal((await mock.turn('')).topic, 'trajectory');
  assert.equal((await mock.turn('I built a Kafka pipeline.')).topic, 'culture');
  assert.equal((await mock.turn('We reviewed changes in pairs.')).topic, 'motivation');
  assert.equal((await mock.turn('I want to learn distributed systems.')).topic, 'questions');
  assert.equal((await mock.turn('How often are the mentoring sessions?')).finished, false);
  assert.match(f.said.join(' '), /includes weekly mentoring sessions/);
  assert.equal((await mock.turn('What is the salary?')).finished, false);
  assert.match(f.said.join(' '), /missing from the interview materials/);
  assert.equal((await mock.turn('No more questions, thank you.')).finished, true);
  assert.equal(responses.length, 0);
  const { record } = await mock.end();
  assert.equal(judged.pairs.length, 3);
  assert.match(judged.context, /Explain team impact/);
  assert.equal(record.coverage.at(-1).status, 'offered');
  assert.ok(record.messages.some((m) => m.content === 'What is the salary?'));
  fs.rmSync(f.dir, { recursive: true });
});

test('a refused start is explained and opens nothing', async () => {
  const f = fakeDeps({ ok: false, status: 402, error: 'mock_not_included' });
  const m = createMockInterviews(f.deps);
  const r = await m.start({ agentId: 'g1', lang: 'en' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no minutes left/);
  assert.strictEqual(m.isActive(), false);
  fs.rmSync(f.dir, { recursive: true });
});

test('training needs at least one minute of the shared balance', () => {
  assert.strictEqual(entitlement({ plan: { id: 'free' } }).canMock, true, '15 Free minutes are enough');
  assert.strictEqual(entitlement({ plan: { id: 'free', sessions_used: 1 } }).canMock, false);
  assert.strictEqual(entitlement({ plan: { id: 'pro', minutes_left: 0.9 } }).canMock, false);
  assert.strictEqual(entitlement({ plan: { id: 'pro', minutes_left: 1 } }).canMock, true);
});

test('Plan sells no mock packs, and the video ships', () => {
  assert.strictEqual(PRICING.mockPacks, undefined);
  assert.ok(fs.statSync(path.join(__dirname, '../src/renderer/media/mock-how-it-works.webm')).size > 100000);
});

test('the end reports the minutes charged by the server', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_3', max_s: 900, billing: 'minutes', stt: { token: 't' } } });
  const m = createMockInterviews(f.deps);
  await m.start({ agentId: 'g1', lang: 'en' });
  f.deps.api = async () => ({ ok: true, data: { refunded: false, charged_minutes: 2.5, minutes_left: 12.5 } });
  const r = await m.end();
  assert.strictEqual(r.chargedMinutes, 2.5);
  fs.rmSync(f.dir, { recursive: true });
});

test('a token this app cannot read asks for sign-in instead of an empty account', async () => {
  const { createCloudAccount } = require('../src/main/cloud_account');
  const acc = createCloudAccount({ getServerUrl: () => 'http://x.test', hasToken: () => true, readToken: () => '', saveToken() {}, openBrowser() {}, appVersion: '1' });
  const st = await acc.status(true);
  assert.strictEqual(st.signedIn, false);
  assert.strictEqual(st.expired, true);
});

test('the end runs JEV on each question and answer, keeps the transcript, and the copilot answers from them', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_2', max_s: 1800, source: 'plan', stt: { token: 't' } } });
  let pairs = null;
  let prompt = '';
  f.deps.evaluate = async (p) => { pairs = p; return { score: 71, resumo: 'Bom', items: [] }; };
  f.deps.complete = async (messages) => { prompt = messages[0].content; return 'Cite números.'; };
  const m = createMockInterviews(f.deps);
  await m.start({ agentId: 'g1', lang: 'pt-BR' });
  await m.turn('');
  await m.turn('Trabalhei com Kafka.');
  const { record } = await m.end();
  assert.match(pairs[0].question, /trajetória/);
  assert.strictEqual(pairs[0].answer, 'Trabalhei com Kafka.');
  assert.strictEqual(record.evaluation.score, 71);
  assert.ok(record.messages.some((x) => x.content === 'Trabalhei com Kafka.'));
  const r = await m.coach('mock_2', 'O que melhorar?');
  assert.strictEqual(r.answer, 'Cite números.');
  assert.ok(prompt.includes('Trabalhei com Kafka.') && prompt.includes('Bom'));
  assert.strictEqual(m.list()[0].coach[0].a, 'Cite números.', 'the conversation is kept');
  fs.rmSync(f.dir, { recursive: true });
});

test('every interview language is offered and split into sentences', () => {
  const page = fs.readFileSync(path.join(__dirname, '../src/renderer/mock.js'), 'utf8');
  for (const code of Object.keys(LANGUAGES)) {
    assert.ok(page.includes(`['${code}', `), code);
  }
  const state = createInterview(job, [], null, 'es', 'advanced', {}, 900);
  const opening = prepareTurn(state, '', '', 900);
  assert.match(opening.direct, /trayectoria/);
  commitTurn(state, opening, opening.direct);
  const turn = prepareTurn(state, 'Hice un proyecto en Go.', '', 800);
  assert.match(turn.messages[0].content, /Fale somente em espanhol/);
  assert.deepStrictEqual(takeSentences('こんにちは。自己紹介をお願いします').sentences, ['こんにちは。']);
  assert.strictEqual(takeSentences('字'.repeat(300)).sentences[0].length, 220);
});

test('both modes are charged per minute from the one balance shared with live sessions', async () => {
  const { entitlement } = require('../src/main/plans');
  const { loadRenderer, render, tags } = require('./helpers/renderer');
  const ent = entitlement({ plan: { id: 'free', minutes_left: 15, training: { rate: 1, max_minutes: 15, free_under_s: 60 } } });
  const r = loadRenderer({
    state: { agents: [job], auth: { signedIn: true, entitlement: ent } },
    api: { mockStart: async () => ({ ok: true, id: 'm1', mode: 'basic', maxS: 900 }) }
  });
  const mock = render(r.Cue, 'mock');
  const [start] = tags(mock, { 'data-action': 'mock-start' });
  assert.ok(start && !('disabled' in start), 'a Free account with 15 minutes can train');
  assert.match(mock, /Start Basic interview/);
  assert.match(mock, /Charged per minute used[\s\S]*Charged per minute used[\s\S]*Balance: 15 min, shared with live sessions/);
  assert.match(mock, /Up to 15 minutes/);
  assert.match(mock, /data-tour="mock-balance"/);
  const balanceStep = r.Cue.tours.mock.steps({}).find((st) => st.element === '[data-tour="mock-balance"]');
  assert.match(balanceStep.text, /per minute used, from the same minutes as live sessions/);
  assert.doesNotMatch(mock, /\d+ tokens|data-pack=|Test microphone/);
  r.Cue.changes['mock-persona']({ value: 'global' });
  r.Cue.changes['mock-lang']({ value: 'es' });
  r.Cue.changes['mock-format']({ value: 'internship' });
  r.Cue.inputs['mock-goal']({ value: 'Explicar um projeto' });
  await r.Cue.actions['mock-start']();
  const [agentId, lang, mode, settings] = r.called('mockStart')[0];
  assert.deepEqual([agentId, lang, mode], [job.id, 'es', 'basic']);
  assert.deepEqual({ ...settings }, { persona: 'global', format: 'internship', depth: 1, goal: 'Explicar um projeto', useBank: true });
  assert.deepEqual(r.called('mockTurn'), [['']]);

  const plan = render(r.Cue, 'settings/plan/interviews');
  assert.match(plan, /data-card="mock-interview-minutes"/);
  assert.match(plan, /15 min available/);
  assert.doesNotMatch(plan, /mock_tokens_|mock tokens/);

  const empty = loadRenderer({ state: { agents: [job], auth: { entitlement: entitlement({ plan: { id: 'free', sessions_used: 1 } }) } } });
  const unavailable = render(empty.Cue, 'mock');
  assert.match(unavailable, /data-to="settings\/plan\/interviews"/);
  assert.match(unavailable, /You have no minutes left for a mock interview/);
  assert.doesNotMatch(unavailable, /data-action="mock-start"|data-pack=/);
});

test('Home keeps the referral card visible after a 404 and retries when requested', async () => {
  const { loadRenderer, render, settle } = require('./helpers/renderer');
  let attempts = 0;
  const r = loadRenderer({
    state: { auth: { signedIn: true, serverUrl: 'https://example.invalid', account: { email: 'one@example.invalid' } } },
    api: { cloudReferral: async () => ++attempts === 1 ? { ok: false, status: 404 } : {
      ok: true, data: { code: 'invite', url: 'https://example.invalid/r/invite', completed: 0, bonus_minutes: 30, minutes_earned: 0 }
    } }
  });
  assert.match(render(r.Cue, 'home'), /Refer and earn/);
  await settle();
  const unavailable = render(r.Cue, 'home');
  assert.match(unavailable, /This server does not offer referral links yet/);
  assert.match(unavailable, /data-action="referral-retry"/);
  await r.Cue.actions['referral-retry']();
  const ready = render(r.Cue, 'home');
  assert.match(ready, /data-action="referral-copy"/);
  assert.match(ready, /0 friends · 0 min earned/);
});

test('Home still opens when the mock interview script failed to load', () => {
  const { loadRenderer } = require('./helpers/renderer');
  const r = loadRenderer();
  delete r.Cue.mockAd;
  assert.ok(String(r.Cue.views.home()).includes('page'));
});

test('the question bank of the job feeds the interviewer, without repeating itself', () => {
  const bank = { companies: [
    { name: 'NUBANK', questions: [{ text: 'Conte sobre um conflito no time', category: 'Culture', interviewsCount: 1 }, { text: 'Como escalar Kafka?', category: 'Technical', interviewsCount: 4 }] },
    { name: 'Nubank · Estágio', questions: [{ text: 'Como escalar Kafka?', interviewsCount: 1 }, { text: 'Por que o Nubank?', interviewsCount: 2 }] },
    { name: 'Ifood', questions: [{ text: 'Por que o Ifood?' }] }
  ] };
  const qs = bankQuestionsFor({ company: 'Nubank' }, bank);
  assert.deepStrictEqual(qs.map((q) => q.text), ['Como escalar Kafka?', 'Por que o Nubank?', 'Conte sobre um conflito no time']);
  assert.deepStrictEqual(bankQuestionsFor({ company: 'Acme' }, bank), []);
  const state = createInterview({ ...job, company: 'Nubank' }, [], bank, 'en', 'basic', { depth: 0 }, 1800);
  const opening = prepareTurn(state, '', '', 1800);
  assert.ok(!opening.bank);
  commitTurn(state, opening, opening.direct);
  const culture = prepareTurn(state, 'Resolvi um conflito no time.', '', 1700);
  assert.equal(culture.bank.text, 'Conte sobre um conflito no time');
  assert.equal(culture.messages.at(-1).content, 'Resolvi um conflito no time.');
  assert.match(culture.messages[0].content, /Conte sobre um conflito no time/);
  state.settings.useBank = false;
  assert.equal(prepareTurn(state, 'Conflito.', '', 1700).bank, null);
});

test('a server without the interview endpoints is explained, not called generic', async () => {
  const f = fakeDeps({ ok: false, status: 404, error: 'not_found' });
  const r = await createMockInterviews(f.deps).start({ agentId: 'g1', lang: 'pt-BR' });
  assert.strictEqual(r.code, 'server_outdated');
  assert.ok(r.error.includes('Nothing was charged'));
  fs.rmSync(f.dir, { recursive: true });
});

test('bank matching accepts a shorter or longer company name and repairs accents', () => {
  const bank = { companies: [{ name: 'Itaú', questions: [{ text: 'Por que o ItaÃº?' }] }, { name: 'Banco Inter', questions: [{ text: 'x y' }] }] };
  assert.deepStrictEqual(bankQuestionsFor({ company: 'Itaú Unibanco' }, bank).map((q) => q.text), ['Por que o Itaú?']);
  assert.deepStrictEqual(bankQuestionsFor({ company: 'Banco do Brasil' }, bank), []);
});

test('follow-ups are bounded and older answers remain available in context', () => {
  const state = createInterview(job, [], null, 'en', 'basic', { depth: 2 }, 1800);
  const opening = prepareTurn(state, '', '', 1800);
  commitTurn(state, opening, opening.direct);
  for (const [i, answer] of ['Led an OpenTelemetry migration.', 'Wrote the proposal.', 'Measured the latency.'].entries()) {
    const next = prepareTurn(state, answer, '', 1700);
    assert.equal(state.topics[next.topicIndex], i < 2 ? 'trajectory' : 'culture');
    commitTurn(state, next, 'Question ' + i + '?');
  }
  for (let i = 0; i < 4; i += 1) {
    const next = prepareTurn(state, 'A different answer ' + i, '', 1500);
    commitTurn(state, next, 'Next question ' + i + '?');
  }
  const next = prepareTurn(state, 'About OpenTelemetry', '', 1400);
  assert.ok(next.messages[0].content.includes('Led an OpenTelemetry migration.'));
  assert.ok(!next.messages.slice(1).some((m) => m.content === 'Led an OpenTelemetry migration.'));
});

test('an answer that goes on after a pause cancels the turn and gives its bank question back', async () => {
  const f = fakeDeps({ ok: true, status: 200, data: { id: 'm1', max_s: 1800, stt: {} } });
  f.deps.bank = () => ({ companies: [{ name: job.company, questions: [{ text: 'primeira pergunta do banco', category: 'Culture' }, { text: 'segunda pergunta do banco', category: 'Culture' }] }] });
  f.deps.emit = () => {};
  let sent = [];
  f.deps.fetch = (_url, init) => new Promise((_resolve, reject) => {
    sent.push(JSON.parse(init.body).messages);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const interviews = createMockInterviews(f.deps);
  await interviews.start({ agentId: 'g1', lang: 'pt-BR', settings: { depth: 0 } });
  await interviews.turn('');
  const first = interviews.turn('metade da resposta');
  assert.ok(sent[0][0].content.includes('primeira pergunta do banco'));
  assert.strictEqual(interviews.cancelTurn().ok, true);
  assert.deepStrictEqual(await first, { ok: false, aborted: true });
  const second = interviews.turn('resposta inteira');
  const last = sent[1].at(-1).content;
  assert.ok(last === 'resposta inteira' && sent[1][0].content.includes('primeira pergunta do banco'));
  assert.ok(!sent[1].some((m) => m.content === 'metade da resposta'));
  interviews.cancelTurn();
  await second;
  fs.rmSync(f.dir, { recursive: true });
});
