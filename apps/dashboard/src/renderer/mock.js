// Mock interview page (#/mock). Basic is text-only with Orby; Advanced adds
// voice and consented camera snapshots for visual feedback.
(function mockPage() {
  const C = window.Cue;
  const S = C.state;
  const { esc, icon } = C;
  const api = window.rtai || {};

  // Same catalog as main/plans.js and the server.
  const MOCK_PACKS = [
    { id: 'mock_basic_1', interviews: 1, price: 2.99 },
    { id: 'mock_basic_3', interviews: 3, price: 7.99 },
    { id: 'mock_advanced_1', interviews: 1, price: 7.99 },
    { id: 'mock_advanced_3', interviews: 3, price: 20.99 }
  ];
  // Same list as main/mock_interview.js. Names stay in their own language.
  const LANGUAGES = [['pt-BR', 'Português (Brasil)'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['ja', '日本語'], ['hi', 'हिन्दी'], ['zh', '中文']];
  // How much quiet ends an answer: less after a finished sentence, and more while
  // words are still arriving, which the next message replaces anyway.
  const SILENCE_MID_SPEECH_MS = 1500;
  const SILENCE_AFTER_SENTENCE_MS = 900;
  const SILENCE_AFTER_PAUSE_MS = 1300;
  const silenceFor = (isFinal, text) => {
    if (!isFinal) return SILENCE_MID_SPEECH_MS;
    return /[.!?…。！？।]$/.test(text) ? SILENCE_AFTER_SENTENCE_MS : SILENCE_AFTER_PAUSE_MS;
  };

  const M = { phase: 'idle', agentId: '', lang: '', mode: 'basic', modeTouched: false, consent: false, cameraStream: null, cameraTimer: null, cameraBusy: false, visualCount: 0, previousFrame: '', cameraJob: null, lines: [], partial: '', state: '', error: '', record: null, history: null, endsAt: 0, id: '' };
  S.mock = M;
  let ws = null;
  let audio = null; // { ctx, stream, node }
  let timer = null;
  let silence = null;
  let keepAlive = null;
  let answer = '';
  let queue = Promise.resolve();
  let pending = 0;
  let turnOpen = false;
  let finishing = false;
  let player = null;
  let sttRetries = 0;

  const entitlement = () => (S.auth && S.auth.entitlement) || null;
  const canRun = () => Boolean(entitlement() && entitlement().canMock);
  const canRunMode = (mode) => {
    const e = entitlement();
    if (!e) return false;
    return mode === 'basic'
      ? e.mockBasicCredits > 0
      : e.mocksLeft + e.mockAdvancedCredits > 0;
  };

  function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const buyCards = () => `<div class="option-cards mock-buy-grid">${MOCK_PACKS.map((p) => `
      <div class="option-card"><span class="t">${p.id.includes('basic') ? 'Basic · Orby chat' : 'Advanced · camera + voice'}</span>
        <span class="s">${p.interviews === 1 ? '1 interview' : `${p.interviews} interviews`}</span>
        <span class="metric">US$${p.price.toFixed(2)}</span>
        <span class="s">No subscription. Credits never expire.</span>
        <button type="button" class="btn sm" style="margin-top:10px" data-action="mock-buy" data-pack="${p.id}">Buy</button>
      </div>`).join('')}</div>`;
  C.mockBuyCards = buyCards;

  // Ad used on the Home page for accounts without access.
  C.mockAd = function mockAd() {
    if (canRun() && !C.localMode()) return '';
    return `<div class="banner pro-ad">${icon('microphone')}<span class="grow"><span class="strong">Practice with Orby.</span> <span class="muted">Choose a Basic text chat or Advanced voice with camera feedback.</span></span><a class="btn sm primary" href="#/mock">See how it works</a></div>`;
  };

  function adView() {
    const local = C.localMode();
    const cta = local
      ? '<button type="button" class="btn primary" data-action="go-pro">Create an account</button>'
      : '<button type="button" class="btn primary" data-action="cloud-billing" data-kind="checkout">Upgrade to PRO</button>';
    return `${C.head('Mock interview', 'Chat with Orby in Basic, or choose Advanced for voice and camera image analysis.')}
      <section class="card pro-ad-card" style="gap:14px" data-tour="mock-ad">
        <div class="row" style="gap:10px">${icon('sparkle')}<span class="strong grow">Rehearse before the real one</span><span class="pill">PRO</span></div>
        <video src="media/mock-how-it-works.webm" controls preload="metadata" style="width:100%;border-radius:10px"></video>
        <ul class="pro-perks">
          <li class="pro-perk">${icon('chat')}<span class="stack" style="gap:0"><span class="t">Basic or Advanced</span><span class="s">Chat with Orby by text, or add voice and camera feedback in Advanced.</span></span></li>
          <li class="pro-perk">${icon('folder')}<span class="stack" style="gap:0"><span class="t">Based on your application</span><span class="s">It uses the job description, your résumé and your uploaded files.</span></span></li>
          <li class="pro-perk">${icon('chart')}<span class="stack" style="gap:0"><span class="t">Feedback at the end</span><span class="s">A score, strengths, weak points and how to improve.</span></span></li>
        </ul>
        <div class="row" style="gap:8px"><span class="small faint grow">PRO includes 1 Advanced mock interview per month.</span>${cta}</div>
      </section>
      <section class="card" style="gap:12px"><span class="strong">No subscription? Buy interviews</span>
        ${local ? '<span class="small muted">You need a free account to buy and use interviews.</span>' : buyCards()}
      </section>`;
  }

  // The animated interviewer: its motion says who has the floor.
  const orb = (state, large) => `<div class="mock-orb ${large ? 'lg' : ''} ${state || ''}" role="img" aria-label="Orby"><span class="core"></span>${[1, 2, 3, 4, 5].map((n) => `<i style="--n:${n}"></i>`).join('')}</div>`;

  function readiness(a) {
    const docs = (a && a.documents) || [];
    const prep = (M.prep && M.prep[a && a.id]) || null;
    const items = [
      { ok: Boolean(a && a.job_description), t: 'Job description', s: 'Questions follow what the job asks for.' },
      { ok: docs.some((d) => /resume|\bcv\b|curric/i.test(`${d.tag || ''} ${d.title || ''}`)), t: 'Résumé', s: 'It digs into your own experience.' },
      { ok: docs.length > 0, t: 'Your files', s: 'Projects and notes feed the conversation.' },
      { ok: Boolean(prep && prep.total), t: 'Question bank', s: prep && prep.total ? `${prep.total} real questions from this company` : 'No questions from this company yet.' }
    ];
    return { items, done: items.filter((i) => i.ok).length, prep };
  }

  function setupView() {
    const ent = entitlement();
    if (!M.modeTouched && !canRunMode(M.mode) && canRunMode(M.mode === 'basic' ? 'advanced' : 'basic')) {
      M.mode = M.mode === 'basic' ? 'advanced' : 'basic';
    }
    const agents = S.agents.filter((x) => !x.archived);
    if (!M.agentId || !agents.some((x) => x.id === M.agentId)) M.agentId = (agents[0] && agents[0].id) || '';
    const a = agents.find((x) => x.id === M.agentId);
    const lang = M.lang || (String((window.CueI18n && window.CueI18n.locale) || '').toLowerCase().startsWith('pt') ? 'pt-BR' : 'en');
    M.lang = lang;
    const left = [
      ent.mocksLeft > 0 ? `${ent.mocksLeft} Advanced included this month` : '',
      ent.mockBasicCredits > 0 ? `${ent.mockBasicCredits} Basic credits` : '',
      ent.mockAdvancedCredits > 0 ? `${ent.mockAdvancedCredits} Advanced credits` : ''
    ].filter(Boolean).join(' · ');
    if (!agents.length) {
      return `${C.head('Mock interview', 'Chat with Orby in Basic, or choose Advanced for voice and camera image analysis.')}
        <div class="empty boxed">${icon('stack')}<span class="t">Create a session first</span><span>The interview is based on the job and files of a session.</span><a class="btn sm primary" href="#/sessions">Go to sessions</a></div>`;
    }
    const { items, done, prep } = readiness(a);
    const steps = M.mode === 'basic'
      ? [['chat', 'Chat with Orby', 'Text only, without a camera or microphone; lower AI usage.'], ['chart', 'See your score', 'JEV scores each answer against the job.'], ['sparkle', 'Train with the copilot', 'Ask what to improve and practice again.']]
      : [['camera', 'Talk with Orby', 'Voice interview with your camera enabled for visual feedback.'], ['eye', 'Get visual feedback', 'Framing, eye direction, posture, clothing, background organization and visible movement.'], ['chart', 'Review everything', 'Speech score plus camera coaching at the end.']];
    const canStartMode = canRunMode(M.mode);
    return `<section class="mock-hero" data-tour="mock-setup">
        ${orb('idle', true)}
        <div class="stack grow" style="gap:6px;min-width:0">
          <span class="eyebrow">Rehearsal room</span>
          <h1 class="h1">Mock interview</h1>
          <span class="muted">Basic is a text chat with Orby. Advanced adds voice and camera image analysis.</span>
          ${left ? `<span class="row" style="margin-top:6px"><span class="pill">${esc(left)}</span></span>` : ''}
        </div>
      </section>
      <section class="mock-steps">${steps.map(([ic, t, d], i) => `<div class="mock-step"><span class="n num">${i + 1}</span><span class="stack" style="gap:2px"><span class="row" style="gap:6px">${icon(ic)}<span class="strong">${t}</span></span><span class="small muted">${d}</span></span></div>`).join('')}</section>
      <section class="mock-grid">
        <div class="card" style="gap:16px">
          <label class="field">Which job is this for?<select class="select" data-change="mock-agent" data-no-i18n>${agents.map((x) => `<option value="${esc(x.id)}" ${x.id === M.agentId ? 'selected' : ''}>${esc(`${C.agentCompany(x) || x.name || '—'} · ${x.role || '—'}`)}</option>`).join('')}</select></label>
          <div class="field"><span>Interview type</span>
            <div class="mock-mode-grid" role="radiogroup">
              <button type="button" role="radio" aria-checked="${M.mode === 'basic'}" class="mock-mode ${M.mode === 'basic' ? 'active' : ''}" data-action="mock-mode-set" data-mode="basic"><span class="strong">Basic · US$2.99</span><span class="small muted">Text chat with Orby. No camera or microphone. Lower AI usage.</span></button>
              <button type="button" role="radio" aria-checked="${M.mode === 'advanced'}" class="mock-mode ${M.mode === 'advanced' ? 'active' : ''}" data-action="mock-mode-set" data-mode="advanced"><span class="strong">Advanced · US$7.99</span><span class="small muted">Voice with Orby plus consented camera analysis and visual feedback.</span></button>
            </div>
            ${!canStartMode ? `<span class="small muted">${M.mode === 'basic' ? 'You need a Basic credit for this mode.' : 'You need an Advanced credit or the monthly PRO interview.'}</span>` : ''}
          </div>
          <div class="field"><span>Interview language</span>
            <div class="mock-langs" role="radiogroup" data-no-i18n>${LANGUAGES.map(([code, name]) => `<button type="button" role="radio" aria-checked="${code === lang}" class="mock-lang ${code === lang ? 'active' : ''}" data-action="mock-lang-set" data-lang="${code}">${name}</button>`).join('')}</div>
            <span class="small muted">The interviewer speaks, listens and gives feedback in this language.</span>
          </div>
          ${M.mode === 'advanced' ? `<div class="stack" style="gap:8px"><div class="row" style="gap:8px"><button type="button" class="btn sm" data-action="mock-mic-test">${icon('microphone')}Test microphone</button><div class="mock-meter grow"><span id="mockMeter"></span></div></div>
            <span class="small muted" id="mockMicNote">Speak after clicking: the bar should move.</span></div>
          <label class="mock-consent"><input type="checkbox" data-change="mock-consent" ${M.consent ? 'checked' : ''}/><span>I agree to send occasional camera snapshots to AI for visual coaching.</span></label>
          <span class="small muted">About once a minute, a camera still is sent to AI; when available, it is compared with the previous still for framing, eye direction, posture, clothing, background organization and visible movement. The app does not record video or save camera images.</span>` : ''}
          ${M.error ? `<div class="banner warn" role="alert">${icon('alert')}<span class="grow">${esc(M.error)}</span></div>` : ''}
          <button type="button" class="btn primary lg mock-start" data-action="mock-start" ${!canStartMode || (M.mode === 'advanced' && !M.consent) ? 'disabled' : ''}>${icon(M.mode === 'basic' ? 'chat' : 'camera')}Start ${M.mode === 'basic' ? 'Basic' : 'Advanced'} interview</button>
          <span class="small faint" style="text-align:center">${M.mode === 'basic' ? '30 minutes of text chat. Your chosen mode uses one matching credit.' : 'Up to 30 minutes. Advanced uses one Advanced credit.'}</span>
          ${!canStartMode ? buyCards() : ''}
        </div>
        <div class="stack" style="gap:16px;min-width:0">
          <div class="card" style="gap:12px">
            <div class="row" style="gap:12px"><div class="mock-ring" style="--p:${done * 25}"><span class="num">${done}/${items.length}</span></div><span class="stack" style="gap:2px"><span class="strong">How ready is this rehearsal?</span><span class="small muted">The more it knows, the closer to the real one.</span></span></div>
            ${items.map((i) => `<div class="mock-check ${i.ok ? 'ok' : ''}">${icon(i.ok ? 'check-circle' : 'alert')}<span class="stack" style="gap:0"><span>${i.t}</span><span class="small muted">${i.s}</span></span></div>`).join('')}
            ${a && done < items.length && items.slice(0, 3).some((i) => !i.ok) ? `<a class="btn sm" href="#/session/${esc(a.id)}">Complete this session</a>` : ''}
          </div>
          <div class="card" style="gap:10px" data-tour="mock-bank">
            <div class="row" style="gap:8px">${icon('question')}<span class="strong grow">Questions that may come up</span>${prep && prep.total ? '<span class="pill">Question bank</span>' : ''}</div>
            ${prep && prep.total ? `<span class="small muted">Asked in real interviews at this company. The interviewer prioritizes them, so you train on what may come up.</span>
              ${prep.questions.map((q) => `<div class="mock-q"><span data-no-i18n>${esc(q.text)}</span>${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}</div>`).join('')}`
              : '<span class="small muted">No questions from this company in the bank yet. The interview will use the job and your files.</span>'}
          </div>
        </div>
      </section>
      ${historyView()}`;
  }

  function historyView() {
    const list = M.history || [];
    if (!list.length) return '';
    return `<section class="card" style="gap:10px"><span class="strong">Past interviews</span>${list.map((r) => `
      <button type="button" class="row btn ghost" style="gap:8px;justify-content:flex-start" data-action="mock-open" data-id="${esc(r.id)}"><span class="grow" style="text-align:left" data-no-i18n>${esc(r.company || '—')} · ${esc(r.role || '—')}</span>${r.evaluation && r.evaluation.score != null ? `<span class="pill num">${r.evaluation.score}</span>` : ''}<span class="small faint">${esc(new Date(r.startedAt).toLocaleDateString())}</span></button>`).join('')}</section>`;
  }

  const STATE_LABEL = { speaking: 'Orby is speaking', thinking: 'Orby is thinking', listening: 'Your turn: answer out loud', typing: 'Your turn: type your answer', connecting: 'Connecting' };

  function linesHtml() {
    // One turn arrives sentence by sentence: same speaker, same block.
    const turns = M.lines.reduce((out, l) => {
      const last = out[out.length - 1];
      if (last && last.who === l.who) last.text += ` ${l.text}`;
      else out.push({ ...l });
      return out;
    }, []);
    const rows = turns.map((l) => `<div class="stack" style="gap:2px"><span class="small faint">${l.who === 'me' ? 'You' : 'Orby'}</span><span data-no-i18n>${esc(l.text)}</span></div>`);
    if (M.partial) rows.push(`<div class="stack" style="gap:2px;opacity:.65"><span class="small faint">You</span><span data-no-i18n>${esc(M.partial)}</span></div>`);
    return rows.join('');
  }

  function liveView() {
    return `${C.head('Mock interview', '', `<span class="pill"><span class="num" id="mockClock">${clock((M.endsAt - Date.now()) / 1000)}</span></span>`)}
      <section class="mock-stage" id="mockStage">
        <div class="mock-live-stage">${orb(M.state, true)}<span class="small muted">Orby</span>${M.mode === 'advanced' ? `<div class="mock-camera"><video id="mockCameraPreview" autoplay muted playsinline></video><span class="small faint">Your camera · snapshots analyzed about once a minute</span><span class="small muted" id="mockVisionStatus">Camera analysis is on. The app does not save the images.</span></div>` : ''}</div>
        <span class="strong" id="mockState">${esc(STATE_LABEL[M.state] || '')}</span>
      </section>
      <section class="card" style="gap:12px">
        <div id="mockLines" class="stack" style="gap:10px;max-height:46vh;overflow:auto">${linesHtml()}</div>
        <div class="row" style="gap:8px"><input class="input grow" id="mockTyped" placeholder="${M.mode === 'basic' ? 'Type your answer' : 'Or type your answer'}"/><button type="button" class="btn" data-action="mock-send">Send answer</button><button type="button" class="btn danger" data-action="mock-finish" ${M.id ? '' : 'disabled'}>End interview</button></div>
        ${M.error ? `<div class="small" role="alert" style="color:var(--danger)">${esc(M.error)}</div>` : ''}
      </section>`;
  }

  const JEV_LABELS = [['adequacao', 'Relevance'], ['cultura', 'Culture'], ['estrutura', 'Structure'], ['evidencias', 'Evidence'], ['objetividade', 'Objectivity']];

  function evaluationHtml(r) {
    const J = r.evaluation;
    if (!J) return r.feedback ? `<section class="card"><pre class="md" style="white-space:pre-wrap">${esc(r.feedback)}</pre></section>` : '<section class="card"><div class="muted">Feedback is unavailable right now. Your transcript was saved.</div></section>';
    const list = (title, ic, rows) => `<div class="card tight"><div class="row">${icon(ic)}<span class="strong">${title}</span></div>${rows.map((x) => `<div class="small" data-no-i18n>${esc(x)}</div>`).join('') || '<div class="muted">—</div>'}</div>`;
    return `<section class="card" style="gap:12px">
        <div class="row" style="gap:12px"><span class="metric num">${J.score == null ? '—' : J.score}</span><span class="grow muted" data-no-i18n>${esc(J.resumo || '')}</span><span class="pill">JEV</span></div>
        <div class="option-cards" style="grid-template-columns:repeat(5,minmax(0,1fr))">${JEV_LABELS.map(([k, label]) => `<div class="option-card"><span class="s">${label}</span><span class="t num">${J.criteria && J.criteria[k] != null ? J.criteria[k] : '—'}</span></div>`).join('')}</div>
      </section>
      <section class="grid-2">${list('Strengths', 'check-circle', J.fortes || [])}${list('To improve', 'arrow-up-right', J.melhorar || [])}</section>
      <section class="card" style="gap:12px"><span class="strong">Question by question</span>${(J.items || []).map((it) => `<div class="stack" style="gap:3px"><div class="row" style="gap:8px"><span class="grow strong" data-no-i18n>${esc(it.pergunta)}</span><span class="pill num">${it.score == null ? '—' : it.score}</span></div><span class="small muted" data-no-i18n>${esc(it.veredito)}</span><span class="small" data-no-i18n>${esc(it.dica)}</span></div>`).join('')}</section>`;
  }

  function visualFeedbackHtml(r) {
    const notes = r.visualFeedback || [];
    if (!notes.length) return '';
    return `<section class="card" style="gap:10px"><div class="row">${icon('camera')}<span class="strong">Camera feedback</span></div><span class="small muted">Based on snapshots from your Advanced interview. The camera images were not saved.</span>${notes.map((n) => `<div class="small" data-no-i18n>${esc(n.text || n)}</div>`).join('')}</section>`;
  }

  function coachHtml(r) {
    return `<section class="card" style="gap:12px" data-tour="mock-coach">
        <div class="row" style="gap:8px">${icon('sparkle')}<span class="strong">Interview copilot</span></div>
        <span class="small muted">Ask what you could improve. It answers from this transcript and the JEV evaluation.</span>
        ${(r.coach || []).map((c) => `<div class="stack" style="gap:4px"><span class="small faint">You</span><span data-no-i18n>${esc(c.q)}</span><span class="small faint">Copilot</span><span data-no-i18n style="white-space:pre-wrap">${esc(c.a)}</span></div>`).join('')}
        ${M.coachBusy ? '<div class="small muted">Thinking…</div>' : ''}
        <div class="row" style="gap:8px"><input class="input grow" id="mockCoachInput" placeholder="How could I answer the weakest question better?"/><button type="button" class="btn primary" data-action="mock-coach" ${M.coachBusy ? 'disabled' : ''}>Ask</button></div>
      </section>`;
  }

  function transcriptHtml(r) {
    return `<section class="card" style="gap:10px"><span class="strong">Transcript</span>${(r.messages || []).map((m) => `<div class="stack" style="gap:2px"><span class="small faint">${m.role === 'user' ? 'You' : 'Orby'}</span><span data-no-i18n>${esc(m.content)}</span></div>`).join('')}</section>`;
  }

  function doneView() {
    const r = M.record;
    return `${C.head('Interview feedback', r ? `${r.company || '—'} · ${r.role || '—'}` : '')}
      ${M.phase === 'finishing' ? `<section class="card"><div class="row" style="gap:8px">${icon('sparkle')}<span>Writing your feedback…</span></div></section>` : ''}
      ${r ? evaluationHtml(r) + visualFeedbackHtml(r) + coachHtml(r) + transcriptHtml(r) : ''}
      ${M.phase === 'done' && !r ? `<section class="card"><div class="muted">${esc(M.refunded ? 'The interview ended before any answer and was not counted.' : 'The interview ended before any answer.')}</div></section>` : ''}
      ${M.phase === 'done' ? '<div class="row"><button type="button" class="btn primary" data-action="mock-reset">Back</button></div>' : ''}`;
  }

  C.views.mock = function mock() {
    let body = setupView;
    if (M.phase === 'live') body = liveView;
    else if (M.phase === 'finishing' || M.phase === 'done') body = doneView;
    else if (C.localMode() || !canRun()) body = adView;
    return `<div class="page">${body()}</div>`;
  };
  C.afterRender.mock = function afterMock() {
    if (M.history === null && api.mockList) {
      M.history = [];
      api.mockList().then((list) => {
        M.history = list || [];
        if (M.history.length && S.route.view === 'mock' && M.phase === 'idle' ) C.renderView();
      });
    }
    const box = document.getElementById('mockLines');
    if (box) box.scrollTop = box.scrollHeight;
    const preview = document.getElementById('mockCameraPreview');
    if (preview && M.cameraStream && preview.srcObject !== M.cameraStream) preview.srcObject = M.cameraStream;
    if (M.agentId && api.mockPrep && !(M.prep && M.prep[M.agentId]) && M.phase === 'idle') {
      const id = M.agentId;
      M.prep = { ...(M.prep || {}), [id]: { total: 0, questions: [] } };
      api.mockPrep(id).then((prep) => {
        M.prep[id] = prep || { total: 0, questions: [] };
        if (prep && prep.total && S.route.view === 'mock' && M.phase === 'idle') C.renderView();
      });
    }
  };

  function paint() {
    const box = document.getElementById('mockLines');
    if (box) {
      box.innerHTML = linesHtml();
      box.scrollTop = box.scrollHeight;
    }
    const stageOrb = document.querySelector('#mockStage .mock-orb');
    if (stageOrb) stageOrb.className = `mock-orb lg ${M.state || ''}`;
    const st = document.getElementById('mockState');
    if (st) st.textContent = C.t ? C.t(STATE_LABEL[M.state] || '') : STATE_LABEL[M.state] || '';
  }
  function setState(s) {
    M.state = s;
    paint();
  }

  function stopCapture() {
    clearInterval(keepAlive);
    clearTimeout(silence);
    if (ws) {
      const w = ws;
      ws = null;
      try { w.close(); } catch (_e) { /* already closed */ }
    }
    if (audio) {
      try { audio.node.disconnect(); } catch (_e) { /* not connected */ }
      audio.stream.getTracks().forEach((t) => t.stop());
      audio.ctx.close().catch(() => {});
      audio = null;
    }
  }

  function stopCamera() {
    clearTimeout(M.cameraTimer);
    M.cameraTimer = null;
    if (M.cameraStream) M.cameraStream.getTracks().forEach((track) => track.stop());
    M.cameraStream = null;
  }

  async function captureCameraFrame() {
    if (M.phase !== 'live' || M.mode !== 'advanced' || !M.cameraStream || M.cameraBusy || M.visualCount >= 30) return;
    const video = document.getElementById('mockCameraPreview');
    if (!video || video.readyState < 2) {
      M.cameraTimer = setTimeout(captureCameraFrame, 5000);
      return;
    }
    M.cameraBusy = true;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 288;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.62);
    canvas.width = 0;
    canvas.height = 0;
    const status = document.getElementById('mockVisionStatus');
    if (status) status.textContent = 'Reviewing a camera snapshot…';
    M.cameraJob = api.mockAnalyze(image, M.previousFrame);
    M.previousFrame = image;
    try {
      const result = await M.cameraJob;
      if (result && result.ok) {
        M.visualCount += 1;
        if (status) status.textContent = C.t('Snapshot {n} reviewed. The app does not save the images.', { n: M.visualCount });
      } else if (status) {
        status.textContent = 'Camera feedback could not be generated. The interview can continue.';
      }
    } catch (_e) {
      if (status) status.textContent = 'Camera feedback could not be generated. The interview can continue.';
    } finally {
      M.cameraJob = null;
      M.cameraBusy = false;
      if (M.phase === 'live' && M.visualCount < 30) M.cameraTimer = setTimeout(captureCameraFrame, 60000);
    }
  }

  let mayResume = false;
  let lastAnswer = '';

  function connectStt(stt) {
    const q = new URLSearchParams({
      model: stt.model || 'nova-3', language: M.lang, encoding: 'linear16', sample_rate: '16000',
      channels: '1', interim_results: 'true', endpointing: '300', smart_format: 'true'
    });
    const { url } = stt;
    const socket = new WebSocket(`${url}?${q}`, ['bearer', stt.token]);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (e) => {
      if (M.state !== 'listening' && !mayResume) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (_e) { return; }
      const text = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0] && msg.channel.alternatives[0].transcript;
      if (!text) return;
      if (M.state === 'thinking') resumeAnswer();
      if (M.state !== 'listening') return;
      clearTimeout(silence);
      if (msg.is_final) {
        answer += (answer ? ' ' : '') + text;
        M.partial = answer;
      } else {
        M.partial = `${answer} ${text}`.trim();
      }
      paint();
      if (answer) silence = setTimeout(submitAnswer, silenceFor(msg.is_final, answer));
    };
    socket.onopen = () => { sttRetries = 0; };
    socket.onclose = async () => {
      if (ws !== socket || M.phase !== 'live') return;
      // Waits longer on each failure; typing still works meanwhile.
      sttRetries += 1;
      if (sttRetries > 6) {
        M.error = 'Microphone unavailable: you can type your answers.';
        C.renderView();
        return;
      }
      await new Promise((resolve) => { setTimeout(resolve, 1000 * 2 ** (sttRetries - 1)); });
      if (ws !== socket || M.phase !== 'live') return;
      const grant = await api.mockSttToken();
      if (grant && M.phase === 'live') connectStt({ ...grant, url });
    };
    ws = socket;
  }

  async function startCapture(stt) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== 1 || (M.state !== 'listening' && !mayResume)) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
      ws.send(pcm.buffer);
    };
    source.connect(node);
    node.connect(ctx.destination);
    audio = { ctx, stream, node };
    connectStt(stt);
    keepAlive = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 4000);
  }

  function maybeListen() {
    if (M.phase !== 'live' || turnOpen || pending > 0) return;
    if (finishing) {
      finish();
      return;
    }
    answer = '';
    M.partial = '';
    setState(M.mode === 'basic' ? 'typing' : 'listening');
  }

  // Sentences are requested as they arrive and played in order.
  function speakSentence(text) {
    if (M.mode === 'basic') {
      M.lines.push({ who: 'ai', text });
      paint();
      return;
    }
    mayResume = false;
    M.lines.push({ who: 'ai', text });
    pending += 1;
    const clip = api.mockSpeak(text);
    queue = queue.then(async () => {
      const bytes = await clip;
      if (M.phase !== 'live') return;
      setState('speaking');
      if (!bytes) return;
      if (M.phase !== 'live') return;
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      await new Promise((resolve) => {
        player = new Audio(blobUrl);
        player.onended = resolve;
        player.onerror = resolve;
        player.play().catch(resolve);
      });
      URL.revokeObjectURL(blobUrl);
    }).finally(() => {
      pending -= 1;
      maybeListen();
    });
    paint();
  }

  async function runTurn(text) {
    turnOpen = true;
    setState('thinking');
    const r = await api.mockTurn(text);
    turnOpen = false;
    mayResume = false;
    if (!r || !r.ok) {
      if (r && r.aborted) return;
      if (r && r.over) finishing = true;
      else {
        M.error = 'The interviewer did not answer. Try your answer again.';
        C.renderView();
      }
    } else if (r.finished) {
      finishing = true;
    }
    maybeListen();
  }

  // Still talking after a pause: back to the same answer, before the interviewer
  // has said anything.
  function resumeAnswer() {
    mayResume = false;
    answer = lastAnswer;
    M.lines.pop();
    api.mockCancelTurn();
    setState('listening');
  }

  function submitAnswer(typed) {
    clearTimeout(silence);
    const text = String(typed || answer).trim();
    if (!text || M.phase !== 'live' || (M.mode === 'basic' ? M.state !== 'typing' : M.state !== 'listening')) return;
    M.lines.push({ who: 'me', text });
    lastAnswer = text;
    mayResume = !typed;
    answer = '';
    M.partial = '';
    M.error = '';
    runTurn(text);
  }

  async function finish() {
    if (M.phase !== 'live') return;
    M.phase = 'finishing';
    clearInterval(timer);
    stopCapture();
    stopCamera();
    M.previousFrame = '';
    M.consent = false;
    if (player) player.pause();
    if (M.cameraJob) await M.cameraJob.catch(() => null);
    C.renderView();
    const r = await C.guard(() => api.mockEnd(), 'Could not end the interview.');
    M.record = (r && r.record) || null;
    M.refunded = Boolean(r && r.refunded);
    M.history = null;
    M.phase = 'done';
    if (C.authRefresh) await C.authRefresh(true);
    C.renderView();
  }

  C.actions['mock-start'] = async () => {
    if (M.phase !== 'idle') return;
    M.error = '';
    if (!M.agentId) return;
    if (M.mode === 'advanced' && !M.consent) {
      M.error = 'Agree to camera analysis before starting Advanced.';
      C.renderView();
      return;
    }
    let cameraStream = null;
    if (M.mode === 'advanced') {
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' }, audio: false });
      } catch (_e) {
        M.error = 'Camera unavailable. Allow camera access, or switch to Basic.';
        C.renderView();
        return;
      }
    }
    M.phase = 'live';
    M.cameraStream = cameraStream;
    M.visualCount = 0;
    M.lines = [];
    M.partial = '';
    M.record = null;
    M.id = '';
    finishing = false;
    M.state = 'connecting';
    C.renderView();
    const requestedMode = M.mode;
    const r = await C.guard(() => api.mockStart(M.agentId, M.lang, requestedMode), 'Could not start the interview.');
    if (!r || !r.ok) {
      stopCamera();
      M.phase = 'idle';
      M.error = (r && r.error) || 'Could not start the interview.';
      C.renderView();
      return;
    }
    if (r.mode === 'advanced' && requestedMode !== 'advanced') {
      M.phase = 'idle';
      M.mode = 'advanced';
      M.error = 'An active Advanced interview was found. Agree to camera analysis to resume it.';
      C.renderView();
      return;
    }
    M.id = r.id;
    M.mode = r.mode || M.mode;
    if (M.mode === 'basic') stopCamera();
    if (M.mode === 'advanced' && !M.cameraStream) {
      try {
        M.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' }, audio: false });
      } catch (_e) {
        M.phase = 'idle';
        M.error = 'This active Advanced interview needs camera access to continue.';
        C.renderView();
        return;
      }
    }
    M.endsAt = Date.now() + r.maxS * 1000;
    if (M.mode === 'advanced') {
      try {
        await startCapture(r.stt);
      } catch (_e) {
        M.error = 'Microphone unavailable: you can type your answers.';
      }
    }
    timer = setInterval(() => {
      const left = (M.endsAt - Date.now()) / 1000;
      const el = document.getElementById('mockClock');
      if (el) el.textContent = clock(left);
      if (left <= 0) finish();
    }, 500);
    C.renderView();
    if (M.mode === 'advanced') {
      M.cameraTimer = setTimeout(captureCameraFrame, 15000);
    }
    if (M.phase !== 'live') return;
    runTurn('');
  };
  C.actions['mock-finish'] = () => finish();
  C.actions['mock-send'] = () => {
    const input = document.getElementById('mockTyped');
    const text = input ? input.value : '';
    if (input && text.trim() && (M.state === 'listening' || M.state === 'typing')) input.value = '';
    submitAnswer(text);
  };
  C.actions['mock-reset'] = () => {
    M.phase = 'idle';
    M.record = null;
    M.consent = false;
    C.renderView();
  };
  C.actions['mock-open'] = (el) => {
    M.record = (M.history || []).find((r) => r.id === el.dataset.id) || null;
    if (M.record) {
      M.phase = 'done';
      C.renderView(true);
    }
  };
  C.actions['mock-coach'] = async () => {
    const input = document.getElementById('mockCoachInput');
    const question = input ? input.value.trim() : '';
    if (!question || !M.record || M.coachBusy) return;
    M.coachBusy = true;
    C.renderView();
    const res = await C.guard(() => api.mockCoach(M.record.id, question), 'The copilot could not answer. Try again.');
    M.coachBusy = false;
    if (res && res.ok) M.record = res.record;
    else if (res) C.toast('The copilot could not answer. Try again.', 'error');
    M.history = null;
    C.renderView();
  };
  C.actions['mock-buy'] = async (el) => {
    const res = await C.guard(() => api.cloudBilling('checkout', el.dataset.pack), 'Could not open the payment page.');
    if (res && res.ok) C.toast('Finish your purchase in the browser.');
    else if (res) C.toast(res.error || 'Could not open the payment page.', 'error');
  };
  C.changes['mock-agent'] = (el) => {
    M.agentId = el.value;
    C.renderView();
  };
  C.actions['mock-lang-set'] = (el) => {
    M.lang = el.dataset.lang;
    C.renderView();
  };
  C.actions['mock-mode-set'] = (el) => {
    M.mode = el.dataset.mode === 'advanced' ? 'advanced' : 'basic';
    M.modeTouched = true;
    M.error = '';
    M.consent = false;
    C.renderView();
  };
  C.changes['mock-consent'] = (el) => {
    M.consent = Boolean(el.checked);
    C.renderView();
  };
  // A few seconds of the microphone's level, before spending an interview.
  C.actions['mock-mic-test'] = async () => {
    // Looked up on each use: the page may render again while this runs.
    const note = (text) => {
      const el = document.getElementById('mockMicNote');
      if (el) el.textContent = C.t(text);
    };
    const bar = (width) => {
      const el = document.getElementById('mockMeter');
      if (el) el.style.width = width;
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const until = Date.now() + 6000;
      let peak = 0;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        const level = data.reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0) / 128;
        peak = Math.max(peak, level);
        bar(`${Math.min(100, level * 180)}%`);
        if (Date.now() < until) return;
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        bar('0');
        note(peak > 0.08 ? 'Microphone working.' : 'We could not hear you. Check the microphone in Windows.');
      }, 60);
    } catch (_e) {
      note('Microphone unavailable: you can type your answers.');
    }
  };

  if (api.onMockEvent) {
    api.onMockEvent((ev) => {
      if (ev && ev.type === 'sentence' && M.phase === 'live') speakSentence(ev.text);
    });
  }
})();
