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
  assert.deepStrictEqual(state.topics, ['trajectory', 'project', 'academics', 'availability', 'conflict', 'culture', 'signal', 'motivation', 'questions']);
  assert.equal(state.settings.level, 'entry');
  const opening = prepareTurn(state, '', '', 1800);
  assert.match(opening.direct, /trajetória/);
  commitTurn(state, opening, opening.direct);
  const project = prepareTurn(state, 'Trabalhei com Kafka.', '', 1700);
  assert.match(project.messages[0].content, /gestor da área.*prioridades/);
  assert.match(project.messages[0].content, /Explicar meus resultados/);
  assert.match(project.messages[0].content, /Nível da vaga: iniciante/);
  assert.equal(project.messages.at(-1).content, 'Trabalhei com Kafka.');
  commitTurn(state, project, 'Qual projeto mais te marcou?');
  for (const [topic, question] of [['academics', 'Quando você se forma?'], ['availability', 'Qual é sua disponibilidade?'], ['conflict', 'Conte um conflito.'], ['culture', 'Como você age com autonomia?'], ['signal', 'Conte um erro.'], ['motivation', 'O que te interessa na vaga?']]) {
    const next = prepareTurn(state, 'Minha resposta.', '', 1500);
    assert.equal(state.topics[next.topicIndex], topic);
    if (topic === 'culture') assert.match(next.messages[0].content, /Valorizamos a autonomia/);
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

function rubricReply(messages) {
  const asked = [...messages[1].content.matchAll(/^#(\d+)$/gm)].map((m) => Number(m[1]));
  const result = messages[0].content.includes('feedback final')
    ? { resumo: 'Bom', proximo_passo: 'Explique o resultado.' }
    : { items: asked.map((i) => ({
      i, tipo: 'factual', notas: { adequacao: 7, objetividade: 7 },
      veredito: 'Citou Kafka.', dica: 'Explique o resultado.',
    })) };
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) };
}

function fakeDeps(apiResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const said = [];
  const calls = [];
  const encoder = new TextEncoder();
  return {
    said, calls, dir,
    deps: {
      dataDir: () => dir, agents: () => [job, other], now: () => 1000, seed: () => 0, emit: (e) => said.push(e.text),
      url: (p) => p, headers: () => ({}),
      api: async (m, p) => { calls.push(p); return p === '/v1/mock/start' ? apiResult : { ok: true, data: { refunded: false } }; },
      fetch: async (url, init) => {
        calls.push(url);
        const body = JSON.parse(init.body);
        if (body.stream === false) return rubricReply(body.messages);
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
  assert.strictEqual(done.record.evaluation.score, 70);
  assert.strictEqual(done.record.evaluation.proximo, 'Explique o resultado.');
  assert.deepStrictEqual(m.list().map((r) => r.id), ['mock_1']);
  assert.ok(f.calls.indexOf('/v1/mock/mock_1/end') > f.calls.lastIndexOf('/v1/mock/mock_1/chat'), 'feedback before the end');
  fs.rmSync(f.dir, { recursive: true });
});

test('a text interview follows its plan, grounds candidate Q&A, and keeps the scored answers', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_e2e', mode: 'basic', max_s: 1800 } });
  f.deps.agents = () => [{ ...job, job_description: 'The role includes weekly mentoring sessions.' }];
  const encoder = new TextEncoder();
  const responses = [
    'What interests you about this role?',
    'How did you collaborate with your team?',
    JSON.stringify({ fonte: 'D1', citacao: 'The role includes weekly mentoring sessions.', resposta: 'The role includes weekly mentoring sessions. Anything else?' })
  ];
  let judged;
  f.deps.fetch = async (url, init) => {
    assert.equal(url, '/v1/mock/mock_e2e/chat');
    const body = JSON.parse(init.body);
    if (body.stream === false) {
      if (body.messages[0].content.includes('rubrica')) judged = body.messages[1].content;
      return rubricReply(body.messages);
    }
    const content = responses.shift();
    assert.ok(content, 'no model call for missing sources or for closing');
    const event = JSON.stringify({ choices: [{ delta: { content } }] });
    return { ok: true, body: [encoder.encode('data: ' + event)] };
  };
  const mock = createMockInterviews(f.deps);
  await mock.start({ agentId: job.id, lang: 'en', mode: 'basic', settings: { depth: 0, goal: 'Explain team impact', kind: 'screen' } });
  assert.equal((await mock.turn('')).topic, 'trajectory');
  assert.equal((await mock.turn('I built a Kafka pipeline.')).topic, 'motivation');
  assert.equal((await mock.turn('I want to learn distributed systems.')).topic, 'culture');
  assert.equal((await mock.turn('We reviewed changes in pairs.')).topic, 'questions');
  assert.equal((await mock.turn('How often are the mentoring sessions?')).finished, false);
  assert.match(f.said.join(' '), /includes weekly mentoring sessions/);
  assert.equal((await mock.turn('What is the salary?')).finished, false);
  assert.match(f.said.join(' '), /missing from the interview materials/);
  assert.equal((await mock.turn('No more questions, thank you.')).finished, true);
  assert.equal(responses.length, 0);
  const { record } = await mock.end();
  assert.equal(record.evaluation.items.length, 3);
  assert.match(judged, /Explain team impact/);
  assert.doesNotMatch(judged, /What is the salary/);
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
  let prompt = '';
  f.deps.complete = async (messages) => { prompt = messages[0].content; return 'Cite números.'; };
  const m = createMockInterviews(f.deps);
  await m.start({ agentId: 'g1', lang: 'pt-BR' });
  await m.turn('');
  const { record } = await m.end('Trabalhei com Kafka.');
  assert.match(record.evaluation.items[0].question, /trajetória/);
  assert.strictEqual(record.evaluation.items[0].answer, 'Trabalhei com Kafka.');
  assert.strictEqual(record.evaluation.score, 70);
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
  assert.deepEqual({ ...settings }, { kind: 'behavioral', persona: 'global', format: 'internship', level: 'auto', depth: 1, goal: 'Explicar um projeto', focus: '', useBank: true, priority: [] });
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
  const state = createInterview({ ...job, company: 'Nubank' }, [], bank, 'en', 'basic', { depth: 0, kind: 'screen' }, 1800);
  const opening = prepareTurn(state, '', '', 1800);
  assert.ok(!opening.bank);
  commitTurn(state, opening, opening.direct);
  commitTurn(state, prepareTurn(state, 'I like the product.', '', 1750), 'Why this team?');
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
    assert.equal(state.topics[next.topicIndex], i < 2 ? 'trajectory' : 'project');
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
  f.deps.bank = () => ({ companies: [{ name: job.company, questions: [{ text: 'primeira pergunta do banco', category: 'Behavioral' }, { text: 'segunda pergunta do banco', category: 'Behavioral' }] }] });
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

test('a spoken answer sent early holds the reply: nothing is said or committed until the hold ends, and it can be taken back', async () => {
  const f = fakeDeps({ ok: true, status: 200, data: { id: 'm2', max_s: 1800, stt: {} } });
  const interviews = createMockInterviews(f.deps);
  await interviews.start({ agentId: 'g1', lang: 'pt-BR', settings: { depth: 0 } });
  await interviews.turn('');
  const opening = f.said.length;

  // The whole reply arrives at once, but the candidate goes on talking.
  const early = interviews.turn('metade da resposta', '', 400);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.strictEqual(f.said.length, opening, 'no sentence leaves during the hold');
  assert.strictEqual(interviews.cancelTurn().ok, true);
  assert.deepStrictEqual(await early, { ok: false, aborted: true });
  assert.strictEqual(f.said.length, opening, 'a turn taken back says nothing');

  // The full answer: said and committed once the hold is over.
  const started = Date.now();
  const whole = await interviews.turn('resposta inteira', '', 60);
  assert.ok(Date.now() - started >= 50, 'the reply waited for the hold');
  assert.strictEqual(whole.ok, true);
  assert.deepStrictEqual(f.said.slice(opening), ['Bom dia.', 'Fale de você.']);
  const { record } = await interviews.end();
  assert.deepStrictEqual(record.messages.filter((m) => m.role === 'user').map((m) => m.content), ['resposta inteira']);
  fs.rmSync(f.dir, { recursive: true });
});

test('a second interview for the same job opens with a generated question that knows the earlier ones, and falls back to the script', async () => {
  const f = fakeDeps({ ok: true, status: 200, data: { id: 'again_1', max_s: 1800, stt: {} } });
  const interviews = createMockInterviews(f.deps);
  await interviews.start({ agentId: 'g1', lang: 'pt-BR', settings: { depth: 0 } });
  await interviews.turn('');
  const scripted = f.said.join(' ');
  assert.match(scripted, /trajetória/);
  await interviews.turn('Trabalhei com Kafka.');
  await interviews.end();

  let sent = null;
  const stream = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream) sent = body.messages;
    return stream(url, init);
  };
  f.deps.api = async (_m, p) => (p === '/v1/mock/start' ? { ok: true, status: 200, data: { id: 'again_2', max_s: 1800, stt: {} } } : { ok: true, data: {} });
  f.said.length = 0;
  await interviews.start({ agentId: 'g1', lang: 'pt-BR', settings: { depth: 0 } });
  assert.strictEqual((await interviews.turn('')).ok, true);
  assert.ok(sent[0].content.includes('Abra a entrevista'));
  assert.ok(sent[0].content.includes(scripted), 'the earlier opening is listed as already asked');
  assert.deepStrictEqual(f.said, ['Bom dia.', 'Fale de você.']);
  await interviews.turn('Outra resposta.');
  await interviews.end();

  // The provider is down at the opening: the scripted question is used.
  f.deps.api = async (_m, p) => (p === '/v1/mock/start' ? { ok: true, status: 200, data: { id: 'again_3', max_s: 1800, stt: {} } } : { ok: true, data: {} });
  f.deps.fetch = async () => ({ ok: false, status: 503 });
  f.said.length = 0;
  await interviews.start({ agentId: 'g1', lang: 'pt-BR', settings: { depth: 0 } });
  assert.strictEqual((await interviews.turn('')).ok, true);
  assert.match(f.said.join(' '), /trajetória/);
  fs.rmSync(f.dir, { recursive: true });
});

test('a voice interview keeps each question and answer as audio, and the language review', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_rec', max_s: 1800, stt: { token: 't' } } });
  const base = f.deps.fetch;
  const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
  f.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.stream === false ? body.messages[0].content : '';
    if (system.includes('somente a linguagem')) {
      return reply({ nota: 6, erros: [{ tipo: 'concordancia', trecho: 'os dado', sugestao: 'os dados', motivo: 'Plural.' }], corrigida: 'Eu processei os dados com Kafka.' });
    }
    if (system.includes('resumo da revisão')) return reply({ resumo: 'Cuide da concordância.', dicas: ['Diga "os dados".'] });
    return base(url, init);
  };
  const m = createMockInterviews(f.deps);
  await m.start({ agentId: 'g1', lang: 'pt-BR' });
  const opening = await m.turn('');
  assert.deepStrictEqual(opening.added, [{ i: 0, role: 'assistant' }]);
  const mp3 = new Uint8Array([0xff, 0xfb, 1, 2]);
  assert.ok(m.keepAudio({ i: 0, role: 'assistant', mime: 'audio/mpeg', bytes: mp3 }).ok);
  assert.strictEqual(m.keepAudio({ i: 0, role: 'user', mime: 'audio/wav', bytes: mp3 }).ok, false, 'the role must match the message');
  assert.strictEqual(m.keepAudio({ i: 5, role: 'assistant', mime: 'audio/mpeg', bytes: mp3 }).ok, false);
  assert.strictEqual(m.keepAudio({ i: 0, role: 'assistant', mime: 'text/html', bytes: mp3 }).ok, false);
  const r = await m.turn('Eu processei os dado com Kafka.');
  assert.deepStrictEqual(r.added, [{ i: 1, role: 'user' }, { i: 2, role: 'assistant' }]);
  const wav = new Uint8Array(44 + 32000); // one second at 16 kHz
  assert.ok(m.keepAudio({ i: 1, role: 'user', spoken: true, mime: 'audio/wav', bytes: wav }).ok);
  // The answer still being said when the interview ends comes with end().
  const { record } = await m.end('Também usei Go.', { spoken: true, bytes: wav });
  assert.deepStrictEqual(record.audio, [
    { i: 0, role: 'assistant', file: '0-assistant.mp3', s: null },
    { i: 1, role: 'user', file: '1-user.wav', s: 1 },
    { i: 3, role: 'user', file: '3-user.wav', s: 1 }
  ]);
  assert.deepStrictEqual([...m.audio('mock_rec', '0-assistant.mp3')], [...mp3]);
  assert.strictEqual(m.audio('mock_rec', '../mock_rec.json'), null, 'only clip files are served');
  assert.strictEqual(m.audio('mock_rec', '9-user.wav'), null);
  assert.strictEqual(m.keepAudio({ i: 0, role: 'assistant', mime: 'audio/mpeg', bytes: mp3 }).ok, false, 'nothing after the end');
  const L = record.language;
  assert.deepStrictEqual(L.items.map((it) => [it.answer, it.falada]), [['Eu processei os dado com Kafka.', true], ['Também usei Go.', true]]);
  assert.strictEqual(L.items[0].erros[0].sugestao, 'os dados');
  assert.deepStrictEqual(L.items[1].erros, [], 'a correction must quote the answer it fixes');
  assert.strictEqual(L.resumo, 'Cuide da concordância.');
  assert.strictEqual(m.list()[0].language.nota, 60, 'kept with the record');
  fs.rmSync(f.dir, { recursive: true });
});

