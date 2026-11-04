'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockInterviews, buildIndex, retrieve, systemPrompt, takeSentences, LANGUAGES, bankQuestionsFor, bankStep, withBankQuestion } = require('../src/main/mock_interview');
const { entitlement, PRICING } = require('../src/main/plans');

const job = {
  id: 'g1', company: 'Acme', role: 'Backend', job_description: 'Go e Kafka',
  documents: [{ title: 'CV', tag: 'resume', content: 'Bruno liderou a migração para Kafka no Nubank.' }, { title: 'Notas', tag: 'material', content: 'Gosto de jardinagem.' }]
};
const other = { id: 'g2', documents: [{ title: 'Portfólio', tag: 'material', content: 'Projeto de observabilidade com Prometheus.' }, job.documents[0]] };

test('retrieval finds the relevant upload across sessions, once per file', () => {
  const index = buildIndex(job, [other]);
  assert.strictEqual(index.chunks.length, 3);
  assert.strictEqual(retrieve(index, 'como foi a migração kafka?')[0].title, 'CV');
  assert.strictEqual(retrieve(index, 'prometheus observabilidade')[0].title, 'Portfólio');
  assert.deepStrictEqual(retrieve(index, 'xyzzy'), []);
});

test('the interviewer sees the job, the résumé and the excerpts, and closes on time', () => {
  const excerpts = [{ title: 'Portfólio', text: 'Prometheus' }];
  const p = systemPrompt({ agent: job, resume: 'CV AQUI', excerpts, lang: 'pt-BR', secondsLeft: 900 });
  for (const part of ['Acme', 'Go e Kafka', 'CV AQUI', 'Prometheus', 'português']) assert.ok(p.includes(part), part);
  assert.ok(systemPrompt({ agent: job, resume: '', excerpts: [], lang: 'en', secondsLeft: 100 }).includes('termine agora'));
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

test('a turn streams sentences, the end mark closes it, and the feedback is kept', async () => {
  const f = fakeDeps({ ok: true, data: { id: 'mock_1', max_s: 1800, source: 'plan', stt: { token: 't' } } });
  const m = createMockInterviews(f.deps);
  assert.strictEqual((await m.start({ agentId: 'g1', lang: 'pt-BR' })).maxS, 1800);
  const opening = await m.turn('');
  assert.deepStrictEqual(f.said, ['Bom dia.', 'Fale de você.']);
  assert.strictEqual(opening.finished, true);
  await m.turn('Trabalhei com Kafka.');
  const done = await m.end();
  assert.strictEqual(done.record.feedback, 'Nota 7.');
  assert.deepStrictEqual(m.list().map((r) => r.id), ['mock_1']);
  assert.ok(f.calls.indexOf('/v1/mock/mock_1/end') > f.calls.lastIndexOf('/v1/mock/mock_1/chat'), 'feedback before the end');
  fs.rmSync(f.dir, { recursive: true });
});

test('a refused start is explained and opens nothing', async () => {
  const f = fakeDeps({ ok: false, status: 402, error: 'mock_not_included' });
  const m = createMockInterviews(f.deps);
  const r = await m.start({ agentId: 'g1', lang: 'en' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('PRO'));
  assert.strictEqual(m.isActive(), false);
  fs.rmSync(f.dir, { recursive: true });
});

test('entitlement: PRO has one a month, credits work on any plan', () => {
  assert.strictEqual(entitlement({ plan: { id: 'free' } }).canMock, false);
  assert.strictEqual(entitlement({ plan: { id: 'free', mock_credits: 1 } }).canMock, true);
  assert.strictEqual(entitlement({ plan: { id: 'pro', mocks_limit: 1 } }).mocksLeft, 1);
  assert.strictEqual(entitlement({ plan: { id: 'pro', mocks_limit: 1, mocks_used: 1 } }).canMock, false);
});

test('the page shows the same interview catalog as plans.js, and the video ships', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/mock.js'), 'utf8');
  for (const p of PRICING.mockPacks) assert.ok(src.includes(`{ id: '${p.id}', interviews: ${p.interviews}, price: ${p.price} }`), p.id);
  assert.ok(fs.statSync(path.join(__dirname, '../src/renderer/media/mock-how-it-works.webm')).size > 100000);
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
  assert.deepStrictEqual(pairs[0], { question: 'Bom dia. Fale de você.', understood: 'Bom dia. Fale de você.', answer: 'Trabalhei com Kafka.' });
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
  const p = systemPrompt({ agent: job, resume: '', excerpts: [], lang: 'es', secondsLeft: 900 });
  assert.ok(p.includes('Fale somente em espanhol'));
  assert.deepStrictEqual(takeSentences('こんにちは。自己紹介をお願いします').sentences, ['こんにちは。']);
  assert.strictEqual(takeSentences('字'.repeat(300)).sentences[0].length, 220);
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
  const me = { bank: qs, bankUsed: new Set(['Como escalar Kafka?']), bankAsked: false, bankFollowUps: 0 };
  const q = bankStep(me, 'conflito no time');
  assert.strictEqual(q.text, 'Conte sobre um conflito no time');
  const sent = withBankQuestion([{ role: 'system', content: 's' }, { role: 'user', content: 'resposta' }], q);
  assert.ok(sent[1].content.startsWith('resposta') && sent[1].content.includes('Conte sobre um conflito no time'));
  assert.strictEqual(withBankQuestion(sent, null), sent);
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

test('the interviewer moves to the next bank question after two follow-ups', () => {
  const bank = bankQuestionsFor({ company: 'A' }, { companies: [{ name: 'A', questions: [{ text: 'primeira pergunta', interviewsCount: 2 }, { text: 'segunda pergunta' }] }] });
  const me = { bank, bankUsed: new Set(), bankAsked: false, bankFollowUps: 0 };
  const steps = Array.from({ length: 7 }, () => (bankStep(me, '') || {}).text || null);
  assert.deepStrictEqual(steps, ['primeira pergunta', null, null, 'segunda pergunta', null, null, null]);
});

test('an answer that goes on after a pause cancels the turn and gives its bank question back', async () => {
  const f = fakeDeps({ ok: true, status: 200, data: { id: 'm1', max_s: 1800, stt: {} } });
  f.deps.bank = () => ({ companies: [{ name: job.company, questions: [{ text: 'primeira pergunta do banco' }, { text: 'segunda pergunta do banco' }] }] });
  f.deps.emit = () => {};
  let sent = [];
  f.deps.fetch = (_url, init) => new Promise((_resolve, reject) => {
    sent.push(JSON.parse(init.body).messages);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const interviews = createMockInterviews(f.deps);
  await interviews.start({ agentId: 'g1', lang: 'pt-BR' });
  const first = interviews.turn('metade da resposta');
  assert.ok(sent[0].at(-1).content.includes('primeira pergunta do banco'));
  assert.strictEqual(interviews.cancelTurn().ok, true);
  assert.deepStrictEqual(await first, { ok: false, aborted: true });
  const second = interviews.turn('resposta inteira');
  const last = sent[1].at(-1).content;
  assert.ok(last.startsWith('resposta inteira') && last.includes('primeira pergunta do banco'));
  assert.ok(!sent[1].some((m) => m.content === 'metade da resposta'));
  interviews.cancelTurn();
  await second;
  fs.rmSync(f.dir, { recursive: true });
});
