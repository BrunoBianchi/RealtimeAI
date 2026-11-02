// JEV on real session logs: which questions get evaluated against the
// candidate's spoken answer, and which questions reach the question bank
// (never the copilot's own answers; JEV decides the kind of each question).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const jev = require('../src/main/jev_engine.js');
const { loadMain } = require('./helpers/main');
const { loadRenderer } = require('./helpers/renderer');

// A practice session as the engine logs it: the questions came through the
// chat (pasted with "Responda por áudio:"), the candidate answered by voice
// and every turn is "voce" (no system audio).
const PRACTICE = [
  { type: 'session_start', started_at: '2026-11-01T20:32:50-03:00', mode: 'live' },
  { type: 'notice', text: 'Active goal: Ifood — Estágio Gen IA Ifood (Ifood) · 1 doc(s)' },
  { type: 'suggestion', t: 9345, status: 'completed', reason: 'chat', trigger: 'Responda por áudio: Imagine que você está iniciando no iFood e precisa aprender uma tecnologia nova rápido. Como faria?', text: 'Eu começaria pela documentação oficial...' },
  { type: 'turn', src: 'voce', t0: 24000, t: 30850, text: 'Bom, para adquirir conhecimento técnico rápido eu começo pela documentação oficial' },
  { type: 'turn', src: 'voce', t0: 31000, t: 46840, text: 'e construo protótipos funcionais para validar hipóteses e aprender na prática.' },
  { type: 'suggestion', t: 85789, status: 'completed', reason: 'chat', trigger: 'Me conte uma vez em que você teve que assumir uma nova responsabilidade.', text: 'No hackathon eu assumi a liderança técnica...' },
  { type: 'turn', src: 'voce', t0: 90000, t: 102376, text: 'No hackathon da Ninja Startup eu assumi a liderança técnica quando o líder saiu no meio do projeto.' },
  // A screenshot answer (a quiz on screen) and a request to the copilot: not interview questions.
  { type: 'suggestion', t: 120000, status: 'completed', reason: 'screenshot', trigger: 'Screenshot', text: '- **Cálculo:** Como $1/5$ de 50 é 10, ela também fez **10%** do total.' },
  { type: 'suggestion', t: 130000, status: 'completed', reason: 'chat', trigger: 'qual a resposta dessa', text: '**540** reais.' },
  { type: 'session_end', reason: 'normal' }
];

// An interview with system audio: the interviewer asks, the engine answers.
const INTERVIEW = [
  { type: 'turn', src: 'outros', t0: 1000, t: 4000, text: 'Por que você quer trabalhar no iFood?' },
  { type: 'suggestion', t: 4300, status: 'completed', reason: 'question', trigger: 'Por que você quer trabalhar no iFood?', understood: 'Por que você quer trabalhar no iFood?', text: 'Porque...' },
  { type: 'turn', src: 'voce', t0: 6000, t: 15000, text: 'Porque eu quero aplicar inteligência artificial em logística com impacto real no dia a dia de milhões.' },
  { type: 'turn', src: 'outros', t0: 16000, t: 18000, text: 'Legal.' },
  { type: 'turn', src: 'outros', t0: 19000, t: 22000, text: 'Como você lida com prazos apertados?' },
  { type: 'turn', src: 'voce', t0: 23000, t: 24000, text: 'Depende.' }
];

test('JEV pairs practice questions from the chat with the spoken answer that followed', () => {
  const { main, restore } = loadMain();
  try {
    const pairs = main.jevPairs(PRACTICE);
    assert.deepStrictEqual(pairs.map((p) => p.question.slice(0, 30)), ['Imagine que você está iniciand', 'Me conte uma vez em que você t']);
    assert.ok(!pairs[0].question.startsWith('Responda'), 'practice prefix removed');
    assert.ok(pairs[0].answer.includes('documentação oficial') && pairs[0].answer.includes('protótipos'), 'both answer turns joined');
    assert.ok(pairs[1].answer.includes('liderança técnica'));
    assert.ok(pairs[0].answerSeconds > 0);
    // The screenshot and "qual a resposta dessa" got no spoken answer: no pair.
    assert.strictEqual(pairs.length, 2);
  } finally {
    restore();
  }
});