test('only the newest interviews keep their audio', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'x', max_s: 1800, stt: { token: 't' } } });
  let clock = 1000;
  f.deps.now = () => clock;
  const m = createMockInterviews(f.deps);
  for (let n = 0; n < 22; n += 1) {
    f.deps.api = async (_m, p) => (p === '/v1/mock/start' ? { ok: true, data: { id: `rec_${n}`, max_s: 1800, stt: { token: 't' } } } : { ok: true, data: {} });
    clock += 1000;
    await m.start({ agentId: 'g1', lang: 'pt-BR' });
    await m.turn('');
    m.keepAudio({ i: 0, role: 'assistant', mime: 'audio/mpeg', bytes: new Uint8Array([1, 2, 3]) });
    await m.end('Trabalhei com Kafka.', { spoken: true, bytes: new Uint8Array(44 + 3200) });
  }
  const kept = fs.readdirSync(path.join(f.dir, 'mock_interviews', 'audio')).sort();
  assert.strictEqual(kept.length, 20);
  assert.ok(!kept.includes('rec_0') && !kept.includes('rec_1') && kept.includes('rec_21'));
  assert.strictEqual(m.list().length, 22, 'the reports stay');
  fs.rmSync(f.dir, { recursive: true });
});

test('the report plays each question and answer apart and shows the language review', () => {
  const { loadRenderer, render, tags } = require('./helpers/renderer');
  const r = loadRenderer({ state: { agents: [job] } });
  Object.assign(r.S.mock, {
    phase: 'done',
    record: {
      id: 'm9', company: 'Acme', role: 'Dev', lang: 'pt-BR',
      messages: [{ role: 'assistant', content: 'Fale de você.' }, { role: 'user', content: 'Sou dev.' }, { role: 'assistant', content: 'E um projeto?' }, { role: 'user', content: 'O app de pagamentos.' }],
      audio: [{ i: 0, role: 'assistant', file: '0-assistant.mp3', s: null }, { i: 1, role: 'user', file: '1-user.wav', s: 2 }],
      language: {
        nota: 65, resumo: 'Cuide da concordância.', dicas: ['Diga "os dados".'], tipos: [{ id: 'concordancia', n: 1 }], answers: 2, partial: true,
        items: [{ index: 0, question: 'Fale de você.', answer: 'Sou dev dos dado.', falada: true, nota: 6, erros: [{ tipo: 'concordancia', trecho: 'dos dado', sugestao: 'dos dados', motivo: 'Plural.' }], trocas: [{ de: 'dev', para: ['desenvolvedor'], motivo: 'Mais formal.' }], corrigida: 'Sou desenvolvedor dos dados.', comentario: '' }]
      }
    }
  });
  const html = render(r.Cue, 'mock');
  assert.match(html, /data-section="mock-language"[\s\S]*Language review[\s\S]*65 \/ 100/);
  assert.match(html, /<del data-no-i18n>dos dado<\/del> → <ins data-no-i18n>dos dados<\/ins>/);
  assert.match(html, /<del data-no-i18n>dev<\/del> → <ins data-no-i18n>desenvolvedor<\/ins>/);
  assert.match(html, /Corrected version<\/strong> <span data-no-i18n>Sou desenvolvedor dos dados\./);
  assert.match(html, /Spoken answer/);
  assert.match(html, /1 of 2 answers reviewed\./);
  assert.match(html, /data-section="mock-recording"[\s\S]*Question 1[\s\S]*Your answer[\s\S]*Question 2/);
  assert.strictEqual(tags(html, { 'data-mock-audio': '0-assistant.mp3' }).length, 1);
  assert.strictEqual(tags(html, { 'data-mock-audio': '1-user.wav' }).length, 1);
  // Question 2 was not kept: the system voice reads it. Answer 2 has no audio.
  assert.deepStrictEqual(tags(html, { 'data-action': 'mock-speak-text' }).map((t) => t['data-i']), ['2']);
  assert.match(html, /Typed answer, or no audio was kept\./);
  // A report without either keeps its old shape.
  r.S.mock.record = { id: 'm8', messages: [{ role: 'assistant', content: 'Oi?' }] };
  assert.doesNotMatch(render(r.Cue, 'mock'), /mock-language|mock-recording/);
});

