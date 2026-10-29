const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const jevEngine = require('../src/main/jev_engine');

// Setup environment and electron stub to test main.js debrief functions
const tmpEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-deb-'));
process.env.LOCALAPPDATA = tmpEnv;
process.env.RTAI_TEST_EXPORTS = '1';

const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
  BrowserWindow: function () {},
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
  nativeTheme: { shouldUseDarkColors: true },
  Notification: { isSupported: () => false }
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return realLoad.call(this, request, ...rest);
};
const main = require('../src/main/main.js');
Module._load = realLoad;

test('Real Questions System: Markdown (.md) Session Extraction', () => {
  const mdSession = `
# Session 2026-10-27 10:00
- Started: 2026-10-27T10:00:00-03:00
- Duration: 15:30
- Mode: live
- STT: whisper-large
- LLM: gemini-2.0-flash

## Timeline

**[00:02] Others:** Hello, can you hear me properly?

**[00:05] You:** Yes, loud and clear.

**[00:15] Others:** Could you explain how you design high-throughput Kafka streaming pipelines with low latency?

**[00:45] You:** In my previous role at Uber, I led the migration to Kafka partitions, reducing latency by 45%.

> **Suggestion [01:20]** · question · 1st token in 0.8 s
> Question: "Tell me about a time you had to resolve a high-severity production outage?"
> Understood: "Resolved outage with metrics and rollback."

**[02:10] Outros:** Como você aborda a governança de microsserviços e segurança em arquitetura cloud?

**[02:40] Você:** Eu implementei autenticação mTLS e OAuth2 com gateway de API.
`;

  const extracted = jevEngine.extractQuestionsFromTranscript(mdSession);

  // Must extract the 3 substantive questions
  assert.equal(extracted.length, 3, 'Should extract exactly 3 substantive questions from .md transcript');

  const qTexts = extracted.map((q) => q.text);
  assert.ok(qTexts.some((t) => t.includes('Kafka streaming pipelines')), 'Kafka question should be extracted');
  assert.ok(qTexts.some((t) => t.includes('high-severity production outage')), 'Outage question should be extracted');
  assert.ok(qTexts.some((t) => t.includes('governança de microsserviços')), 'Portuguese microservices question should be extracted');

  // Candidate speech must NEVER be extracted as a question
  assert.ok(!qTexts.some((t) => t.includes('In my previous role')), 'Candidate statements must not be extracted');
  assert.ok(!qTexts.some((t) => t.includes('Eu implementei autenticação')), 'Candidate statements in PT must not be extracted');

  // Audio tests and greetings must be rejected
  assert.ok(!qTexts.some((t) => t.includes('can you hear me')), 'Filler audio tests must be rejected');
});

test('Real Questions System: JSONL (.jsonl) Session Extraction', () => {
  const jsonlSession = [
    JSON.stringify({ type: 'session_start', id: 'session-test-01', started_at: '2026-10-27T10:00:00Z' }),
    JSON.stringify({ type: 'turn', src: 'outros', text: 'Hey there. Can you see my screen?' }),
    JSON.stringify({ type: 'turn', src: 'voce', text: 'Yes, I see the code editor.' }),
    JSON.stringify({ type: 'suggestion', trigger: 'How would you handle database sharding and zero-downtime schema migrations?', reason: 'question' }),
    JSON.stringify({ type: 'turn', src: 'outros', text: 'What trade-offs do you consider when choosing between SQL and NoSQL for financial transactions?' }),
    JSON.stringify({ type: 'turn', src: 'voce', text: 'For financial ledgers, ACID compliance in PostgreSQL is critical, though we can use DynamoDB for read-heavy event logs.' })
  ].join('\n');

  const extracted = jevEngine.extractQuestionsFromTranscript(jsonlSession);

  assert.equal(extracted.length, 2, 'Should extract exactly 2 questions from JSONL triggers and interviewer turns');
  const qTexts = extracted.map((q) => q.text);
  assert.ok(qTexts.some((t) => t.includes('database sharding')), 'Database sharding question should be present');
  assert.ok(qTexts.some((t) => t.includes('SQL and NoSQL')), 'SQL vs NoSQL trade-offs question should be present');

  // Candidate turn must not be extracted
  assert.ok(!qTexts.some((t) => t.includes('financial ledgers')), 'Candidate response must not be extracted');
});

test('Real Questions System: Frontend Codebase is Free of Mock Strings', () => {
  const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  // The previous mock string was: transcript: 'Practice interview debrief transcript'
  assert.ok(
    !appJsContent.includes("'Practice interview debrief transcript'"),
    'app.js must not contain hardcoded mock debrief string'
  );
  assert.ok(
    !appJsContent.includes('"Practice interview debrief transcript"'),
    'app.js must not contain hardcoded mock debrief string (double quotes)'
  );

  // Verify that debrief click handler calls readSessionDetail to fetch actual session file
  assert.ok(
    appJsContent.includes('readSessionDetail'),
    'app.js must read session detail from disk'
  );
});

