const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const jevEngine = require('../src/main/jev_engine');

test('JEV Engine: Question Validation (Semantic Interview vs Filler)', () => {
  // Substantive interview questions must pass
  const q1 = jevEngine.validateQuestionWithJev('How would you design a distributed caching layer with low latency?');
  assert.equal(q1.valid, true);
  assert.equal(q1.cleaned.endsWith('?'), true);

  const q2 = jevEngine.validateQuestionWithJev('Tell me about a time you faced a difficult conflict in your team.');
  assert.equal(q2.valid, true);

  const q3 = jevEngine.validateQuestionWithJev('What trade-offs do you consider when choosing between SQL and NoSQL databases?');
  assert.equal(q3.valid, true);

  // Conversational filler, audio tests and greetings must be rejected
  const filler1 = jevEngine.validateQuestionWithJev('Hey, can you hear me properly?');
  assert.equal(filler1.valid, false);
  assert.equal(filler1.reason, 'conversational_filler');

  const filler2 = jevEngine.validateQuestionWithJev('Sorry I was on mute, can you repeat?');
  assert.equal(filler2.valid, false);

  const filler3 = jevEngine.validateQuestionWithJev('Can you see my screen now?');
  assert.equal(filler3.valid, false);

  const filler4 = jevEngine.validateQuestionWithJev('How are you doing today?');
  assert.equal(filler4.valid, false);

  // Short noise must be rejected
  const short1 = jevEngine.validateQuestionWithJev('Okay, sure.');
  assert.equal(short1.valid, false);
  assert.equal(short1.reason, 'too_short');

  // Random statement without question signals
  const statement = jevEngine.validateQuestionWithJev('The weather in San Francisco is very sunny this afternoon.');
  assert.equal(statement.valid, false);
});

test('JEV Engine: Question Categorization (Technical, Behavioral, Domain)', () => {
  const codeCat = jevEngine.categorizeQuestionWithJev('What is the time complexity of balancing a binary tree in this algorithm?');
  assert.equal(codeCat.category, 'Technical');
  assert.equal(codeCat.subCategory, 'Coding');

  const sysCat = jevEngine.categorizeQuestionWithJev('How would you design a distributed message queue with high availability and sharding?');
  assert.equal(sysCat.category, 'Technical');
  assert.equal(sysCat.subCategory, 'System design');

  const behCat = jevEngine.categorizeQuestionWithJev('Tell me about a time you had a conflict with a stakeholder over a deadline.');
  assert.equal(behCat.category, 'Behavioral');
  assert.equal(behCat.subCategory, 'Leadership / STAR');

  const domCat = jevEngine.categorizeQuestionWithJev('How do you approach compliance and revenue impact in fintech platforms?');
  assert.equal(domCat.category, 'Domain knowledge');
});

test('JEV Engine: Anonymization and Transcript Extraction', () => {
  const rawText = 'Contact john.doe@example.com or call 555-123-4567 for https://secret-candidate.internal';
  const anon = jevEngine.anonymizeWithJev(rawText);
  assert.ok(!anon.includes('john.doe@example.com'));
  assert.ok(!anon.includes('555-123-4567'));
  assert.ok(anon.includes('[email]'));
  assert.ok(anon.includes('[phone]'));
  assert.ok(anon.includes('[link]'));

  const transcript = `
Interviewer: Hello, can you hear me?
Candidate: Yes, I can hear you fine.
Interviewer: Great. How would you design a distributed cache using Redis and microservices?
Candidate: I would start by setting up cache replication and LRU eviction policy.
Interviewer: Tell me about a time you made a mistake in production and how you handled it.
Candidate: In my previous job, I deployed a schema migration that locked a table.
Interviewer: Can you see my screen?
Candidate: Yes, perfect.
`;

  const extracted = jevEngine.extractQuestionsFromTranscript(transcript);
  assert.equal(extracted.length, 2);
  assert.ok(extracted.some((q) => q.text.includes('distributed cache')));
  assert.ok(extracted.some((q) => q.text.includes('mistake in production')));
  // Should not contain audio tests
  assert.ok(!extracted.some((q) => q.text.includes('can you hear me')));
  assert.ok(!extracted.some((q) => q.text.includes('see my screen')));
});

