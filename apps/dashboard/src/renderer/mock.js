// Mock interview page (#/mock). Basic is text-only with Orby; Advanced adds
// voice and consented camera snapshots for visual feedback.
(function mockPage() {
  const C = window.Cue;
  const S = C.state;
  const { esc, icon } = C;
  const api = window.rtai || {};

  // Same list as main/mock_interview.js. Names stay in their own language.
  const LANGUAGES = [['pt-BR', 'Português (Brasil)'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['ja', '日本語'], ['hi', 'हिन्दी'], ['zh', '中文']];
  const PERSONAS = [['recruiter', 'Recruiter / HR'], ['manager', 'Hiring manager'], ['global', 'Global Talent Lead'], ['technical', 'Technical lead']];
  // Interview formats and levels of main/mock_prompt.js (KINDS, LEVELS).
  const KINDS = [['behavioral', 'Behavioral'], ['screen', 'Recruiter screen'], ['deepdive', 'Project deep dive'], ['crossfunctional', 'Cross-functional partner'], ['leadership', 'Leadership'], ['ai', 'Using AI at work']];
  const KIND_HINTS = {
    behavioral: 'Tell me about yourself, your most impactful project, a conflict and other signal areas, answered as real stories.',
    screen: 'Short and direct: how your background fits the job, the level and your motivation.',
    deepdive: 'One project from start to finish: decisions, alternatives, people and results.',
    crossfunctional: 'A product, design or business partner: plain language, empathy and trade-offs.',
    leadership: 'Driving impact through people, values questions and tougher follow-ups.',
    ai: 'What you deliver with AI, how you verify it, how your use improves and how you share it.'
  };
  const LEVELS = [['auto', 'Match the role'], ['entry', 'Entry level or internship'], ['mid', 'Mid level'], ['senior', 'Senior'], ['staff', 'Staff or lead']];
  const TOPICS = {
    trajectory: 'Tell me about yourself', project: 'Most impactful project', conflict: 'A conflict', signal: 'Another signal area',
    culture: 'Culture and values', academics: 'University and graduation', availability: 'Internship availability', motivation: 'Interest in the opportunity', skills: 'Technical deep dive',
    collaboration: 'Working with other areas', explain: 'Explaining without jargon', people: 'People and influence', values: 'Leadership principles',
    dd_overview: 'The project and its result', dd_decisions: 'Decisions and alternatives', dd_people: 'People and alignment', dd_outcome: 'Measuring and looking back',
    ai_work: 'What you build with AI', ai_trust: 'Verifying AI output', ai_iteration: 'Improving how you use AI', ai_growth: 'Keeping up with AI', ai_scaling: 'Spreading AI practices', ai_values: 'Your view on AI',
    questions: 'Your questions'
  };
  const COVERAGE = { answered: 'Answered', offered: 'Time offered', skipped: 'Skipped', unanswered: 'Unanswered' };
  const defaultGoal = 'Connect your background and motivation to the role with real examples.';
  const personaLabel = (persona) => C.t(PERSONAS.find(([id]) => id === persona)?.[1] || '');
  const skipLabel = (topic) => C.t(topic === 'questions' ? 'I have no more questions' : 'Skip');
  const topicLabel = (topic) => C.t(TOPICS[topic] || '');
  const defaultSettings = { kind: 'behavioral', persona: 'recruiter', format: 'auto', level: 'auto', depth: 1, goal: '', useBank: true };
  const kindLabel = (kind) => C.t(KINDS.find(([id]) => id === kind)?.[1] || '');
  const M = { phase: 'idle', agentId: '', lang: '', mode: 'basic', settings: { ...defaultSettings }, topic: '', modeTouched: false, consent: false, cameraStream: null, cameraTimer: null, cameraBusy: false, visualCount: 0, previousFrame: '', cameraJob: null, lines: [], partial: '', state: '', error: '', record: null, history: null, endsAt: 0, id: '' };
  S.mock = M;
  let ws = null;
  let audio = null; // { ctx, stream, node }
  let timer = null;
  let keepAlive = null;
  let autoVoice = true;
  let queue = Promise.resolve();
  let pending = 0;
  let turnOpen = false;
  let turnId = 0;
  let finishing = false;
  let player = null;
  let sttRetries = 0;
  // The recording (mock_recording.js): the answer being given, the audio of
  // the turn in flight, an answer to send again, and clips still being filed.
  const R = C.mockRecording;
  let recorder = null;
  let pendingClip = null;
  let replyClips = [];
  let retry = null;
  let audioJobs = [];
  const voice = C.createVoiceAnswer({
    onDraft: (text) => { M.partial = text; paint(); },
    onSubmit: (text, hold) => submitAnswer(text, hold, recorder ? recorder.take() : []),
    finalize: () => {
      if (ws?.readyState !== 1) return false;
      ws.send(JSON.stringify({ type: 'Finalize' }));
      return true;
    },
  });

  const entitlement = () => (S.auth && S.auth.entitlement) || null;
  // Both modes are charged by the time used, from the same minutes as a live
  // session (main/plans.js entitlement().minutesLeft). Under 1 minute: no start.
  const minutesLeft = () => Math.max(0, Number(entitlement()?.minutesLeft) || 0);
  const canRunMode = (mode) => entitlement()?.canMock === true || M.resumeMode === mode;
  const maxMinutes = () => {
    const t = entitlement()?.training;
    return t && t.maxMinutes > 0 ? t.maxMinutes : Math.min(30, Math.floor(minutesLeft()));
  };
  const minutesText = (n) => (Math.round(n * 10) / 10).toLocaleString(S.lang.locale);
  const planLink = '<button type="button" class="btn sm" data-action="go" data-to="settings/plan/interviews">View plan and minutes</button>';

  function availability(mode) {
    if (M.resumeMode === mode) return C.t('In progress');
    if (!entitlement()) return C.t('Balance unavailable');
    return C.t('Charged per minute used');
  }

  function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function intro() {
    return `<section class="mock-hero mock-intro" data-tour="mock-setup">
      ${C.orb('idle', 88, 'tight')}
      <div class="stack grow" style="gap:5px;min-width:0">
        <span class="eyebrow on-aurora">Rehearsal room</span>
        <h1 class="h1 xl">Mock interview</h1>
        <span class="on-aurora-soft">Practice for a real role with Orby and get feedback on your answers.</span>
      </div>
    </section>`;
  }

  function localView() {
    return `${intro()}<section class="card" data-tour="mock-ad">
      <span class="strong">Sign in to practice with Orby</span>
      <span class="muted">Choose text chat or rehearse with voice and camera using your LipCue account.</span>
      <div class="row"><button type="button" class="btn primary" data-action="use-account">Sign in or create account</button></div>
      <details class="mock-details small muted"><summary>How it works</summary><video class="mock-demo" src="media/mock-how-it-works.webm" controls preload="none"></video></details>
    </section>${historyView()}`;
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
      { ok: Boolean(a && (a.company_research || a.company_dossier)), t: 'Company research', s: 'The rehearsal uses documented company information.' },
      { ok: Boolean(prep && prep.total), t: 'Question bank', s: prep && prep.total ? `${prep.total} reported questions for this company` : 'No questions from this company yet.' }
    ];
    return { items, done: items.filter((i) => i.ok).length, prep };
  }

  function setupView() {
    if (!M.modeTouched && !canRunMode(M.mode) && canRunMode(M.mode === 'basic' ? 'advanced' : 'basic')) {
      M.mode = M.mode === 'basic' ? 'advanced' : 'basic';
    }
    const agents = S.agents.filter((x) => !x.archived);
    if (!M.agentId || !agents.some((x) => x.id === M.agentId)) M.agentId = (agents[0] && agents[0].id) || '';
    const a = agents.find((x) => x.id === M.agentId);
    const lang = M.lang || (String((window.CueI18n && window.CueI18n.locale) || '').toLowerCase().startsWith('pt') ? 'pt-BR' : 'en');
    M.lang = lang;
    if (!agents.length) {
      return `${intro()}<div class="empty boxed">${icon('stack')}<span class="t">Create a session first</span><span>The interview is based on the job and files of a session.</span><a class="btn sm primary" href="#/sessions">Go to sessions</a></div>${historyView()}`;
    }
    const { items, done, prep } = readiness(a);
    const ent = entitlement();
    const canStartMode = canRunMode(M.mode);
    const modes = [
      ['basic', 'chat', 'Basic mode', 'Text chat with Orby'],
      ['advanced', 'camera', 'Advanced mode', 'Voice and camera feedback']
    ];
    return `${intro()}
      <section class="mock-grid">
        <div class="card mock-config">
          <h2 class="h2">Set up your interview</h2>
          <label class="field">Which job is this for?<select class="select" data-change="mock-agent" data-no-i18n>${agents.map((x) => `<option value="${esc(x.id)}" ${x.id === M.agentId ? 'selected' : ''}>${esc(`${C.agentCompany(x) || x.name || '—'} · ${x.role || '—'}`)}</option>`).join('')}</select></label>
          <div class="field"><span>Interview type</span>
            <div class="mock-mode-grid" role="group" aria-label="Interview type">
              ${modes.map(([mode, ic, label, description]) => `<button type="button" aria-pressed="${M.mode === mode}" class="mock-mode ${M.mode === mode ? 'active' : ''}" data-action="mock-mode-set" data-mode="${mode}">
                <span class="mock-mode-icon">${icon(ic)}</span><span class="strong">${label}</span><span class="small muted">${description}</span>
                <span class="mock-availability" data-no-i18n>${esc(availability(mode))}</span>
              </button>`).join('')}
            </div>
            ${ent ? `<span class="small muted" data-tour="mock-balance" data-no-i18n>${esc(C.t('Balance: {n} min, shared with live sessions', { n: minutesText(minutesLeft()) }))}</span>` : ''}
          </div>
          <div class="mock-mode-grid">
            <label class="field">Interview type<select class="select" data-change="mock-kind">${C.opts(KINDS, M.settings.kind)}</select><span class="small muted" data-no-i18n>${esc(C.t(KIND_HINTS[M.settings.kind] || ''))}</span></label>
            <label class="field">Interviewer<select class="select" data-change="mock-persona">${C.opts(PERSONAS, M.settings.persona)}</select></label>
            <label class="field">Interview language<select class="select" data-change="mock-lang" data-no-i18n>${C.opts(LANGUAGES, lang)}</select></label>
          </div>
          <details class="mock-details">
            <summary class="strong">Interview settings</summary>
            <div class="stack gap-8" style="margin-top:12px">
              <div class="mock-mode-grid">
                <label class="field">Interview track<select class="select" data-change="mock-format">${C.opts([['auto', 'Match the role'], ['internship', 'Internship'], ['professional', 'Professional role']], M.settings.format)}</select></label>
                <label class="field">Seniority<select class="select" data-change="mock-level">${C.opts(LEVELS, M.settings.level)}</select></label>
                <label class="field">Follow-up depth<select class="select" data-change="mock-depth">${C.opts([['0', 'Main questions only'], ['1', 'Up to one per topic'], ['2', 'Up to two per topic']], String(M.settings.depth))}</select></label>
              </div>
              <label class="field">Practice goal<input class="input" type="text" maxlength="400" data-input="mock-goal" value="${esc(M.settings.goal)}" placeholder="Optional. Example: Explain my project impact with real examples." /></label>
              <label class="mock-consent"><input type="checkbox" data-change="mock-bank" ${M.settings.useBank ? 'checked' : ''}/><span>Use relevant questions from the community bank</span></label>
            </div>
          </details>
          ${M.mode === 'advanced' ? `<div class="stack" style="gap:8px"><div class="row" style="gap:8px"><button type="button" class="btn sm" data-action="mock-mic-test">${icon('microphone')}Test microphone</button><div class="mock-meter grow"><span id="mockMeter"></span></div></div>
            <span class="small muted" id="mockMicNote">Speak after clicking: the bar should move.</span></div>
          <label class="mock-consent"><input type="checkbox" data-change="mock-consent" ${M.consent ? 'checked' : ''}/><span>I agree to send occasional camera snapshots to AI for visual coaching.</span></label>
          <details class="mock-details small muted"><summary>How camera analysis works</summary><p>About once a minute, a camera still is sent to AI; when available, it is compared with the previous still for framing, eye direction, posture, clothing, background organization and visible movement. The app does not record video or save camera images.</p></details>` : ''}
          ${M.error ? `<div class="banner warn" role="alert">${icon('alert')}<span class="grow">${esc(M.error)}</span></div>` : ''}
          <div class="mock-actions">
            ${canStartMode ? `<button type="button" class="btn primary lg" data-action="mock-start" ${M.mode === 'advanced' && !M.consent ? 'disabled' : ''}>${icon(M.mode === 'basic' ? 'chat' : 'camera')}${M.resumeMode === M.mode ? 'Resume interview' : M.mode === 'basic' ? 'Start Basic interview' : 'Start Advanced interview'}</button><span class="small muted" data-no-i18n>${esc(C.t('Up to {n} minutes', { n: maxMinutes() }))}</span>`
              : `<span class="small muted">${ent ? 'You have no minutes left for a mock interview.' : 'Could not read your balance.'}</span>${planLink}`}
          </div>
        </div>
        <div class="stack" style="gap:16px;min-width:0">
          <div class="card" style="gap:12px">
            <div class="row" style="gap:12px"><div class="mock-ring" style="--p:${done * 100 / items.length}"><span class="num">${done}/${items.length}</span></div><span class="stack" style="gap:2px"><span class="strong">How ready is this rehearsal?</span><span class="small muted">The more it knows, the closer to the real one.</span></span></div>
            ${items.map((i) => `<div class="mock-check ${i.ok ? 'ok' : ''}">${icon(i.ok ? 'check-circle' : 'alert')}<span class="stack" style="gap:0"><span>${i.t}</span><span class="small muted">${i.s}</span></span></div>`).join('')}
            ${a && done < items.length && items.slice(0, -1).some((i) => !i.ok) ? `<a class="btn sm" href="#/session/${esc(a.id)}">Complete this session</a>` : ''}
          </div>
          ${prep?.total ? `<details class="card mock-details" data-tour="mock-bank">
            <summary class="strong">Questions that may come up</summary>
            <div class="stack gap-8" style="margin-top:12px"><span class="small muted">Community reports for this company. Orby can use questions that match the role and the current topic.</span>
              ${prep.questions.map((q) => `<div class="mock-q"><span data-no-i18n>${esc(q.text)}</span>${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}</div>`).join('')}
            </div>
          </details>` : ''}
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
    const rows = turns.map((l) => `<div class="bubble ${l.who === 'me' ? 'me' : 'ai'}"><span class="bubble-who">${l.who === 'me' ? 'You' : 'Orby'}</span><span class="bubble-text" data-no-i18n>${esc(l.text)}</span></div>`);
    if (M.partial) rows.push(`<div class="stack" style="gap:2px;opacity:.65"><span class="small faint">You</span><span data-no-i18n>${esc(M.partial)}</span></div>`);
    return rows.join('');
  }

  function lastOrbyLine() {
    let text = '';
    for (let i = M.lines.length - 1; i >= 0; i -= 1) {
      if (M.lines[i].who !== 'ai') {
        if (text) break;
        continue;
      }
      text = text ? `${M.lines[i].text} ${text}` : M.lines[i].text;
    }
    return text;
  }

  function questionCount() {
    let n = 0;
    let prev = '';
    for (const l of M.lines) {
      if (l.who === 'ai' && prev !== 'ai') n += 1;
      prev = l.who;
    }
    return n;
  }

  function liveView() {
    const a = S.agents.find((x) => x.id === M.agentId);
    return `<section class="mock-room" id="mockStage">
        <div class="mock-room-stage">
          <div class="mock-room-bar">
            <span class="pill ok"><span class="dot"></span>Mock · ${M.mode === 'advanced' ? 'Advanced' : 'Basic'}</span>
            <span class="strong truncate" data-no-i18n>${esc(a ? `${C.agentCompany(a) || a.name || '—'} · ${a.role || '—'}` : '')}</span>
            <span class="grow"></span>
            <span class="small muted">Question <span class="mono" id="mockQIndex" style="color:var(--text)">${questionCount()}</span></span>
            <span class="clock-chip" id="mockClock">${clock((M.endsAt - Date.now()) / 1000)}</span>
          </div>
          <div class="mock-room-center">
            ${C.orb(M.state || 'idle', 360, 'room')}
            <span class="state-pill ${M.state || ''}" id="mockStatePill" role="status"><span class="dot sm" aria-hidden="true"></span><span id="mockState">${esc(STATE_LABEL[M.state] || '')}</span></span>
            <span class="small muted" id="mockTopic" data-no-i18n>${esc(topicLabel(M.topic))}</span>
            <p class="mock-caption" id="mockCaption" data-no-i18n>${esc(lastOrbyLine())}</p>
          </div>
          <div class="mock-room-controls">
            <button type="button" class="btn pillish" data-action="mock-ask" data-ask="repeat">Repeat question</button>
            <button type="button" class="btn pillish" data-action="mock-ask" data-ask="skip" id="mockSkip" data-no-i18n>${esc(skipLabel(M.topic))}</button>
            <button type="button" class="btn pillish accent" data-action="mock-ask" data-ask="hint">Orby hint</button>
            <button type="button" class="btn pillish end" data-action="mock-finish" ${M.id ? '' : 'disabled'}><span class="stop-square"></span>End and see score</button>
          </div>
        </div>
        <aside class="mock-room-side">
          ${M.mode === 'advanced' ? `<div class="mock-cam"><div class="mock-camera"><video id="mockCameraPreview" autoplay muted playsinline></video><span class="cam-tag">CAMERA</span></div><span class="small muted" id="mockVisionStatus">Camera analysis is on. The app does not save the images.</span></div>` : ''}
          <div class="row between" style="padding:14px 16px 6px"><span class="strong">Conversation</span></div>
          <div id="mockLines" class="mock-lines">${linesHtml()}</div>
          ${M.error ? `<div class="small" role="alert" style="color:var(--danger);padding:0 16px 8px">${esc(M.error)}</div>` : ''}
          ${M.mode === 'advanced' ? `<div class="mock-input">
            <button type="button" class="btn primary" id="mockFinishAnswer" data-action="mock-finish-answer" disabled>Finish answer</button>
            <button type="button" class="btn" id="mockAutoVoice" data-action="mock-auto-voice" aria-pressed="${autoVoice}" disabled>${esc(C.t(autoVoice ? 'Auto-send on' : 'Auto-send off'))}</button>
          </div>` : ''}
          <div class="mock-input"><input class="input grow" id="mockTyped" placeholder="${M.mode === 'basic' ? 'Type your answer' : 'Or type your answer'}"/><button type="button" class="btn primary icon-only" data-action="mock-send" aria-label="Send answer" title="Send answer">${icon('send')}</button></div>
        </aside>
      </section>`;
  }

  const JEV_LABELS = [['adequacao', 'Relevance'], ['cultura', 'Culture'], ['estrutura', 'Structure'], ['evidencias', 'Evidence'], ['objetividade', 'Objectivity']];

  // Better versions of an answer (mock_evaluation.js). All are rendered; the
  // buttons show one at a time without re-rendering the report (mock-rewrite).
  const REWRITE_LABELS = [['melhorada', 'Improved'], ['curta', 'Shorter'], ['tecnica', 'More technical'], ['exemplo', 'With an example']];
  function rewriteHtml(rw) {
    if (!rw || !rw.melhorada) return '';
    const kinds = REWRITE_LABELS.filter(([k]) => rw[k]);
    const tabs = kinds.length > 1
      ? `<div class="seg" role="group" aria-label="Better version" style="flex-wrap:wrap;width:fit-content">${kinds.map(([k, label], n) => `<button type="button" class="${n ? '' : 'on'}" aria-pressed="${!n}" data-action="mock-rewrite" data-kind="${k}">${label}</button>`).join('')}</div>`
      : '';
    const texts = kinds.map(([k], n) => `<div class="small" data-rewrite="${k}" data-no-i18n style="white-space:pre-wrap;line-height:1.55"${n ? ' hidden' : ''}>${esc(rw[k])}</div>`).join('');
    return `<div class="card tight" data-rewrite-box style="gap:8px"><div class="row" style="gap:6px">${icon('sparkle')}<span class="strong small">Better version</span></div>${tabs}${texts}<span class="small muted">Built only from what you said and your materials. Fill in the [brackets] with your real data.</span></div>`;
  }

  const SIGNAL_LABELS = [['escopo', 'Scope'], ['ownership', 'Ownership'], ['ambiguidade', 'Ambiguity'], ['perseveranca', 'Perseverance'], ['conflito', 'Conflict'], ['comunicacao', 'Communication'], ['crescimento', 'Growth'], ['lideranca', 'Leadership'], ['ia', 'Judgment with AI']];
  const PITFALLS = {
    poucas_acoes: ['Few actions of your own', 'Spend most of the answer on the steps you took.'],
    nos: ['"We" hides what you did', 'Say "I" for what you did yourself and name what the team did.'],
    contexto_longo: ['Too much context', 'Keep the background to one or two sentences.'],
    perfeito_demais: ['Too perfect an ending', 'Include a real obstacle or mistake and how you handled it.'],
    sem_resultado: ['No result', 'End with what changed, measured or compared before and after.'],
    sem_aprendizado: ['No learning', 'Say what you would do differently next time.'],
    fora_do_sinal: ['Missed what was asked', 'Decide what the question tests before picking the story.'],
    escopo_baixo: ['Scope below the level', 'Pick a story with the scope of the level you are applying for.'],
    negativo: ['Blames others', 'Explain the other side and how the relationship ended up.'],
    jargao: ['Jargon', 'Explain in terms someone outside your field would follow.']
  };
  const CARL_PARTS = [['c', 'Context'], ['a', 'Your actions'], ['r', 'Result'], ['l', 'Learning']];
  const CARL_STATES = ['missing', 'weak', 'clear'];
  const signalLabel = (id) => C.t(SIGNAL_LABELS.find(([k]) => k === id)?.[1] || '');

  // The signal area this answer showed, its pitfalls and, for a story, which
  // of context, actions, result and learning came through.
  function itemSignalHtml(it) {
    const tags = [
      ...(it.sinal ? [`<span class="pill" data-no-i18n>${esc(signalLabel(it.sinal))}</span>`] : []),
      ...(it.armadilhas || []).filter((p) => PITFALLS[p]).map((p) => `<span class="pill warn" data-no-i18n>${esc(C.t(PITFALLS[p][0]))}</span>`)
    ].join('');
    const carl = it.carl
      ? `<div class="row" style="gap:6px;flex-wrap:wrap"><span class="small strong">Story</span>${CARL_PARTS.map(([k, label]) => `<span class="pill" style="gap:6px"><span>${label}</span><b data-no-i18n>${it.carl[k] == null ? '-' : esc(C.t(CARL_STATES[it.carl[k]]))}</b></span>`).join('')}</div>`
      : '';
    return (tags ? `<div class="row" style="gap:6px;flex-wrap:wrap">${tags}</div>` : '') + carl;
  }

  // Best answer per signal area and the pitfalls that came back most often.
  function signalsHtml(J, kind) {
    const shown = SIGNAL_LABELS.filter(([k]) => J.signals && J.signals[k] != null);
    const missing = !kind || kind === 'behavioral' ? SIGNAL_LABELS.filter(([k]) => k !== 'ia' && !(J.signals && J.signals[k] != null)).map(([, label]) => C.t(label)) : [];
    const signals = shown.length ? `<section class="card" style="gap:10px">
        <span class="strong">Signal areas</span>
        <span class="small muted">Your best answer in each area interviewers look for.</span>
        <div class="row" style="gap:6px;flex-wrap:wrap">${shown.map(([k, label]) => `<span class="pill" style="gap:6px"><span>${label}</span><b class="num">${(J.signals[k] / 10).toFixed(1)}</b></span>`).join('')}</div>
        ${missing.length ? `<span class="small muted" data-no-i18n>${esc(C.t('No story yet for: {list}', { list: missing.join(', ') }))}</span>` : ''}
      </section>` : '';
    const pitfalls = (J.pitfalls || []).filter(({ id }) => PITFALLS[id]);
    const pits = pitfalls.length ? `<section class="card" style="gap:10px">
        <span class="strong">Recurring pitfalls</span>
        ${pitfalls.map(({ id, n }) => `<div class="stack" style="gap:2px"><div class="row" style="gap:8px"><span class="small strong" data-no-i18n>${esc(C.t(PITFALLS[id][0]))}</span><span class="small muted" data-no-i18n>${esc(n === 1 ? C.t('in 1 answer') : C.t('in {n} answers', { n }))}</span></div><span class="small" data-no-i18n>${esc(C.t(PITFALLS[id][1]))}</span></div>`).join('')}
      </section>` : '';
    return signals + pits;
  }

  // The scores the JEV gave this answer, criterion by criterion.
  function itemNotesHtml(it) {
    const notas = it.notas || {};
    const row = JEV_LABELS.filter(([k]) => notas[k] != null).map(([k, label]) => `<span class="pill" style="gap:6px"><span>${label}</span><b class="num">${notas[k]}</b></span>`).join('');
    return row ? `<div class="row" style="gap:6px;flex-wrap:wrap">${row}</div>` : '';
  }

  function evaluationHtml(r) {
    const J = r.evaluation;
    if (!J) return r.feedback ? `<section class="card"><pre class="md" style="white-space:pre-wrap">${esc(r.feedback)}</pre></section>` : '<section class="card"><div class="muted">Feedback is unavailable right now. Your transcript was saved.</div></section>';
    const list = (title, ic, rows) => `<div class="card tight"><div class="row">${icon(ic)}<span class="strong">${title}</span></div>${rows.map((x) => `<div class="small" data-no-i18n>${esc(x)}</div>`).join('') || '<div class="muted">—</div>'}</div>`;
    const detail = (label, text) => text ? `<div class="small"><strong>${label}</strong> <span data-no-i18n>${esc(text)}</span></div>` : '';
    const questions = (J.items || []).map((it) => `<div class="stack" style="gap:6px">
      <div class="row" style="gap:8px"><span class="grow strong" data-no-i18n>${esc(it.question || it.pergunta)}</span><span class="pill num">${it.score == null ? '-' : (it.score / 10).toFixed(1)} / 10</span></div>
      <span class="small muted" data-no-i18n>${esc(it.veredito)}</span>
      ${itemNotesHtml(it)}
      ${itemSignalHtml(it)}
      ${detail('Your answer', it.answer)}
      ${detail('What was missing', it.lacuna)}
      ${detail('How to improve', it.dica)}
      ${rewriteHtml(it.reescrita)}
      ${detail('What supported the score', it.trecho)}
      ${detail('Company value in the materials', it.valorCitado)}
    </div>`).join('');
    return `<section class="card" style="gap:14px">
        <span class="eyebrow">JEV criteria</span>
        ${J.partial && Number.isInteger(J.answers) ? `<span class="small muted">${esc(C.t('{n} of {total} answers scored', { n: J.items.length, total: J.answers }))}</span>` : ''}
        ${J.objetivo ? list('Practice goal assessment', 'check-circle', [J.objetivo]) : ''}
        ${J.resumo ? `<span class="muted" data-no-i18n>${esc(J.resumo)}</span>` : ''}
        ${JEV_LABELS.map(([k, label]) => { const v = J.criteria && J.criteria[k] != null ? J.criteria[k] : null; const tone = C.scoreTone(v); return `<div class="crit-row"><span class="strong">${label}</span>${C.pctBar(v || 0, tone.cls === 'ok' ? '' : tone.cls)}<span class="score-num" style="color:${tone.color}">${v == null ? '—' : (v / 10).toFixed(1)}</span></div>`; }).join('')}
      </section>
      ${signalsHtml(J, r.settings?.kind)}
      <section class="grid-2">${list('Strengths', 'check-circle', J.fortes || [])}${list('To improve', 'arrow-up-right', J.melhorar || [])}</section>
      ${J.proximo ? `<section class="card">${detail('Next practice step', J.proximo)}</section>` : ''}
      <section class="card" style="gap:12px"><span class="strong">Question by question</span>${questions}</section>`;
  }

  const ISSUE_LABELS = {
    gramatica: 'Grammar', concordancia: 'Agreement', regencia: 'Prepositions', tempo_verbal: 'Verb tense', ortografia: 'Spelling', pontuacao: 'Punctuation',
    vocabulario: 'Word choice', repeticao: 'Repetition', vicio: 'Filler words', registro: 'Too informal', clareza: 'Clarity'
  };
  const issueLabel = (id) => C.t(ISSUE_LABELS[id] || ISSUE_LABELS.gramatica);

  // Only how the answers were said (main/mock_language.js).
  function languageHtml(r) {
    const L = r.language;
    if (!L || !(L.items || []).length) return '';
    const ten = (v) => (v == null ? '-' : (v / 10).toFixed(1));
    const items = L.items.map((it) => {
      const fixes = (it.erros || []).map((e) => `<li><span class="pill warn" data-no-i18n>${esc(issueLabel(e.tipo))}</span> <del data-no-i18n>${esc(e.trecho)}</del> → <ins data-no-i18n>${esc(e.sugestao)}</ins>${e.motivo ? `<div class="small muted" data-no-i18n>${esc(e.motivo)}</div>` : ''}</li>`).join('');
      const swaps = (it.trocas || []).map((sw) => `<li><del data-no-i18n>${esc(sw.de)}</del> → <ins data-no-i18n>${esc((sw.para || []).join(' · '))}</ins>${sw.motivo ? `<div class="small muted" data-no-i18n>${esc(sw.motivo)}</div>` : ''}</li>`).join('');
      const clean = !(it.erros || []).length && !(it.trocas || []).length;
      return `<details class="mock-lang-item stack" style="gap:6px">
        <summary class="row" style="gap:8px"><span class="grow strong" data-no-i18n>${esc(it.question)}</span><span class="pill num">${it.nota == null ? '-' : it.nota} / 10</span></summary>
        <span class="small muted" data-no-i18n>${esc(it.comentario || (clean ? C.t('No language issues in this answer.') : C.t('{n} points to adjust', { n: (it.erros || []).length + (it.trocas || []).length })))}</span>
        <div class="row" style="gap:6px"><span class="pill">${it.falada ? 'Spoken answer' : 'Typed answer'}</span></div>
        <div class="small"><strong>Your answer</strong> <span data-no-i18n>${esc(it.answer)}</span></div>
        ${fixes ? `<div class="stack" style="gap:4px"><span class="small strong">What to fix</span><ul class="mock-fix">${fixes}</ul></div>` : ''}
        ${swaps ? `<div class="stack" style="gap:4px"><span class="small strong">Better words</span><ul class="mock-fix">${swaps}</ul></div>` : ''}
        ${it.corrigida ? `<div class="small"><strong>Corrected version</strong> <span data-no-i18n>${esc(it.corrigida)}</span></div>` : ''}
      </details>`;
    }).join('');
    return `<section class="card" style="gap:12px" data-section="mock-language">
        <div class="row" style="gap:8px">${icon('sparkle')}<span class="strong grow">Language review</span>${L.nota != null ? `<span class="pill num">${ten(L.nota)} / 10</span>` : ''}</div>
        <span class="small muted">Only how you said it: grammar, word choice and speaking habits. The content is scored above.</span>
        ${L.resumo ? `<span data-no-i18n>${esc(L.resumo)}</span>` : ''}
        ${(L.tipos || []).length ? `<div class="row" style="gap:6px;flex-wrap:wrap">${L.tipos.map(({ id, n }) => `<span class="pill warn" data-no-i18n>${esc(issueLabel(id))} · ${n}</span>`).join('')}</div>` : ''}
        ${(L.dicas || []).map((d) => `<div class="small" data-no-i18n>• ${esc(d)}</div>`).join('')}
        ${items}
        ${L.partial ? `<span class="small muted" data-no-i18n>${esc(C.t('{n} of {total} answers reviewed.', { n: L.items.length, total: L.answers }))}</span>` : ''}
      </section>`;
  }

  // Each question and the answer to it, in separate players. The audio is
  // loaded after rendering (afterRender), from the files main/mock_interview.js saved.
  function recordingHtml(r) {
    const audio = r.audio || [];
    if (!audio.length) return '';
    const files = new Map(audio.map((a) => [`${a.role}:${a.i}`, a.file]));
    let n = 0;
    const row = (who, label, item) => {
      const key = `${who === 'orby' ? 'assistant' : 'user'}:${item.i}`;
      const file = files.get(key);
      const player = file ? `<audio controls preload="metadata" data-mock-audio="${esc(file)}" aria-label="${esc(label)}"></audio>` : '';
      const fallback = !file && who === 'orby' ? `<button type="button" class="btn sm" data-action="mock-speak-text" data-i="${item.i}">Listen with the system voice</button>` : '';
      const typed = !file && who === 'you' ? '<span class="small muted">Typed answer, or no audio was kept.</span>' : '';
      return `<div class="mock-rec-row ${who} stack" style="gap:4px"><span class="small strong" data-no-i18n>${esc(label)}</span>${player}${fallback}${typed}<span class="small muted" data-no-i18n>${esc(item.text)}</span></div>`;
    };
    const pairs = R.recordingPairs(r.messages || [], audio).map(({ question, answer }) => {
      if (question) n += 1;
      return `<div class="mock-rec stack" style="gap:8px">${question ? row('orby', C.t('Question {n}', { n }), question) : ''}${answer ? row('you', C.t('Your answer'), answer) : ''}</div>`;
    }).join('');
    return `<section class="card" style="gap:12px" data-section="mock-recording" data-record="${esc(r.id)}">
        <div class="row" style="gap:8px">${icon('waveform')}<span class="strong">Interview recording</span></div>
        <span class="small muted">Each question and your answer to it, in separate players. The audio stays on this computer, for your 20 most recent interviews.</span>
        ${pairs}
      </section>`;
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

  function coverageHtml(record) {
    if (!record.coverage?.length) return '';
    const persona = [kindLabel(record.settings?.kind), personaLabel(record.settings?.persona)].filter(Boolean).join(' · ');
    return `<section class="card" style="gap:10px">
      <span class="strong">Interview coverage</span>
      ${persona ? `<span class="small muted" data-no-i18n>${esc(persona)}</span>` : ''}
      <span class="small" data-no-i18n>${esc(record.settings?.goal || C.t(defaultGoal))}</span>
      ${record.coverage.map(({ id, status }) => `<div class="row between"><span data-no-i18n>${esc(topicLabel(id))}</span><span class="small muted" data-no-i18n>${esc(C.t(COVERAGE[status] || ''))}</span></div>`).join('')}
    </section>`;
  }

  function doneView() {
    const r = M.record;
    const J = r && r.evaluation;
    return `<section class="mock-hero mock-done-hero">
        ${C.orb(M.phase === 'finishing' ? 'thinking' : 'happy', 120, 'tight')}
        <div class="stack grow" style="gap:6px;min-width:0"><span class="eyebrow on-aurora">Mock result</span><h1 class="h1 xl">Interview feedback</h1><span class="on-aurora-soft" data-no-i18n>${esc(r ? `${r.company || '—'} · ${r.role || '—'}` : '')}</span></div>
        ${J && J.score != null ? `<div class="score-disc" style="--p:${J.score}"><div><span class="v">${(J.score / 10).toFixed(1)}</span><span class="num">/ 10</span></div></div>` : ''}
      </section>
      ${M.phase === 'finishing' ? `<section class="card"><div class="row" style="gap:8px">${icon('sparkle')}<span>Writing your feedback…</span></div></section>` : ''}
      ${r ? coverageHtml(r) + evaluationHtml(r) + languageHtml(r) + recordingHtml(r) + visualFeedbackHtml(r) + coachHtml(r) + transcriptHtml(r) : ''}
      ${M.phase === 'done' && !r ? `<section class="card"><div class="muted">${esc(M.refunded ? 'The interview ended before any answer and was not counted.' : 'The interview ended before any answer.')}</div></section>` : ''}
      ${M.phase === 'done' && M.chargedMinutes != null ? `<div class="small muted" data-no-i18n>${esc(M.chargedMinutes > 0 ? C.t('{n} min used from your balance', { n: minutesText(M.chargedMinutes) }) : C.t('Nothing was charged: interviews under a minute are free.'))}</div>` : ''}
      ${M.phase === 'done' ? '<div class="row"><button type="button" class="btn primary" data-action="mock-reset">Back</button></div>' : ''}`;
  }

  C.views.mock = function mock() {
    let body = setupView;
    if (M.phase === 'live') body = liveView;
    else if (M.phase === 'finishing' || M.phase === 'done') body = doneView;
    else if (C.localMode()) body = localView;
    return body === liveView ? body() : `<div class="page design-page mock-page">${body()}</div>`;
  };
  C.mockRecords = () => M.history || [];
  C.loadMockRecords = function loadMockRecords() {
    if (M.history === null && api.mockList) {
      M.history = [];
      C.guard(() => api.mockList()).then((list) => {
        M.history = Array.isArray(list) ? list : [];
        if (M.history.length && (S.route.view === 'home' || (S.route.view === 'mock' && M.phase === 'idle'))) C.renderView();
      });
    }
  };
  C.afterRender.mock = function afterMock() {
    C.loadMockRecords();
    C.startOrbs();
    const box = document.getElementById('mockLines');
    if (box) box.scrollTop = box.scrollHeight;
    const typed = document.getElementById('mockTyped');
    if (typed) {
      typed.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          C.actions['mock-send']();
        }
      });
    }
    const preview = document.getElementById('mockCameraPreview');
    if (preview && M.cameraStream && preview.srcObject !== M.cameraStream) preview.srcObject = M.cameraStream;
    loadRecording();
    if (M.agentId && api.mockPrep && !(M.prep && M.prep[M.agentId]) && M.phase === 'idle') {
      const id = M.agentId;
      M.prep = { ...(M.prep || {}), [id]: { total: 0, questions: [] } };
      api.mockPrep(id).then((prep) => {
        M.prep[id] = prep || { total: 0, questions: [] };
        if (prep && prep.total && S.route.view === 'mock' && M.phase === 'idle') C.renderView();
      });
    }
  };

  // Object URLs of the clips of the report on screen, made once per record.
  const audioUrls = new Map();
  function loadRecording() {
    const r = M.record;
    if (!r || !api.mockAudio) return;
    for (const [key, url] of audioUrls) {
      if (!key.startsWith(`${r.id}/`)) {
        URL.revokeObjectURL(url);
        audioUrls.delete(key);
      }
    }
    for (const el of document.querySelectorAll('audio[data-mock-audio]')) {
      const key = `${r.id}/${el.dataset.mockAudio}`;
      if (audioUrls.has(key)) {
        el.src = audioUrls.get(key);
        continue;
      }
      api.mockAudio(r.id, el.dataset.mockAudio).then((bytes) => {
        if (!bytes || M.record !== r) return;
        const type = el.dataset.mockAudio.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
        if (!audioUrls.has(key)) audioUrls.set(key, URL.createObjectURL(new Blob([bytes], { type })));
        el.src = audioUrls.get(key);
      });
    }
  }

  // Files the audio of the messages a turn added: the answer's own recording
  // (null when typed) and the interviewer's sentences.
  function keepTurnAudio(added, voiceClip, replies) {
    if (!api.mockKeepAudio) return;
    for (const { i, role } of added || []) {
      if (role === 'user' && voiceClip) {
        audioJobs.push(api.mockKeepAudio({ i, role, spoken: true, mime: 'audio/wav', bytes: R.answerAudio(voiceClip) }));
      }
      if (role === 'assistant' && replies.length) {
        audioJobs.push(Promise.all(replies).then((parts) => {
          const ok = parts.filter((b) => b && b.length);
          if (!ok.length) return null;
          const bytes = new Uint8Array(ok.reduce((n, b) => n + b.length, 0));
          ok.reduce((at, b) => (bytes.set(b, at), at + b.length), 0);
          return api.mockKeepAudio({ i, role, mime: 'audio/mpeg', bytes });
        }));
      }
    }
  }

  function paint() {
    const box = document.getElementById('mockLines');
    if (box) {
      box.innerHTML = linesHtml();
      box.scrollTop = box.scrollHeight;
    }
    C.setOrbState(M.state);
    const pill = document.getElementById('mockStatePill');
    if (pill) pill.className = `state-pill ${M.state || ''}`;
    const caption = document.getElementById('mockCaption');
    if (caption) caption.textContent = lastOrbyLine();
    const qi = document.getElementById('mockQIndex');
    if (qi) qi.textContent = String(questionCount());
    const topic = document.getElementById('mockTopic');
    if (topic) topic.textContent = topicLabel(M.topic);
    const skip = document.getElementById('mockSkip');
    if (skip) skip.textContent = skipLabel(M.topic);
    const st = document.getElementById('mockState');
    if (st) st.textContent = C.t ? C.t(STATE_LABEL[M.state] || '') : STATE_LABEL[M.state] || '';
    const done = document.getElementById('mockFinishAnswer');
    if (done) done.disabled = M.state !== 'listening' || !M.partial;
    const auto = document.getElementById('mockAutoVoice');
    if (auto) {
      auto.disabled = M.state !== 'listening' || ws?.readyState !== 1;
      auto.setAttribute('aria-pressed', String(autoVoice));
      auto.textContent = C.t(autoVoice ? 'Auto-send on' : 'Auto-send off');
    }
  }
  function setState(s) {
    M.state = s;
    paint();
  }

  function stopCapture() {
    clearInterval(keepAlive);
    voice.suspend();
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

  function connectStt(stt) {
    const q = new URLSearchParams({
      model: stt.model || 'nova-3', language: M.lang, encoding: 'linear16', sample_rate: '16000',
      channels: '1', interim_results: 'true', endpointing: '300', vad_events: 'true', smart_format: 'true'
    });
    const { url } = stt;
    const socket = new WebSocket(`${url}?${q}`, ['bearer', stt.token]);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (e) => {
      if (ws !== socket || M.phase !== 'live' || (M.state !== 'listening' && !mayResume)) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (_e) { return; }
      if (mayResume) {
        if (msg.from_finalize || (msg.type !== 'SpeechStarted' && !msg.channel?.alternatives?.[0]?.transcript?.trim())) return;
        resumeAnswer();
      }
      voice.receive(msg);
    };
    socket.onopen = () => { sttRetries = 0; paint(); };
    socket.onclose = async () => {
      if (ws !== socket || M.phase !== 'live') return;
      voice.suspend();
      paint();
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
      if (M.state !== 'listening' && !mayResume) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
      if (recorder) recorder.push(pcm);
      if (ws && ws.readyState === 1) ws.send(pcm.buffer);
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
    voice.take();
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
    replyClips.push(clip.catch(() => null));
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
        player.onpause = resolve;
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

  // `voiceClip` is the microphone audio of a spoken answer (null when typed).
  async function runTurn(text, action = '', holdMs = 0, voiceClip = null) {
    const current = ++turnId;
    const lineStart = M.lines.length - (text ? 1 : 0);
    turnOpen = true;
    pendingClip = voiceClip;
    const replies = [];
    replyClips = replies;
    setState('thinking');
    const r = await (holdMs > 0 ? api.mockTurn(text, action, holdMs) : action ? api.mockTurn(text, action) : api.mockTurn(text));
    if (current !== turnId || M.phase !== 'live') return;
    turnOpen = false;
    mayResume = false;
    if (!r || !r.ok) {
      if (r && r.aborted) return;
      if (r && r.over) finishing = true;
      else {
        M.lines.splice(lineStart);
        M.error = 'The interviewer did not answer. Try your answer again.';
        // Sent again unchanged, the answer keeps its recording.
        if (text) retry = { text, clip: voiceClip };
        C.renderView();
        const input = document.getElementById('mockTyped');
        if (input && text) input.value = text;
      }
    } else {
      M.topic = r.topic || M.topic;
      if (r.finished) finishing = true;
      keepTurnAudio(r.added, voiceClip, replies);
    }
    pendingClip = null;
    maybeListen();
  }

  // Still talking after a pause: back to the same answer, before the interviewer
  // has said anything.
  function resumeAnswer() {
    mayResume = false;
    turnId += 1;
    turnOpen = false;
    voice.restore();
    if (recorder) recorder.restore(pendingClip);
    pendingClip = null;
    M.lines.pop();
    api.mockCancelTurn();
    setState('listening');
  }

  // holdMs: how long the main process keeps a spoken answer's reply to itself.
  // voiceClip: the recording of a spoken answer, null when typed.
  function submitAnswer(value, holdMs = 0, voiceClip = null) {
    const text = String(value).trim();
    if (!text || M.phase !== 'live' || (M.mode === 'basic' ? M.state !== 'typing' : M.state !== 'listening')) return;
    M.lines.push({ who: 'me', text });
    mayResume = holdMs > 0;
    M.error = '';
    runTurn(text, '', holdMs, voiceClip);
  }

  async function finish() {
    if (M.phase !== 'live') return;
    M.phase = 'finishing';
    const unsent = voice.take();
    // The answer still on its way: the turn in flight or what was being said.
    const rest = recorder ? recorder.take() : null;
    const clip = turnOpen ? (pendingClip ? [...pendingClip, ...(rest || [])] : null) : (unsent ? rest : null);
    const pendingAudio = clip ? { spoken: true, bytes: R.answerAudio(clip) } : null;
    recorder = null;
    pendingClip = null;
    turnId += 1;
    turnOpen = false;
    clearInterval(timer);
    stopCapture();
    stopCamera();
    M.previousFrame = '';
    M.consent = false;
    if (player) player.pause();
    if (M.cameraJob) await M.cameraJob.catch(() => null);
    C.renderView();
    // Clips of earlier turns are filed before the record is written.
    const jobs = audioJobs.splice(0);
    await Promise.race([Promise.allSettled(jobs), new Promise((resolve) => { setTimeout(resolve, 8000); })]);
    const r = await C.guard(() => api.mockEnd(unsent, pendingAudio), 'Could not end the interview.');
    M.record = (r && r.record) || null;
    M.refunded = Boolean(r && r.refunded);
    M.chargedMinutes = r && Number.isFinite(r.chargedMinutes) ? r.chargedMinutes : null;
    M.history = null;
    M.phase = 'done';
    if (C.authRefresh) await C.authRefresh(true);
    C.renderView();
    // The record exists only when the user answered (mock_interview.js end()).
    const id = M.record && M.record.id;
    if (id && C.openFeedback && (await api.feedbackShouldAskMock({ id, userTurns: 1 }).catch(() => false))) C.openFeedback({ kind: 'mock', id });
  }

  C.actions['mock-start'] = async () => {
    if (M.phase !== 'idle' || M.requestingCamera || !canRunMode(M.mode)) return;
    M.error = '';
    if (!M.agentId) return;
    if (M.mode === 'advanced' && !M.consent) {
      M.error = 'Agree to camera analysis before starting Advanced.';
      C.renderView();
      return;
    }
    let cameraStream = null;
    const requestedMode = M.mode;
    if (M.mode === 'advanced') {
      M.requestingCamera = true;
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' }, audio: false });
      } catch (_e) {
        M.error = 'Camera unavailable. Allow camera access, or switch to Basic.';
        C.renderView();
        return;
      } finally {
        M.requestingCamera = false;
      }
      if (M.mode !== requestedMode || !M.consent || S.route.view !== 'mock') {
        cameraStream.getTracks().forEach((track) => track.stop());
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
    const r = await C.guard(() => api.mockStart(M.agentId, M.lang, requestedMode, M.settings), 'Could not start the interview.');
    if (!r || !r.ok) {
      stopCamera();
      M.phase = 'idle';
      M.error = (r && r.error) || 'Could not start the interview.';
      if (r?.code === 'mock_not_included') {
        M.resumeMode = '';
        await C.authRefresh(true);
      }
      C.renderView();
      return;
    }
    if (r.mode === 'advanced' && requestedMode !== 'advanced') {
      M.phase = 'idle';
      M.mode = 'advanced';
      M.resumeMode = 'advanced';
      M.consent = false;
      M.error = 'An active Advanced interview was found. Agree to camera analysis to resume it.';
      C.renderView();
      return;
    }
    M.resumeMode = '';
    M.id = r.id;
    M.agentId = r.agentId || M.agentId;
    M.lang = r.lang || M.lang;
    M.topic = r.topic || 'trajectory';
    M.lines = (r.messages || []).map(({ role, content }) => ({ who: role === 'user' ? 'me' : 'ai', text: content }));
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
    recorder = M.mode === 'advanced' && R ? R.createAnswerRecorder() : null;
    retry = null;
    audioJobs = [];
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
    if (M.lines.length) maybeListen();
    else runTurn('');
  };
  C.actions['mock-ask'] = (el) => {
    if (M.phase !== 'live' || turnOpen || !['typing', 'listening'].includes(M.state)) return;
    voice.take();
    if (recorder) recorder.take();
    runTurn('', el.dataset.ask);
  };
  C.actions['mock-finish'] = () => finish();
  C.actions['mock-finish-answer'] = () => {
    if (M.phase === 'live' && M.state === 'listening') voice.finishAnswer();
  };
  C.actions['mock-auto-voice'] = () => {
    if (M.phase !== 'live' || M.state !== 'listening' || ws?.readyState !== 1) return;
    autoVoice = !autoVoice;
    voice.setAuto(autoVoice);
    paint();
  };
  C.actions['mock-send'] = () => {
    const input = document.getElementById('mockTyped');
    const text = input?.value.trim();
    if (!text || !['listening', 'typing'].includes(M.state)) return;
    input.value = '';
    voice.take();
    // Typed: what the microphone heard meanwhile is not this answer.
    if (recorder) recorder.take();
    const clip = retry && retry.text === text ? retry.clip : null;
    retry = null;
    submitAnswer(text, 0, clip);
  };
  C.actions['mock-reset'] = () => {
    M.phase = 'idle';
    M.record = null;
    M.consent = false;
    C.renderView();
  };
  C.actions['mock-open'] = (el) => {
    const record = C.mockRecords().find((r) => r.id === el.dataset.id);
    if (!record) return;
    if (M.phase === 'idle' || M.phase === 'done') {
      M.record = record;
      M.phase = 'done';
    }
    C.navigate('mock');
  };
  C.actions['mock-rewrite'] = (el) => {
    const box = el.closest('[data-rewrite-box]');
    if (!box) return;
    for (const b of box.querySelectorAll('[data-action="mock-rewrite"]')) {
      const on = b === el;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const t of box.querySelectorAll('[data-rewrite]')) t.hidden = t.dataset.rewrite !== el.dataset.kind;
  };
  // A question whose audio was not kept, read by the system voice.
  C.actions['mock-speak-text'] = (el) => {
    const m = M.record && (M.record.messages || [])[Number(el.dataset.i)];
    const synth = window.speechSynthesis;
    if (!m || !synth || typeof SpeechSynthesisUtterance === 'undefined') return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(m.content);
    u.lang = M.record.lang || 'pt-BR';
    synth.speak(u);
  };
  C.actions['mock-for-agent'] = (el) => {
    if (M.phase === 'idle' || M.phase === 'done') {
      M.agentId = el.dataset.agent;
      M.phase = 'idle';
      M.record = null;
      M.consent = false;
    }
    C.navigate('mock');
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
  C.changes['mock-agent'] = (el) => {
    M.agentId = el.value;
    C.renderView();
  };
  C.changes['mock-lang'] = (el) => { M.lang = el.value; };
  C.changes['mock-kind'] = (el) => { M.settings.kind = el.value; C.refresh(); };
  C.changes['mock-level'] = (el) => { M.settings.level = el.value; };
  C.changes['mock-persona'] = (el) => { M.settings.persona = el.value; };
  C.changes['mock-format'] = (el) => { M.settings.format = el.value; };
  C.changes['mock-depth'] = (el) => { M.settings.depth = Number(el.value); };
  C.changes['mock-bank'] = (el) => { M.settings.useBank = Boolean(el.checked); };
  C.inputs['mock-goal'] = (el) => { M.settings.goal = el.value; };
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