test('the report shows the index, the charts and the stages, and exports the PDF and the conversation', async () => {
  const { loadRenderer, render, tags, settle } = require('./helpers/renderer');
  const saved = [];
  const r = loadRenderer({ state: { agents: [job] }, api: { mockExport: async (kind, name, content) => { saved.push([kind, name, content]); return { ok: true, path: `C:/x/${name}` }; } } });
  const evaluation = (criteria, measured, extra = {}) => ({
    version: 4, score: 70, criteria, measured, signals: {}, pitfalls: [{ id: 'nos', n: 1 }], answers: 1,
    items: [{ index: 0, question: 'Fale de um projeto.', answer: 'Eu migrei para Kafka.', score: 82, veredito: 'Bom exemplo.', notas: { adequacao: 8 } }],
    resumo: 'Bom começo.', vaga: 'Passaria na etapa de mensageria.', fortes: ['Exemplo real'], melhorar: ['Números'], proximo: 'Treine Go.', ...extra
  });
  const now = Date.UTC(2026, 10, 14);
  const record = {
    id: 'm2', startedAt: now, company: 'Acme', role: 'Dev', lang: 'pt-BR', durationS: 600,
    messages: [{ role: 'assistant', content: 'Fale de um projeto.' }, { role: 'user', content: 'Eu migrei para Kafka.' }],
    evaluation: evaluation({ adequacao: 80, evidencias: 60, estrutura: 70, objetividade: 90, vaga: 70, cultura: null },
      { ownership: 80, results: 40, pace: 100, fillers: 90, coverage: { score: 50, covered: ['Kafka'], missing: ['Go'] } }),
    language: { nota: 80, items: [] }
  };
  const earlier = { id: 'm1', startedAt: now - 1000, company: 'Acme', role: 'Dev', messages: [], evaluation: evaluation({ adequacao: 50, cultura: 40, estrutura: 30, evidencias: 50, objetividade: 60 }) };
  Object.assign(r.S.mock, { phase: 'done', record, history: [record, earlier] });
  const html = render(r.Cue, 'mock');
  assert.match(html, /Readiness index[\s\S]*<b>72<\/b>[\s\S]*Ready for the job/, 'the index out of 100 and its band');
  assert.match(html, /Average of your last 1 interviews: <b>45<\/b><span class="mock-sc-delta up">\+27<\/span>/);
  assert.match(html, /What makes up your score[\s\S]*<svg/);
  assert.match(html, /Where you are strong[\s\S]*<polygon/);
  assert.match(html, /Verdict for this job[\s\S]*Passaria na etapa de mensageria\.[\s\S]*mock-sc-term ok[^>]*>Kafka/);
  assert.match(html, /Compared with your earlier interviews/);
  assert.strictEqual(tags(html, { class: 'mock-sc-stage' }).length, 3, 'three stages that open');
  assert.match(html, /<details class="mock-sc-stage" open>[\s\S]*Content/, 'the first stage starts open');
  assert.match(html, /<details class="card mock-sc-sec">[\s\S]*Question by question/, 'the details are closed');
  assert.doesNotMatch(html, /score-disc/);

  r.Cue.actions['mock-export-pdf']();
  r.Cue.actions['mock-export-chat']();
  await settle();
  assert.deepStrictEqual(saved.map(([kind, name]) => [kind, name]), [['pdf', 'lipcue-mock-acme-dev-2026-11-14.pdf'], ['txt', 'lipcue-mock-acme-dev-2026-11-14-conversation.txt']]);
  const pdf = saved[0][2];
  assert.strictEqual(pdf.card.index, 72);
  assert.match(pdf.parts.donut, /^<svg/);
  assert.strictEqual(pdf.labels.stages.aderencia, 'Job fit');
  const doc = require('../src/main/mock_report').reportHtml(pdf.record, pdf.card, pdf.labels, pdf.parts);
  assert.match(doc, /^<!doctype html>[\s\S]*<title>lipcue-mock-acme-dev-2026-11-14<\/title>[\s\S]*Readiness index/);
  assert.strictEqual(saved[1][2], 'Mock interview: Acme · Dev\n' + saved[1][2].split('\n')[1] + '\n\nOrby:\nFale de um projeto.\n\nYou:\nEu migrei para Kafka.\n');
});

