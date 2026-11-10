// Regenerates the live parity fixtures from the site's JS port
// (Browser/Home/src/lib/live). The expected values are then checked against
// the engine by tests/core_tests/test_live_parity.cpp: a fixture the C++
// side disagrees with means the port drifted, so fix the port, not the
// fixture. Run: node tests/fixtures/live_parity/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const live = path.resolve(here, '../../../../Browser/Home/src/lib/live');
const { assessQuestion } = await import(pathToFileURL(path.join(live, 'questionGate.js')));
const { buildCopilotMessages, renderHistory } = await import(pathToFileURL(path.join(live, 'prompt.js')));
const { createTurnAssembler } = await import(pathToFileURL(path.join(live, 'turns.js')));
const { createStoryLedger } = await import(pathToFileURL(path.join(live, 'storyLedger.js')));

const write = (name, data) => writeFileSync(path.join(here, name), `${JSON.stringify(data, null, 2)}\n`);

// Real interviewer lines from test_question_gate.cpp and test_question_flow.cpp.
const PHRASES = [
  'Qual foi o maior desafio do TechFinance?', 'Você já trabalhou com Kafka?', 'What was your biggest challenge?',
  'Por que você quer trabalhar no Nubank?', 'Como você lidaria com um conflito no time?',
  'Me conta sobre um projeto em que você teve um prazo apertado', 'Fale um pouco sobre você.',
  'Tell me about a time you failed.', 'Me fala do seu projeto', 'Você já trabalhou com Kafka',
  'Legal. E qual tecnologia você usou nesse projeto', 'Sabe me dizer quanto tempo levou a migração',
  'Walk me through your resume', 'Conte uma situação em que você errou.',
  'Qual sua experiência com Kafka? Porque aqui a gente usa muito.', 'E por quê?', 'Como assim?', 'E por quê',
  'Me fala disso', 'Me conta sobre um projeto em que você', 'Qual foi o maior', 'Qual é a sua experiência com',
  'Qual é a sua experiência com?', 'Me conta do seu projeto, tipo', 'Me fala,', 'Me conta',
  'E qual foi o resultado que a gente', 'Tell me about the', 'Qual é o nome do seu',
  'Como você resolveu o problema de...', 'Como você escalou o pipeline de dados do Kubernetes com',
  'Como eu disse, aqui a gente usa Kafka e Clojure.', 'Quando a gente contrata estagiários, eles passam por um onboarding.',
  'O que a gente espera de você é proatividade.', 'What we do here is build payment systems.',
  'Como você sabe, o Nubank é uma empresa grande.', 'Você vai ver que aqui o ritmo é bem rápido.',
  'Bom, a nossa empresa trabalha com pagamentos e tem muitos clientes no Brasil e no México.',
  'Por que eu deveria te contratar', 'Por que eu pagaria trinta por cento a mais',
  'Por que a gente escolheria você e não outro candidato', 'Why should we hire you', 'Porque aqui a gente usa muito Kafka.',
  'Quando eu entrei aqui, o time era pequeno.', 'O que eu quero dizer é que o prazo é curto.', 'Como já falei, a vaga é remota.',
  'Como vocês viram, o produto é grande.', 'Hum, é, então, tipo', 'Legal, bacana, entendi.', 'Tudo bem? Está me ouvindo?',
  'Can you hear me?', 'O quê?', 'Opa, testando, tudo bem?', 'ok ok ok ok', 'Ahn.', 'Bom dia, tudo bem com você?',
  'Como você chegou a US$ 5.000 de receita com o bot em Node.js?', 'Me conta sobre', 'Me conta sobre o projeto de Kubernetes',
  'Qual foi o maior desafio?', 'Tell me about', 'Qual é a sua experiência', 'Experiência com Kafka?',
  'Qual é a sua experiência com Kafka?', 'Me fala do projeto', 'Por quê?', 'Por que você saiu?', 'Por quê? Por que você saiu?',
  'Fala, tudo bem?', 'Oi, tudo bem com você?', 'Está me ouvindo bem?', 'Can you hear me okay?', 'Consegue ver minha tela?',
  'Opa, boa tarde, tudo certo por aí?', 'Como vai o projeto de dados?', 'Bom, me fala do seu projeto de Kubernetes.',
  'tá, tá bom', 'Aqui a gente usa muito Kafka e Clojure.', 'Você já trabalhou com isso?',
  'Então, o projeto de Kubernetes foi assim', 'Qual foi o maior desafio do projeto?', 'Qual foi o maior desafio do projeto',
  'Me conta sobre um projeto', 'e quais foram os resultados?', 'Como você resolveu o problema de…',
  '', '   ', 'uhum', 'Kubernetes', 'Fale sobre você', 'Tell me about yourself', 'Qual o',
];

