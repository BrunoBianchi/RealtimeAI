// lipcue.com dashboard — Pair programming: a live coding interview with Orby.
// The tests really run (pair_runner.js, in the main process) and Orby really
// answers through the AI route; without AI the editor and tests keep working.
// The session lives in P, so leaving the page and coming back keeps it.
'use strict';

(function pairModule() {
  const C = window.Cue;
  const api = window.rtai;
  const { esc, icon } = C;

  const STEPS = ['Understand', 'Approach', 'Code', 'Tests', 'Complexity'];
  const SCORES = [['communication', 'Communication'], ['problem_solving', 'Problem solving'], ['code_quality', 'Code quality'], ['testing', 'Tests and edge cases'], ['complexity', 'Complexity']];
  const DIFFS = ['All', 'Easy', 'Medium', 'Hard'];
  const STATE_LABEL = { idle: 'Ready', speaking: 'Speaking…', listening: 'Your turn', thinking: 'Thinking…' };

  const P = {
    catalog: null, catalogPro: false, loading: false, history: { submissions: [], sessions: [] },
    language: 'python', style: 'colab', hints: 'on', filter: 'All',
    problem: null, sessionId: 0, orbyAccount: '', code: '', drafts: {}, messages: [], step: 0, draft: '',
    state: 'idle', running: false, run: null, runs: 0, sel: null, startedAt: 0,
    finishing: false, done: null, notice: '', editorFocused: false, selStart: 0, selEnd: 0, editorTop: 0
  };
  C.pair = P;

  let clockTimer = null;
  let speakTimer = null;

  function proAccount() {
    const auth = C.state.auth;
    return !C.localMode() && auth?.signedIn && auth.entitlement?.isPro ? auth.account?.email || '' : '';
  }

  const withOrby = () => Boolean(P.orbyAccount && P.orbyAccount === proAccount());

  async function load() {
    if (P.loading || !api.pairCatalog) return;
    P.loading = true;
    const pro = Boolean(proAccount());
    const [catalog, history] = await Promise.all([api.pairCatalog(), api.pairHistory()]);
    P.catalog = catalog;
    P.catalogPro = pro;
    P.history = history || P.history;
    P.loading = false;
    if (C.state.route.view === 'pair') C.refresh();
  }

  async function reloadHistory() {
    P.history = (await api.pairHistory()) || P.history;
  }

  const solvedIds = () => new Set(P.history.submissions.filter((s) => s.status === 'accepted').map((s) => s.problemId));
  const diffClass = (d) => String(d).toLowerCase();
  const replyLanguage = () => (String((document.documentElement && document.documentElement.lang) || '').toLowerCase().startsWith('pt') ? 'Brazilian Portuguese' : 'English');
  const langInfo = () => (P.catalog ? P.catalog.languages.find((l) => l.id === P.language) : null) || { name: '', ext: '' };
  const draftKey = () => `${P.problem.id}|${P.language}`;

  function seg(name, options, current) {
    return `<div class="seg" role="group">${options.map(([id, label]) => `<button type="button" class="${current === id ? 'on' : ''}" data-action="pair-opt" data-opt="${name}" data-value="${esc(id)}">${esc(label)}</button>`).join('')}</div>`;
  }

  function diffLabel(d, extra) {
    return `<span class="diff ${diffClass(d)} ${extra || ''}">${esc(d)}</span>`;
  }

  // ------------------------------------------------------------- picker --
  function recommendation(problems, solved) {
    const next = problems.find((p) => !solved.has(p.id));
    if (!next) return '';
    const up = C.upcomingAgents()[0];
    let eyebrow = C.t('Next problem');
    if (up) {
      const company = C.agentCompany(up.a) || C.t('your interview');
      eyebrow = up.iv.days <= 0 ? C.t('Next up for {company} · today', { company })
        : up.iv.days === 1 ? C.t('Next up for {company} · tomorrow', { company })
          : C.t('Next up for {company} · in {n} days', { company, n: up.iv.days });
    }
    return `<button type="button" class="card aurora pair-rec" data-action="pair-start" data-id="${esc(next.id)}" data-tour="pair-next">
      <span class="stack grow" style="gap:8px;min-width:0">
        <span class="eyebrow on-aurora" data-no-i18n>${esc(eyebrow)}</span>
        <span class="pair-rec-t" data-no-i18n>${esc(next.title)}</span>
        <span class="row wrap on-aurora-soft" style="gap:10px;font-size:13px">${diffLabel(next.difficulty)}<span>·</span><span data-no-i18n>${esc(next.topic)}</span><span>·</span><span class="mono">~${next.minutes} min</span></span>
      </span>
      <span class="pair-go">Start${icon('arrow-right')}</span>
    </button>`;
  }

  function pickerView() {
    if (!P.catalog) return `<div class="page design-page pair-page"><div class="empty boxed"><span class="spinner"></span><span class="t">Loading problems…</span></div></div>`;
    const problems = P.catalog.problems;
    const solved = solvedIds();
    const list = problems.filter((p) => P.filter === 'All' || p.difficulty === P.filter);
    const pro = Boolean(proAccount());
    return `<div class="page design-page pair-page">
      <div class="pair-top">
        ${C.orb('idle', 72, 'tight')}
        <div class="stack grow" style="gap:4px;min-width:0"><h1 class="h1" style="font-size:28px">Pair programming</h1><span class="lede">${pro ? 'Solve a problem while talking to Orby, like in a real coding interview.' : 'Practice coding at your own pace and run tests on your computer.'}</span></div>
        <button type="button" class="btn lg" data-action="pair-random">${icon('shuffle')}Pick for me</button>
      </div>
      ${recommendation(problems, solved)}
      <div class="pair-opts" data-tour="pair-options">
        <span>Code language ${seg('language', P.catalog.languages.map((l) => [l.id, l.name]), P.language)}</span>
        ${pro ? `<span>Interviewer ${seg('style', [['colab', 'Collaborative'], ['faang', 'Strict']], P.style)}</span>
        <span>${seg('hints', [['on', 'With hints'], ['off', 'No hints']], P.hints)}</span>` : `<span>Orby and interview feedback are included in Pro. <button type="button" class="btn sm" data-action="go" data-to="settings/plan">View plan</button></span>`}
      </div>
      <div class="stack" style="gap:0" data-tour="pair-list">
        <div class="pair-list-head">
          <span class="row" style="align-items:baseline;gap:8px"><span class="strong" style="font-size:15px">Problems to practice</span><span class="num" data-no-i18n>${esc(C.t('{n} of {total} solved', { n: problems.filter((p) => solved.has(p.id)).length, total: problems.length }))}</span></span>
          <div class="pair-filter">${DIFFS.map((d) => `<button type="button" class="${P.filter === d ? 'on' : ''}" data-action="pair-opt" data-opt="filter" data-value="${d}">${d}</button>`).join('')}</div>
        </div>
        ${list.map((p) => `<button type="button" class="pair-row" data-action="pair-start" data-id="${esc(p.id)}">
          <span class="pair-check ${solved.has(p.id) ? 'on' : ''}">${solved.has(p.id) ? '✓' : ''}</span>
          <span class="pair-row-t" data-no-i18n><b>${esc(p.title)}</b><span>${esc(p.topic)}</span></span>
          ${diffLabel(p.difficulty)}
          ${icon('caret-right')}
        </button>`).join('')}
      </div>
      <span class="small faint">${pro ? 'Your code runs on this computer, with the language you have installed. Orby receives your code and messages through the AI to follow along.' : 'Your code and test results stay on this computer.'}</span>
    </div>`;
  }

  // ------------------------------------------------------------ session --
  function chipsForStep() {
    const p = P.problem;
    const hint = P.hints === 'on' ? ['Can I get a hint?'] : [];
    if (P.step === 0) return p.clarify || [];
    if (P.step === 1) return [p.brute, p.optimal].filter(Boolean);
    if (P.step === 2) return [...hint, 'What about the edge cases?'];
    if (P.step === 3) return hint;
    return [p.complexity, 'I am not sure about the complexity'].filter(Boolean);
  }

  function bubble(m) {
    return `<div class="bubble ${m.role === 'user' ? 'me' : 'ai'}"><span class="bubble-text" data-no-i18n>${esc(m.text)}</span></div>`;
  }

  function msgsHtml() {
    const rows = P.messages.filter((m) => !m.auto).map(bubble);
    if (P.state === 'thinking') rows.push('<div class="typing-dots"><i></i><i></i><i></i></div>');
    if (P.notice) rows.push(`<div class="small" role="alert" style="color:var(--warning)">${esc(P.notice)}</div>`);
    return rows.join('');
  }

  function composeChips() {
    if (P.state === 'thinking') return '';
    return chipsForStep().map((t, i) => `<button type="button" class="pair-chip" data-action="pair-chip" data-i="${i}">${esc(t)}</button>`).join('');
  }

  function headMiddle() {
    return `<div class="pair-steps" aria-hidden="true">${STEPS.map((_s, i) => `<i class="${i < P.step ? 'done' : i === P.step ? 'now' : ''}"></i>`).join('')}</div>
      <span class="small muted"><span style="color:var(--text)">${esc(STEPS[P.step])}</span> · <span data-no-i18n>${esc(C.t('step {n} of {total}', { n: P.step + 1, total: STEPS.length }))}</span></span>`;
  }

  function resultsHtml() {
    if (P.running) return '<span class="spinner"></span><span>Running the tests…</span>';
    const r = P.run;
    if (!r) return '<span>Run the tests whenever you want · <span class="mono">Ctrl ↵</span></span>';
    if (r.error) return `<span class="warn-text">${esc(r.error)}</span>`;
    if (r.status === 'missing_toolchain') {
      return `<span class="warn-text" data-no-i18n>${esc(C.t('{tool} is not installed on this computer. Install it or pick another language; JavaScript always works.', { tool: r.tool }))}</span>`;
    }
    if (r.status === 'compile') {
      return `<span class="strong" style="color:var(--danger-bright)">Did not compile</span><div class="case-detail"><div class="wide"><div class="case-box bad" data-no-i18n>${esc(r.message || '')}</div></div></div>`;
    }
    const allOk = r.status === 'accepted';
    const label = allOk ? C.t('All passed · {ms} ms', { ms: r.ms }) : C.t('{n} of {total} passed', { n: r.passed, total: r.total });
    const chips = r.cases.map((c, i) => `<button type="button" class="case-chip ${c.ok ? '' : 'bad'} ${P.sel === i ? 'sel' : ''}" data-action="pair-case" data-i="${i}"><span data-no-i18n>${c.ok ? '✓' : '✕'} ${esc(C.t('Case {n}', { n: i + 1 }))}</span></button>`).join('');
    const c = P.sel != null ? r.cases[P.sel] : null;
    const NOTE = { wrong: 'Output differs from the expected value. Walk through the input step by step.', timeout: 'Time limit exceeded.', passed: '' };
    const detail = c ? `<div class="case-detail">
        <div class="wide"><span class="eyebrow">Input</span><div class="case-box" data-no-i18n>${esc(c.input)}</div></div>
        <div><span class="eyebrow">Expected</span><div class="case-box ok" data-no-i18n>${esc(c.expected)}</div></div>
        <div><span class="eyebrow">Your output</span><div class="case-box ${c.ok ? 'ok' : 'bad'}" data-no-i18n>${esc(c.output == null ? c.error || '—' : c.output)}</div></div>
        ${NOTE[c.state] ? `<span class="wide small" style="color:var(--danger-bright)">${esc(NOTE[c.state])}</span>` : ''}
      </div>` : '';
    return `<span class="strong" style="color:${allOk ? 'var(--accent-bright)' : 'var(--danger-bright)'}" data-no-i18n>${esc(label)}</span>${chips}${detail}${r.stdout ? `<div class="case-detail"><div class="wide"><span class="eyebrow">Printed output</span><div class="case-box" data-no-i18n>${esc(r.stdout)}</div></div></div>` : ''}`;
  }

  const GUTTER_MIN_LINES = 120;

  function gutter(code) {
    return Array.from({ length: Math.max(String(code).split('\n').length, GUTTER_MIN_LINES) }, (_v, i) => i + 1).join('\n');
  }

  function clockText() {
    const s = Math.max(0, Math.floor((Date.now() - P.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function doneHtml() {
    if (P.finishing) {
      const pro = withOrby();
      return `<div class="pair-done"><div class="card aurora pair-done-card" style="align-items:center;text-align:center">${pro ? C.orb('thinking', 120, 'tight') : '<span class="spinner"></span>'}<span class="strong">${pro ? 'Orby is reviewing your interview…' : 'Saving your practice…'}</span></div></div>`;
    }
    const d = P.done;
    if (!d) return '';
    const pro = withOrby();
    const ev = pro ? d.evaluation : null;
    const r = P.run;
    const tests = r && r.total ? C.t('{n} of {total} passed', { n: r.passed, total: r.total }) : r && r.status === 'compile' ? C.t('Did not compile') : C.t('No test run');
    const meta = `${d.clock} · ${langInfo().name} · ${C.t(P.problem.difficulty)} · ${tests}`;
    return `<div class="pair-done"><div class="card aurora pair-done-card">
      <div class="row" style="gap:18px">
        ${pro ? C.orb(ev && (ev.signal === 'Strong yes' || ev.signal === 'Yes') ? 'happy' : 'idle', 96, 'tight') : ''}
        <div class="stack grow" style="gap:4px;min-width:0">
          <span class="eyebrow on-aurora" data-no-i18n>${esc(`${C.t(pro ? 'Feedback' : 'Solo practice')} · ${P.problem.title}`)}</span>
          <span style="font-size:22px;line-height:1.2;font-weight:600;letter-spacing:-.02em" data-no-i18n>${esc(ev ? C.t('Hiring signal: {signal}', { signal: C.t(ev.signal) }) : C.t(d.ok ? 'Session saved' : 'Could not save this session.'))}</span>
          <span class="on-aurora-soft" style="font-size:13px" data-no-i18n>${esc(meta)}</span>
        </div>
        ${ev ? `<span class="mono" style="font-size:34px;font-weight:600;letter-spacing:-.03em">${ev.score.toFixed(1)}</span>` : ''}
      </div>
      ${ev ? `<div class="pair-scores">${SCORES.map(([k, label]) => {
        const v = ev.criteria[k];
        const tone = v >= 7 ? '' : v >= 5 ? 'tone-warn' : 'tone-bad';
        return `<div class="pair-score"><span>${label}</span><div class="bar6"><i class="${tone}" style="width:${v * 10}%"></i></div><span class="score-num">${v.toFixed(1)}</span></div>`;
      }).join('')}</div>
      <div class="stack" style="gap:6px;font-size:13px;line-height:1.5" data-no-i18n>
        ${ev.strengths.map((t) => `<div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--accent-bright)">✓</span><span>${esc(t)}</span></div>`).join('')}
        ${ev.improve.map((t) => `<div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--warning)">↗</span><span>${esc(t)}</span></div>`).join('')}
      </div>` : pro && d.note ? `<span class="on-aurora-soft">${esc(d.note)}</span>` : ''}
      <div class="row" style="gap:8px">
        <button type="button" class="btn primary lg grow" data-action="pair-random">Next problem</button>
        <button type="button" class="btn glass lg" data-action="pair-leave">Back to the list</button>
      </div>
    </div></div>`;
  }

  function liveView() {
    const p = P.problem;
    const ext = langInfo().ext;
    const pro = withOrby();
    return `<div class="pair-live" id="pairLive">
      <div class="pair-head">
        <div class="row" style="gap:10px;min-width:0">
          <button type="button" class="btn ghost icon-only" data-action="pair-leave" aria-label="Back to the list" title="Back to the list">${icon('arrow-left')}</button>
          <span class="strong truncate" data-no-i18n>${esc(p.title)}</span>
          ${diffLabel(p.difficulty, 'dot-only')}
        </div>
        ${pro ? `<div class="stack" style="align-items:center;gap:6px" id="pairHeadMid">${headMiddle()}</div>` : '<span class="small muted">Solo practice</span>'}
        <div class="row" style="justify-content:flex-end;gap:12px">
          <span class="row mono small" style="gap:6px"><span class="dot danger"></span><span id="pairClock">${clockText()}</span></span>
          <button type="button" class="btn sm" data-action="pair-finish" id="pairEndBtn" ${P.running ? 'disabled' : ''}>End</button>
        </div>
      </div>
      <div class="pair-body${pro ? '' : ' solo'}">
        <div class="pair-desc">
          <span class="small faint"><span data-no-i18n>${esc(p.topic)}</span><span> · </span><span>${esc(p.difficulty)}</span></span>
          <p>${esc(p.description)}</p>
          ${p.examples.map((e, i) => `<div class="stack" style="gap:6px"><span class="small muted" data-no-i18n>${esc(C.t('Example {n}', { n: i + 1 }))}</span><div class="pair-ex" data-no-i18n>${esc(e.input)}<br><span class="faint">→</span> <span class="out">${esc(e.output)}</span></div></div>`).join('')}
          <div class="stack" style="gap:4px"><span class="small muted">Constraints</span>${p.constraints.map((c) => `<span class="pair-cons">${esc(c)}</span>`).join('')}</div>
        </div>
        <div class="pair-editor" data-tour="pair-editor">
          <div class="pair-editor-bar">
            <span class="mono small muted" data-no-i18n>solution.${esc(ext)}</span>
            <span class="grow"></span>
            <button type="button" class="btn ghost icon-only sm" data-action="pair-reset" aria-label="Reset code" title="Reset code">${icon('refresh')}</button>
            <button type="button" class="btn primary sm" data-action="pair-run" id="pairRunBtn" ${P.running ? 'disabled' : ''}>${icon('play')}Run tests</button>
          </div>
          <div class="pair-code">
            <div class="pair-gutter" id="pairGutter" aria-hidden="true">${gutter(P.code)}</div>
            <textarea id="pairEditor" data-input="pair-code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Code editor">${esc(P.code)}</textarea>
          </div>
          <div class="pair-results" id="pairResults">${resultsHtml()}</div>
        </div>
        ${pro ? `<div class="pair-chat" data-tour="pair-chat">
          <div class="pair-orb">${C.orb(P.state, 120, 'tight')}<span class="small muted" id="pairState">${esc(STATE_LABEL[P.state] || '')}</span></div>
          <div class="pair-msgs" id="pairMsgs">${msgsHtml()}</div>
          <div class="pair-compose">
            <div class="stack" style="gap:6px" id="pairChips">${composeChips()}</div>
            <div class="pair-draft"><input id="pairDraft" placeholder="Type your answer" value="${esc(P.draft)}" data-input="pair-draft"/><button type="button" class="btn primary icon-only sm" data-action="pair-send" aria-label="Send" title="Send">${icon('send')}</button></div>
          </div>
        </div>` : ''}
      </div>
      <div id="pairDone">${doneHtml()}</div>
    </div>`;
  }

  // --------------------------------------------------------------- paint --
  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
    return el;
  }

  function paintChat() {
    const box = setHtml('pairMsgs', msgsHtml());
    if (box) box.scrollTop = box.scrollHeight;
    setHtml('pairChips', composeChips());
    C.setOrbState(P.state, document.querySelector('.pair-orb') || document);
    const st = document.getElementById('pairState');
    if (st) st.textContent = C.t(STATE_LABEL[P.state] || '');
  }

  function paintHead() {
    setHtml('pairHeadMid', headMiddle());
  }

  function paintResults() {
    setHtml('pairResults', resultsHtml());
    for (const id of ['pairRunBtn', 'pairEndBtn']) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = P.running;
    }
  }

  function paintDone() {
    setHtml('pairDone', doneHtml());
    C.startOrbs();
  }

  // ---------------------------------------------------------------- orby --
  function payload(extra) {
    return {
      problemId: P.problem.id, language: P.language, style: P.style, hints: P.hints, step: P.step, code: P.code,
      run: P.run && !P.run.error ? P.run : null, replyLanguage: replyLanguage(),
      messages: P.messages.map((m) => ({ role: m.role, text: m.text })),
      ...extra
    };
  }

  async function askOrby(opening) {
    if (!withOrby() || P.finishing || P.done || P.state === 'thinking') return;
    const sessionId = P.sessionId;
    P.state = 'thinking';
    P.notice = '';
    paintChat();
    const res = await C.guard(() => api.pairChat(payload({ opening })), 'Orby could not answer right now. Try again.');
    if (P.sessionId !== sessionId || P.finishing || P.done || !withOrby()) return;
    clearTimeout(speakTimer);
    if (res?.code === 'pair_pro_required') {
      switchToSolo();
      return;
    }
    if (!res || !res.ok) {
      P.state = 'idle';
      P.notice = (res && res.error) || '';
      paintChat();
      return;
    }
    P.messages.push({ role: 'assistant', text: res.reply });
    P.step = Math.max(P.step, res.step || 0);
    P.state = 'speaking';
    paintChat();
    paintHead();
    speakTimer = setTimeout(() => {
      if (P.sessionId !== sessionId || !withOrby()) return;
      P.state = 'listening';
      paintChat();
    }, Math.min(5000, 1200 + res.reply.length * 30));
  }

  function say(text) {
    const t = String(text || '').trim();
    if (!t || !withOrby() || !P.problem || P.finishing || P.done || P.state === 'thinking') return;
    P.messages.push({ role: 'user', text: t });
    P.draft = '';
    const input = document.getElementById('pairDraft');
    if (input) input.value = '';
    askOrby(false);
  }

  function startSession(id) {
    const problem = P.catalog && P.catalog.problems.find((p) => p.id === id);
    if (!problem) return;
    clearTimeout(speakTimer);
    P.sessionId += 1;
    P.orbyAccount = proAccount();
    P.problem = problem;
    P.code = P.drafts[draftKey()] || problem.starters[P.language];
    Object.assign(P, { messages: [], step: 0, draft: '', state: 'idle', run: null, runs: 0, sel: null, startedAt: Date.now(), finishing: false, done: null, notice: '', editorFocused: false, selStart: 0, selEnd: 0, editorTop: 0 });
    C.refresh();
    askOrby(true);
  }

  async function runTests() {
    if (!P.problem || P.running || P.finishing || P.done) return;
    const problem = P.problem;
    const sessionId = P.sessionId;
    P.running = true;
    P.sel = null;
    paintResults();
    const res = await C.guard(() => api.pairRun({ problemId: problem.id, language: P.language, code: P.code }), 'Could not run the tests.');
    P.running = false;
    if (P.sessionId !== sessionId) {
      paintResults();
      return;
    }
    if (!res || !res.ok) {
      P.run = { error: (res && res.error) || C.t('Could not run the tests.') };
      paintResults();
      return;
    }
    P.run = res.result;
    if (P.run.status === 'missing_toolchain') {
      paintResults();
      return;
    }
    P.runs += 1;
    const firstBad = (P.run.cases || []).findIndex((c) => !c.ok);
    P.sel = firstBad >= 0 ? firstBad : null;
    P.step = Math.max(P.step, P.run.status === 'accepted' ? 4 : 3);
    paintResults();
    paintHead();
    if (withOrby() && P.state !== 'thinking') {
      P.messages.push({ role: 'user', text: '(The candidate just ran the tests.)', auto: true });
      askOrby(false);
    }
    await reloadHistory();
  }

  function clearOrby() {
    clearTimeout(speakTimer);
    Object.assign(P, { orbyAccount: '', messages: [], draft: '', state: 'idle', notice: '' });
  }

  function switchToSolo() {
    clearOrby();
    C.refresh();
    C.authRefresh(true);
  }

  async function finish() {
    if (!P.problem || P.running || P.finishing || P.done) return;
    clearTimeout(speakTimer);
    P.finishing = true;
    P.state = 'idle';
    const clock = clockText();
    const durationS = Math.round((Date.now() - P.startedAt) / 1000);
    const sessionId = P.sessionId;
    const practice = { problemId: P.problem.id, language: P.language, durationS, testRuns: P.runs, run: P.run };
    paintDone();
    const res = await C.guard(() => api.pairFinish(withOrby() ? payload({
      ...practice, withOrby: true,
      messages: P.messages.filter((m) => !m.auto).map((m) => ({ role: m.role, text: m.text }))
    }) : practice), 'Could not save this session.');
    if (P.sessionId !== sessionId) return;
    P.finishing = false;
    P.done = { clock, ok: res?.ok, evaluation: res?.evaluation, note: res?.note };
    clearInterval(clockTimer);
    if (res?.code === 'pair_pro_required') switchToSolo();
    else paintDone();
    await reloadHistory();
  }

  function leave() {
    clearTimeout(speakTimer);
    P.sessionId += 1;
    Object.assign(P, { problem: null, messages: [], state: 'idle', done: null, finishing: false, run: null, notice: '' });
    C.refresh();
  }

  // ------------------------------------------------------------- actions --
  C.actions['pair-opt'] = (el) => {
    P[el.dataset.opt] = el.dataset.value;
    C.refresh();
  };
  C.actions['pair-start'] = (el) => startSession(el.dataset.id);
  C.actions['pair-random'] = () => {
    if (!P.catalog) return;
    const solved = solvedIds();
    const open = P.catalog.problems.filter((p) => !solved.has(p.id) && (!P.problem || p.id !== P.problem.id));
    const pool = open.length ? open : P.catalog.problems.filter((p) => !P.problem || p.id !== P.problem.id);
    startSession(pool[Math.floor(Math.random() * pool.length)].id);
  };
  C.actions['pair-leave'] = () => leave();
  C.actions['pair-finish'] = () => finish();
  C.actions['pair-run'] = () => runTests();
  C.actions['pair-send'] = () => say(P.draft);
  C.actions['pair-chip'] = (el) => {
    const chip = chipsForStep()[Number(el.dataset.i)];
    if (chip) say(C.t(chip));
  };
  C.actions['pair-case'] = (el) => {
    const i = Number(el.dataset.i);
    P.sel = P.sel === i ? null : i;
    paintResults();
  };
  C.actions['pair-reset'] = () => {
    P.code = P.problem.starters[P.language];
    P.drafts[draftKey()] = P.code;
    P.run = null;
    P.sel = null;
    C.refresh();
  };
  C.inputs['pair-code'] = (el) => {
    P.code = el.value;
    P.drafts[draftKey()] = el.value;
    const g = document.getElementById('pairGutter');
    if (g) g.textContent = gutter(el.value);
  };
  C.inputs['pair-draft'] = (el) => {
    P.draft = el.value;
  };

  C.views.pair = () => (P.problem ? liveView() : pickerView());

  C.afterRender.pair = () => {
    if (P.orbyAccount && !withOrby()) clearOrby();
    if (!P.catalog || P.catalogPro !== Boolean(proAccount())) load();
    C.startOrbs();
    if (!P.problem) {
      clearInterval(clockTimer);
      return;
    }
    const box = document.getElementById('pairMsgs');
    if (box) box.scrollTop = box.scrollHeight;
    const draft = document.getElementById('pairDraft');
    if (draft) {
      draft.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          say(P.draft);
        }
      });
    }
    const editor = document.getElementById('pairEditor');
    if (editor) {
      const gutterEl = document.getElementById('pairGutter');
      const remember = () => {
        P.selStart = editor.selectionStart;
        P.selEnd = editor.selectionEnd;
        P.editorTop = editor.scrollTop;
      };
      editor.addEventListener('scroll', () => {
        if (gutterEl) gutterEl.scrollTop = editor.scrollTop;
        P.editorTop = editor.scrollTop;
      });
      editor.addEventListener('focus', () => { P.editorFocused = true; });
      editor.addEventListener('blur', () => { if (editor.isConnected) P.editorFocused = false; });
      for (const ev of ['keyup', 'click', 'input']) editor.addEventListener(ev, remember);
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          runTests();
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const { selectionStart: a, selectionEnd: b, value } = editor;
          editor.value = `${value.slice(0, a)}    ${value.slice(b)}`;
          editor.selectionStart = editor.selectionEnd = a + 4;
          C.inputs['pair-code'](editor);
          remember();
        }
      });
      // A re-render of the page must not cost the cursor or the scroll position.
      editor.scrollTop = P.editorTop;
      if (gutterEl) gutterEl.scrollTop = P.editorTop;
      if (P.editorFocused) {
        editor.focus();
        editor.setSelectionRange(P.selStart, P.selEnd);
      }
    }
    clearInterval(clockTimer);
    if (!P.done && !P.finishing) {
      clockTimer = setInterval(() => {
        const el = document.getElementById('pairClock');
        if (!el) {
          clearInterval(clockTimer);
          return;
        }
        el.textContent = clockText();
      }, 1000);
    }
  };
})();