test('JEV Engine: Ingestion and Unlock Mechanics', async () => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_qb_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const transcript = `
Interviewer: Describe how you implement rate limiting across distributed microservices.
Candidate: We can use token bucket or leaky bucket algorithms with Redis.
Interviewer: What is your approach to handling disagreement with a technical lead?
`;
    const res = await jevEngine.ingestSessionQuestions(tmpDir, transcript, 'Google');
    assert.equal(res.ok, true);
    assert.equal(res.questionsExtracted, 2);

    const bank = jevEngine.loadQuestionBank(tmpDir);
    const google = bank.companies.find((c) => c.id === 'google');
    assert.ok(google, 'Google company created in Question Bank');
    assert.equal(google.questions.length, 2);
    assert.equal(google.questions[0].locked, true);

    // Unlock top 3 preview
    const unlockRes = jevEngine.unlockCompany(tmpDir, 'google', true);
    assert.equal(unlockRes.ok, true);
    assert.equal(unlockRes.company.unlockedTop3, true);
    assert.equal(unlockRes.company.questions[0].locked, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Question Bank UI: HTML Elements and Fidelity Presence', () => {
  const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Navigation sidebar item
  assert.ok(html.includes('Question Bank'));
  assert.ok(html.includes('navBadgeQuestionBank'));

  // Main Question Bank view (Image 1)
  assert.ok(html.includes('id="view-question-bank"'));
  assert.ok(html.includes('id="btnHowDataCollected"'));
  assert.ok(html.includes('id="inputSearchQuestionBank"'));
  assert.ok(html.includes('id="qbStatTotalCompanies"'));
  assert.ok(html.includes('id="qbStatTotalQuestions"'));
  assert.ok(html.includes('id="qbCompaniesGrid"'));

  // Company detail view (Images 2 & 3)
  assert.ok(html.includes('id="view-question-bank-company"'));
  assert.ok(html.includes('id="btnBackToQuestionBank"'));
  assert.ok(html.includes('id="qbCompanyName"'));
  assert.ok(html.includes('id="qbCompanyMonogram"'));
  assert.ok(html.includes('id="qbMetricInterviews"'));
  assert.ok(html.includes('id="qbMetricQuestions"'));
  assert.ok(html.includes('id="qbMetricLastReported"'));
  assert.ok(html.includes('id="qbTabAll"'));
  assert.ok(html.includes('id="qbTabTechnical"'));
  assert.ok(html.includes('id="qbTabDomain"'));
  assert.ok(html.includes('id="qbTabBehavioral"'));
  assert.ok(html.includes('id="qbSubCoding"'));
  assert.ok(html.includes('id="qbSubSystemDesign"'));
  assert.ok(html.includes('id="qbUnlockBanner"'));
  assert.ok(html.includes('id="btnQbUnlockTop3"'));
  assert.ok(html.includes('id="btnQbSubscribe"'));
  assert.ok(html.includes('id="qbQuestionsList"'));

  // Privacy modal & Settings toggle
  assert.ok(html.includes('id="modalHowDataCollected"'));
  assert.ok(html.includes('id="toggleModalShareQuestions"'));
  assert.ok(html.includes('id="cfgShareQuestions"'));
});

test('Question Bank Preload Bridge & IPC registration', () => {
  const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');

  assert.ok(preload.includes('getQuestionBank:'));
  assert.ok(preload.includes('getCompanyQuestions:'));
  assert.ok(preload.includes('unlockCompanyQuestions:'));
  assert.ok(preload.includes('setQuestionSharing:'));
  assert.ok(preload.includes('triggerJevAnalysis:'));
  assert.ok(preload.includes('detectCompany:'));
  assert.ok(preload.includes('fetchCompanyLogo:'));
  assert.ok(preload.includes('onQuestionBankUpdated:'));

  const mainPath = path.join(__dirname, '..', 'src', 'main', 'main.js');
  const main = fs.readFileSync(mainPath, 'utf8');

  assert.ok(main.includes("'rtai:get-question-bank'"));
  assert.ok(main.includes("'rtai:get-company-questions'"));
  assert.ok(main.includes("'rtai:unlock-company-questions'"));
  assert.ok(main.includes("'rtai:set-question-sharing'"));
  assert.ok(main.includes("'rtai:trigger-jev-analysis'"));
  assert.ok(main.includes("'rtai:detect-company'"));
  assert.ok(main.includes("'rtai:fetch-company-logo'"));
  assert.ok(main.includes("'rtai:question-bank-updated'"));
});

test('Company Detection from Transcript (Greetings & Entity Frequency)', () => {
  // 1. Explicit greeting patterns
  const t1 = `
Interviewer: Welcome to Deloitte! We are excited to speak with you today for this Senior Engineering role.
Interviewer: How would you design a distributed caching layer with low latency?
Candidate: I would use Redis clustering with LRU eviction.
`;
  const d1 = jevEngine.detectCompanyFromTranscript(t1);
  assert.equal(d1.id, 'deloitte');
  assert.equal(d1.name, 'Deloitte');
  assert.ok(d1.confidence >= 0.85);

  // 2. Portuguese greeting pattern
  const t2 = `
Entrevistador: Olá, seja bem-vindo ao Nubank! Estamos muito felizes de conversar com você hoje.
Entrevistador: Conte-me sobre uma vez que você teve que liderar um projeto sob alta pressão.
`;
  const d2 = jevEngine.detectCompanyFromTranscript(t2);
  assert.equal(d2.id, 'nubank');
  assert.equal(d2.name, 'Nubank');
  assert.equal(d2.domain, 'nubank.com.br');

  // 3. Conversational "here at..." pattern
  const t3 = `
Interviewer: Hi Bruno. Here at Accenture, we work with enterprise cloud migrations every day.
Interviewer: Can you explain how you migrate a monolithic database to Postgres with zero downtime?
`;
  const d3 = jevEngine.detectCompanyFromTranscript(t3);
  assert.equal(d3.id, 'accenture');
  assert.equal(d3.name, 'Accenture');

  // 4. Repeated mentions across lines
  const t4 = `
Interviewer: Thanks for joining this Infosys technical round.
Candidate: Thank you, glad to be here at Infosys.
Interviewer: What is the time complexity of balancing an AVL tree?
`;
  const d4 = jevEngine.detectCompanyFromTranscript(t4);
  assert.equal(d4.id, 'infosys');
  assert.equal(d4.name, 'Infosys');

  // 5. Fallback when no company mentioned
  const t5 = `
Interviewer: Let's start with a general algorithmic problem.
Interviewer: How do you reverse a singly linked list in place?
`;
  const d5 = jevEngine.detectCompanyFromTranscript(t5, 'Acme Corp');
  assert.equal(d5.name, 'Acme Corp');
  assert.equal(d5.domain, 'acme.com');
});