const gate = [];
for (const text of PHRASES) {
  for (const [hasContext, final] of [[false, false], [true, false], [false, true], [true, true]]) {
    const r = assessQuestion(text, { hasContext, final });
    gate.push({ text, has_context: hasContext, final, verdict: r.verdict, explicit: r.explicit });
  }
}
write('question_gate.json', gate);

// Deepgram multichannel messages (channel_index [n, 2]) and the turns they make.
const res = (ch, text, { isFinal = true, speechFinal = false, start = 0, duration = 1 } = {}) => ({
  type: 'Results', channel_index: [ch, 2], is_final: isFinal, speech_final: speechFinal, start, duration,
  channel: { alternatives: [{ transcript: text }] },
});
const sequences = [
  { name: 'interviewer question closed by speech_final', messages: [
    res(1, 'Me conta sobre um projeto', { start: 1.0, duration: 1.4 }),
    res(1, 'em que você teve um prazo apertado?', { start: 2.4, duration: 1.6, speechFinal: true }),
  ] },
  { name: 'interim results never make a turn', messages: [
    res(1, 'Qual foi', { isFinal: false, start: 0, duration: 0.5 }),
    res(1, 'Qual foi o maior desafio', { isFinal: false, start: 0, duration: 1.2 }),
  ] },
  { name: 'UtteranceEnd closes only its channel', messages: [
    res(0, 'Então, no projeto de dados', { start: 3.0, duration: 1.0 }),
    res(1, 'Hum', { start: 3.2, duration: 0.3 }),
    { type: 'UtteranceEnd', channel: [0, 2], last_word_end: 4.0 },
    res(1, 'entendi.', { start: 4.1, duration: 0.5, speechFinal: true }),
  ] },
  { name: 'both speakers interleaved', messages: [
    res(1, 'Você já trabalhou com Kafka?', { start: 0.0, duration: 1.8, speechFinal: true }),
    res(0, 'Sim, trabalhei com Kafka', { start: 2.2, duration: 1.5 }),
    res(0, 'por dois anos.', { start: 3.7, duration: 0.9, speechFinal: true }),
  ] },
  { name: 'empty finals and metadata are ignored', messages: [
    { type: 'Metadata', request_id: 'x' },
    res(1, '', { start: 0, duration: 0.2, speechFinal: true }),
    { type: 'SpeechStarted', channel: [1, 2], timestamp: 0.3 },
    res(1, 'Tudo bem?', { start: 0.4, duration: 0.6, speechFinal: true }),
  ] },
  { name: 'UtteranceEnd without a channel closes both', messages: [
    res(0, 'Certo', { start: 0, duration: 0.4 }),
    res(1, 'E o resultado?', { start: 0.5, duration: 0.8 }),
    { type: 'UtteranceEnd', last_word_end: 1.3 },
  ] },
];
write('turns.json', sequences.map(({ name, messages }) => {
  const a = createTurnAssembler();
  messages.forEach((m) => a.push(m));
  return { name, messages, turns: a.turns().map(({ speaker, text, startMs, endMs }) => ({ speaker, text, startMs, endMs })) };
}));

// Prompts: the engine's build_copilot_messages with a session profile and no
// retrieval. history is rendered from the turns with max_history_chars.
const PROFILE = '=== VAGA ===\nNubank · Engenheira de Dados\n\n=== CURRÍCULO ===\nCinco anos com pipelines em Kafka e Spark.';
const turnsA = [
  { speaker: 'Outros', text: 'Bom dia, tudo bem com você?' },
  { speaker: 'Você', text: 'Tudo ótimo, obrigada.' },
  { speaker: 'Outros', text: 'Me conta sobre um projeto' },
  { speaker: 'Outros', text: 'em que você teve um prazo apertado?' },
];
const long = Array.from({ length: 30 }, (_, i) => ({ speaker: i % 2 ? 'Você' : 'Outros', text: `Fala número ${i} sobre o pipeline de dados com acentuação é ç ã.` }));
const prompts = [
  { name: 'question with profile, automatic', profile: PROFILE, turns: turnsA, max_history_chars: 3500, trigger: 'Me conta sobre um projeto em que você teve um prazo apertado?', reason: 'question', allow_skip: true },
  { name: 'question without profile or history', profile: '', turns: [], max_history_chars: 3500, trigger: 'Why should we hire you?', reason: 'question', allow_skip: false },
  { name: 'long history cut at a UTF-8 boundary', profile: PROFILE, turns: long, max_history_chars: 900, trigger: 'E qual foi o resultado?', reason: 'question', allow_skip: true },
  { name: 'long turn', profile: '  ', turns: turnsA, max_history_chars: 3500, trigger: 'Aqui a gente usa muito Kafka e Clojure.', reason: 'long_turn', allow_skip: false },
  { name: 'manual request', profile: PROFILE, turns: turnsA.slice(0, 2), max_history_chars: 3500, trigger: 'Tudo ótimo, obrigada.', reason: 'manual', allow_skip: false },
];
const LEDGER_TEXT = '- Perguntaram: Conte sobre um projeto em equipe.\n  Eu disse: No hackathon da Ninja Startup eu liderei o alinhamento técnico.\n';
const RETRIEVED = '=== DECISÃO AUTÔNOMA DO RAG ===\nTipo de pergunta: comportamental.\n[SOBRE MIM: meus arquivos, fatos que posso afirmar]\n• (cv.md) Cinco anos com pipelines em Kafka e Spark.';
prompts.push(
  { name: 'story ledger and retrieved excerpts', profile: PROFILE, turns: turnsA, max_history_chars: 3500, trigger: 'E qual foi o resultado?', reason: 'question', allow_skip: true, story_ledger: LEDGER_TEXT, retrieved: RETRIEVED },
  { name: 'story ledger on a manual request', profile: '', turns: turnsA.slice(0, 2), max_history_chars: 3500, trigger: 'Tudo ótimo, obrigada.', reason: 'manual', allow_skip: false, story_ledger: 'Usei o TechFinance para falar de prazo.', retrieved: '' },
);
write('prompt.json', prompts.map((c) => {
  const history = renderHistory(c.turns, c.max_history_chars);
  const story_ledger = c.story_ledger || '';
  const retrieved = c.retrieved || '';
  return { ...c, story_ledger, retrieved, history, messages: buildCopilotMessages({ profile: c.profile, history, trigger: c.trigger, reason: c.reason, allowSkip: c.allow_skip, storyLedger: story_ledger, retrieved }) };
}));