test('the topics asked for and the main files reach the interviewer, and each start gets its own seed', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_focus', max_s: 1800, stt: { token: 't' } } });
  let n = 0;
  f.deps.seed = () => { n += 1; return 7; };
  const systems = [];
  const base = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream !== false) systems.push(body.messages[0].content);
    return base(url, init);
  };
  const m = createMockInterviews(f.deps);
  const prep = m.prep('g1');
  assert.deepStrictEqual(prep.files.map((x) => [x.key, x.type]), [['CV', 'resume'], ['Notas', 'upload']]);
  const r = await m.start({ agentId: 'g1', lang: 'pt-BR', settings: { focus: 'Kafka no Nubank', priority: ['Notas'] } });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(r.topics.slice(0, 2), ['trajectory', 'focus']);
  assert.deepStrictEqual(r.settings.priority, ['Notas']);
  await m.turn('');
  assert.strictEqual(systems.length, 1, 'with a seed the model opens');
  assert.match(systems[0], /assuntos_pedidos/);
  assert.match(systems[0], /"title":"Notas","prioridade":true/);
  await m.end('');
  fs.rmSync(f.dir, { recursive: true });
});

test('the setup offers the job files as main files and sends the marked ones with the start', async () => {
  const { loadRenderer, render, tags } = require('./helpers/renderer');
  const r = loadRenderer({ state: { agents: [job] } });
  Object.assign(r.S.mock, { phase: 'idle', agentId: 'g1', prep: { g1: { total: 0, questions: [], files: [{ key: 'CV', title: 'CV', type: 'resume' }, { key: 'Notas', title: 'Notas', type: 'upload' }] } }, priority: { g1: ['Notas'] } });
  const html = render(r.Cue, 'mock');
  assert.match(html, /What can be asked/);
  assert.strictEqual(tags(html, { 'data-input': 'mock-focus' }).length, 1);
  const chips = tags(html, { 'data-action': 'mock-file-main' });
  assert.deepStrictEqual(chips.map((t) => [t['data-key'], t['aria-pressed']]), [['CV', 'false'], ['Notas', 'true']]);
  r.Cue.actions['mock-file-main']({ dataset: { key: 'CV' } });
  assert.deepStrictEqual([...r.S.mock.priority.g1], ['Notas', 'CV']);
  r.Cue.actions['mock-file-main']({ dataset: { key: 'Notas' } });
  assert.deepStrictEqual([...r.S.mock.priority.g1], ['CV']);
});