test('Company Logo Service & Curated Enterprise SVGs', async () => {
  const { deriveDomainFromCompanyName, resolveAndCacheCompanyLogo } = require('../src/main/company_logo_service');
  const { getCompanySvgLogo, generateDynamicCompanySvg } = require('../src/main/company_logos');

  // Domain derivation
  assert.equal(deriveDomainFromCompanyName('Tata Consultancy Services'), 'tcs.com');
  assert.equal(deriveDomainFromCompanyName('tcs'), 'tcs.com');
  assert.equal(deriveDomainFromCompanyName('Deloitte'), 'deloitte.com');
  assert.equal(deriveDomainFromCompanyName('Nubank'), 'nubank.com.br');
  assert.equal(deriveDomainFromCompanyName('EPAM Systems'), 'epam.com');
  assert.equal(deriveDomainFromCompanyName('Ernst & Young'), 'ey.com');
  assert.equal(deriveDomainFromCompanyName('Custom Startup Inc.'), 'customstartup.com');

  // Curated SVGs for Image 1 enterprise companies
  const tcsSvg = getCompanySvgLogo('tcs');
  assert.ok(tcsSvg && tcsSvg.includes('<svg'));

  const accentureSvg = getCompanySvgLogo('accenture');
  assert.ok(accentureSvg && accentureSvg.includes('<svg'));

  const deloitteSvg = getCompanySvgLogo('deloitte');
  assert.ok(deloitteSvg && deloitteSvg.includes('<svg'));

  const nubankSvg = getCompanySvgLogo('nubank');
  assert.ok(nubankSvg && nubankSvg.includes('<svg'));

  // Dynamic SVG generation fallback
  const dynamicSvg = generateDynamicCompanySvg('Stripe Payments');
  assert.ok(dynamicSvg.includes('<svg'));
  assert.ok(dynamicSvg.includes('SP'));

  // Resolve and cache test with temporary dir
  const tmpDir = path.join(__dirname, '..', '.tmp_test_logos_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const res = await resolveAndCacheCompanyLogo(tmpDir, 'Deloitte');
    assert.equal(res.companyId, 'deloitte');
    assert.equal(res.domain, 'deloitte.com');
    assert.equal(res.source, 'curated_vector');
    assert.ok(res.logoUrl.startsWith('data:image/svg+xml;utf8,'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('End-to-End: Transcript Ingestion Automatically Detects Company & Resolves Logo', async () => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_e2e_jev_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Transcript with company greeting and 2 substantive technical questions
    const transcript = `
Interviewer: Welcome to Capgemini! We are excited to meet you today.
Candidate: Thank you, very excited for this interview with Capgemini.
Interviewer: How would you implement eventual consistency across microservices with Kafka?
Candidate: We can use the Saga pattern with compensating transactions.
Interviewer: Describe a situation where you had to debug a memory leak in a Node.js production service.
`;

    // Note: Do not pass fallback company name - let JEV detect Capgemini automatically!
    const ingestRes = await jevEngine.ingestSessionQuestions(tmpDir, transcript);
    assert.equal(ingestRes.ok, true);
    assert.equal(ingestRes.detectedCompany.id, 'capgemini');
    assert.equal(ingestRes.company, 'Capgemini');
    assert.equal(ingestRes.domain, 'capgemini.com');
    assert.ok(ingestRes.logo && ingestRes.logo.startsWith('data:image/'));
    assert.equal(ingestRes.questionsExtracted, 2);

    // Verify Question Bank storage
    const bank = jevEngine.loadQuestionBank(tmpDir);
    const cap = bank.companies.find((c) => c.id === 'capgemini');
    assert.ok(cap, 'Capgemini company saved in bank');
    assert.equal(cap.domain, 'capgemini.com');
    assert.ok(cap.logo && cap.logo.startsWith('data:image/'));
    assert.ok(cap.questions.length >= 2);
    assert.equal(cap.questions[0].locked, true);

    // Unlock top 3 questions
    const unlockRes = jevEngine.unlockCompany(tmpDir, 'capgemini', true);
    assert.equal(unlockRes.ok, true);
    assert.equal(unlockRes.company.unlockedTop3, true);
    assert.equal(unlockRes.company.questions[0].locked, false);
    assert.equal(unlockRes.company.questions[1].locked, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