// Story ledger: a list of operations and what the ledger says after them.
const QA = [
  ['Conte sobre um projeto onde você trabalhou em equipe.', 'Trabalho bem em equipe quando o objetivo está claro. Um exemplo foi o hackathon da Ninja Startup, onde eu liderei o alinhamento técnico com **WebSocket** e Docker e ganhamos o primeiro lugar.'],
  ['Por que você quer trabalhar no iFood?', 'Porque o iFood resolve logística em escala,\nque é o que eu mais gosto de fazer.'],
  ['Você já usou Kafka?', 'Sim, usei Kafka por dois anos. No TechFinance eu desenhei o pipeline de eventos que processava os pagamentos e reduzi a latência com particionamento por conta do cliente, o que deixou a conciliação muito mais rápida para a operação inteira do banco digital, sem perder a ordem das mensagens em nenhum momento do processamento.'],
  ['Qual foi a decisão técnica mais difícil?', 'Ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação'],
  ['Como você lida com prazo apertado?', 'Eu corto escopo antes de cortar qualidade. No TechFinance negociei a entrega em duas fases.'],
  ['E conflito no time?', 'Eu converso em particular primeiro. Foi assim com o time de dados na Vértice.'],
];
const ledgers = [
  { name: 'empty', options: {}, ops: [] },
  { name: 'two subjects stay', options: {}, ops: QA.slice(0, 2).map((x) => ({ add: x })) },
  { name: 'repeated question keeps the newest wording', options: {}, ops: [{ add: [QA[0][0], 'Primeira versão.'] }, { add: [QA[0][0], 'Segunda versão.'] }, { add: ['', 'sem pergunta'] }, { add: ['Sem resposta?', '  '] }] },
  { name: 'long answers are cut at a sentence end or with an ellipsis', options: {}, ops: [{ add: QA[2] }, { add: QA[3] }] },
  { name: 'small budget drops old entries from the prompt', options: { promptChars: 420 }, ops: QA.map((x) => ({ add: x })) },
  { name: 'summary of the older entries', options: { promptChars: 420 }, ops: [...QA.map((x) => ({ add: x })), { summary: [4, 'Usei o hackathon da Ninja Startup para equipe e o TechFinance para Kafka.'] }, { summary: [2, 'resumo antigo'] }] },
  { name: 'prior sessions come first', options: {}, ops: [{ prior: 'Na primeira entrevista falei do TechFinance e de Kafka.\n' }, { add: QA[4] }] },
];
write('ledger.json', ledgers.map(({ name, options, ops }) => {
  const l = createStoryLedger(options);
  const added = [];
  for (const op of ops) {
    if (op.add) added.push(l.add(op.add[0], op.add[1]));
    else if (op.prior !== undefined) l.setPrior(op.prior);
    else if (op.summary) l.setSummary(op.summary[0], op.summary[1]);
  }
  const spoken = '[Você] Na verdade foram três meses, não dois.\n';
  const job = l.compactionJob(spoken);
  return {
    name, prompt_chars: options.promptChars || 1400, ops, added, size: l.size(), render: l.render(), persistable: l.persistable(),
    needs_compaction: l.needsCompaction(), spoken, job_covered: job.covered, job_system: job.messages[0].content, job_user: job.messages[1].content,
  };
}));
console.log(`question_gate ${gate.length}, turns ${sequences.length}, prompt ${prompts.length}, ledger ${ledgers.length}`);