test('JEV pairs interviewer questions, lends them the engine reading and skips short answers', () => {
  const { main, restore } = loadMain();
  try {
    const anchors = main.sessionQuestionAnchors(INTERVIEW);
    // The suggestion that answered the block does not become a second question.
    assert.strictEqual(anchors.filter((a) => /iFood/.test(a.text)).length, 1);
    const pairs = main.jevPairs(INTERVIEW);
    assert.strictEqual(pairs.length, 1, '"Depende." is too short to evaluate');
    assert.strictEqual(pairs[0].understood, 'Por que você quer trabalhar no iFood?');
    assert.strictEqual(pairs[0].copilot, 'Porque...');
  } finally {
    restore();
  }
});

test('the session export never turns a copilot answer into a bank question', () => {
  const md = `# Session 2026-11-01 20:43

## Timeline

**[00:11] You:** Mas me ajuda a fazer isso aqui.

> **Suggestion [00:27]** · screen · 1st token in 1.5 s
> Screen: "Screenshot"
>
> - **Cálculo:** Ela fez $1/5$ da parte deles. Como $1/5$ de 50 é 10, ela também fez **10%** do total.
> Qual é a melhor forma de explicar isso para o entrevistador?

**[01:10] Outros:** Como você prioriza tarefas quando tudo é urgente?

> **Suggestion [01:12]** · question
> Question: "Me conte uma vez em que você teve que assumir uma nova responsabilidade?"

*[02:16] Notice: Check before saying it: Socket is not in your files.*

## Summary

Como o candidato se saiu? Respondeu bem às perguntas sobre prioridade.
`;
  const texts = jev.extractQuestionsFromTranscript(md).map((q) => q.text);
  assert.deepStrictEqual(texts.sort(), [
    'Como você prioriza tarefas quando tudo é urgente?',
    'Me conte uma vez em que você teve que assumir uma nova responsabilidade?'
  ]);
  assert.strictEqual(jev.validateQuestionWithJev('Como $1/5$ de 50 é 10, ela também fez **10%** do total?').valid, false);
});

test('rule-based reading puts "me conte uma vez..." in the personal (behavioral) bucket', () => {
  for (const q of [
    'Me conte uma vez em que você teve que assumir uma nova responsabilidade?',
    'Conte uma situação em que você precisou lidar com um colega difícil?',
    'Como você lida com críticas ao seu trabalho?'
  ]) {
    assert.strictEqual(jev.categorizeQuestionWithJev(q).category, 'Behavioral', q);
  }
});