test('Real Questions System: Ingestion and Real Question Bank Persistence', async () => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_real_qb_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const transcript = `
Interviewer: Welcome Bruno. How would you design a distributed rate limiter that handles 100,000 requests per second?
Candidate: We can use Redis clusters with sliding-window log algorithms.
Interviewer: Tell me about a time you had a critical disagreement with a product manager over technical debt.
Candidate: In my previous startup, we balanced new features by dedicating 20% of each sprint to refactoring.
`;

    // Ingest into custom test directory
    const ingestion = await jevEngine.ingestSessionQuestions(tmpDir, transcript, 'Nubank');
    assert.equal(ingestion.ok, true);
    assert.equal(ingestion.questionsExtracted, 2);
    assert.ok(ingestion.added >= 1);

    // Read saved bank directly from disk
    const bankFile = path.join(tmpDir, 'question_bank.json');
    assert.ok(fs.existsSync(bankFile), 'question_bank.json must exist on disk');

    const bankContent = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
    const nubank = bankContent.companies.find((c) => c.name.toLowerCase().includes('nubank') || c.id === 'nubank');
    assert.ok(nubank, 'Nubank must be registered in the Question Bank');
    assert.ok(nubank.questions.length >= 2, 'Nubank must store the extracted questions');

    // Test unlocking mechanics on persisted bank
    const unlockRes = jevEngine.unlockCompany(tmpDir, nubank.id, true);
    assert.equal(unlockRes.ok, true);
    assert.equal(unlockRes.company.unlockedTop3, true);

    const reloadedBank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
    const reloadedNubank = reloadedBank.companies.find((c) => c.id === nubank.id);
    assert.equal(reloadedNubank.unlockedTop3, true);
    assert.equal(reloadedNubank.questions[0].locked, false, 'First question should now be unlocked');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Real Questions System: Validation and Categorization Accuracy', () => {
  // Brazilian Portuguese interview questions
  const ptQ1 = jevEngine.validateQuestionWithJev('Como você lidaria com um conflito técnico na arquitetura da sua equipe?');
  assert.equal(ptQ1.valid, true);
  const catPt1 = jevEngine.categorizeQuestionWithJev(ptQ1.cleaned);
  assert.equal(catPt1.category, 'Behavioral');

  const ptQ2 = jevEngine.validateQuestionWithJev('Como você implementaria um algoritmo de busca em árvore binária com baixa latência?');
  assert.equal(ptQ2.valid, true);
  const catPt2 = jevEngine.categorizeQuestionWithJev(ptQ2.cleaned);
  assert.equal(catPt2.category, 'Technical');
  assert.equal(catPt2.subCategory, 'Coding');

  // Conversational noise in PT rejected
  const ptNoise = jevEngine.validateQuestionWithJev('Consegue me ouvir agora?');
  assert.equal(ptNoise.valid, false);
});

test('Real Questions System: generateSessionDebrief reads real .md session and updates Goal Memory without mocks', async () => {
  // 1. Create a goal
  const goal = main.saveAgentToDisk({
    id: 'test-goal-stripe',
    name: 'Stripe Senior Backend',
    company: 'Stripe',
    role: 'Senior Backend Engineer',
    goal_memory: { strengths: [], improve: [] }
  });

  // 2. Create a genuine .md session file in the test sessions directory
  const sessionsDir = path.join(tmpEnv, 'RealTimeAI', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFileName = 'session-stripe-real-01.md';
  const sessionFullPath = path.join(sessionsDir, sessionFileName);
  const realSessionContent = `
# Session 2026-10-27 11:00
- Started: 2026-10-27T11:00:00-03:00
- Duration: 20:00
- Mode: live

## Timeline

**[00:10] Others:** Welcome Bruno. Tell me about a time you designed high-concurrency payment APIs?

**[00:40] You:** In my previous role, I designed the idempotent checkout service which handled 5,000 req/s with 99.99% availability.

**[01:30] Others:** How would you design a distributed ledger to guarantee strong consistency across regions?
`;
  fs.writeFileSync(sessionFullPath, realSessionContent, 'utf8');

  // 3. Generate debrief by passing sessionId (without passing any mock transcript!)
  const debriefRes = await main.generateSessionDebrief({
    goalId: goal.id,
    sessionId: 'session-stripe-real-01'
  });

  assert.equal(debriefRes.ok, true);
  assert.ok(debriefRes.debrief, 'Debrief object must be returned');
  assert.ok(debriefRes.debrief.questions.length >= 2, 'Debrief should extract the 2 questions from the .md file');
  assert.ok(debriefRes.debrief.questions.some((q) => q.includes('payment APIs')));
  assert.ok(debriefRes.debrief.questions.some((q) => q.includes('distributed ledger')));

  // Strengths and improvements must be derived from the real transcript
  const strengths = debriefRes.debrief.strengths;
  assert.ok(strengths.length > 0);
  assert.ok(
    strengths.some((s) => s.includes('metrics') || s.includes('quantitative') || s.includes('first-person')),
    'Real transcript metrics/STAR must be reflected in goal memory strengths'
  );

  // Saved goal must have debrief recorded
  assert.equal(debriefRes.goal.checklist_state.practice_run, true);
  assert.equal(debriefRes.goal.checklist_state.debrief_read, true);

  // Ingestion must have updated the Question Bank for Stripe
  const bankFile = path.join(tmpEnv, 'RealTimeAI', 'question_bank.json');
  assert.ok(fs.existsSync(bankFile), 'question_bank.json should be created/updated');
  const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
  const stripe = bank.companies.find((c) => c.name.toLowerCase() === 'stripe');
  assert.ok(stripe, 'Stripe company must be in Question Bank');
  assert.ok(stripe.questions.length >= 2, 'Stripe questions should include extracted questions');
});