test('JEV classification decides the kind, rewrites generically and drops what does not belong', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rtai-qb-'));
  const transcript = [
    'Entrevistador: Me conte uma vez em que você teve que assumir uma nova responsabilidade?',
    'Entrevistador: Como os valores do iFood aparecem no seu dia a dia?',
    'Entrevistador: Você comentou que aprendeu React com protótipos no Tech Lab, como faz isso?',
    'Entrevistador: Qual a resposta dessa conta na tela?'
  ].join('\n');
  let seen = null;
  const classify = async (texts, ctx) => {
    seen = { texts, ctx };
    return [
      { i: 0, tipo: 'pessoal', pergunta: 'Me conte uma vez em que você teve que assumir uma nova responsabilidade.' },
      { i: 1, tipo: 'cultura', pergunta: 'Como os valores da empresa aparecem no seu dia a dia?' },
      { i: 2, tipo: 'tecnica', pergunta: 'Como você aprende uma tecnologia nova rapidamente?' },
      { i: 3, tipo: 'nao_pergunta', pergunta: '' }
    ];
  };
  const res = await jev.ingestSessionQuestions(dir, transcript, 'Ifood', { exactCompany: true, classify });
  assert.strictEqual(seen.texts.length, 4);
  assert.strictEqual(seen.ctx.company, 'Ifood');
  const bank = jev.loadQuestionBank(dir);
  const qs = bank.companies[0].questions;
  const by = (t) => qs.find((q) => q.text.startsWith(t));
  assert.strictEqual(by('Me conte uma vez').category, 'Behavioral');
  assert.strictEqual(by('Me conte uma vez').subCategory, 'Pessoal e comportamental');
  assert.strictEqual(by('Como os valores').category, 'Culture');
  assert.strictEqual(by('Como você aprende uma tecnologia').category, 'Technical', 'specific follow-up rewritten generically');
  assert.ok(!qs.some((q) => /Tech Lab|conta na tela/.test(q.text)), 'specific wording and non-questions are left out');
  assert.ok(qs.every((q) => q.classifiedBy === 'jev'));
  assert.strictEqual(res.added, 3);

  // JEV unavailable (no key / failure): the rule-based reading stands.
  const dir2 = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rtai-qb-'));
  await jev.ingestSessionQuestions(dir2, transcript, 'Ifood', { exactCompany: true, classify: async () => null });
  const fallback = jev.loadQuestionBank(dir2).companies[0].questions;
  assert.ok(fallback.length >= 2 && fallback.every((q) => q.classifiedBy === 'regras'));
  assert.strictEqual(fallback.find((q) => q.text.startsWith('Me conte')).category, 'Behavioral');
});

test('an older bank is rebuilt from the session logs, without the copilot answers', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY; // no network in tests: rule-based reading
  const { main, dataDir, restore } = loadMain();
  try {
    const sessions = path.join(dataDir, 'RealTimeAI', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const events = [...PRACTICE.slice(0, 2), ...INTERVIEW];
    fs.writeFileSync(path.join(sessions, '2026-11-01_20-32-50_8a9a.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    fs.writeFileSync(path.join(sessions, '2026-11-01_20-32-50_8a9a.md'), '# Session\n\n## Timeline\n\n> - **Cálculo:** Como $1/5$ de 50 é 10?\n');
    // A bank from an older version, with the bad question.
    fs.writeFileSync(path.join(dataDir, 'RealTimeAI', 'question_bank.json'), JSON.stringify({
      companies: [{ id: 'ifood', name: 'Ifood', questions: [{ id: 'x', text: 'Como $1/5$ de 50 é 10, ela também fez **10%** do total.?', category: 'General' }] }]
    }));

    const res = await main.rebuildQuestionBankFromSessions();
    const bank = res.bank;
    assert.strictEqual(bank.version, jev.QUESTION_BANK_VERSION);
    const texts = bank.companies.flatMap((c) => c.questions.map((q) => q.text));
    assert.ok(texts.some((t) => t.includes('trabalhar no iFood')), texts.join(' | '));
    assert.ok(texts.some((t) => t.includes('prazos apertados')));
    assert.ok(!texts.some((t) => /\$|\*\*/.test(t)), 'no markup from copilot answers');
    // Chat questions only enter when JEV can vet them (no key here).
    assert.ok(!texts.some((t) => t.includes('Imagine que')));
  } finally {
    restore();
    if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('the dashboard reloads the rebuilt bank quietly', async () => {
  let bank = { companies: [] };
  const r = loadRenderer({ api: { getQuestionBank: async () => bank } });
  await r.boot();
  const [onUpdate] = r.calls.find(([n]) => n === 'onQuestionBankUpdated')[1];
  bank = { companies: [{ id: 'ifood', name: 'Ifood', questions: [{ text: 'Por que o iFood?', category: 'Culture' }] }] };
  await onUpdate({ rebuilt: true, added: 1 });
  assert.strictEqual(r.S.questionBank.companies[0].name, 'Ifood');
  assert.deepStrictEqual(r.toasts(), [], 'no "new questions" toast for a rebuild');
  assert.strictEqual(r.Cue.catLabel('Behavioral'), 'Pessoal');
});
