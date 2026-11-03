// Cue dashboard — live view. Mirrors the engine's protocol events
// (server_protocol.hpp): transcript, streaming answers, audio levels and
// notices; sends commands back (answer, chat, recap, follow-up, pause, rate).
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon, fixText, plural } = C;

  const REASON = {
    auto: 'Automatic',
    manual: 'Manual',
    chat: 'Chat',
    recap: 'Recap',
    followup: 'Follow-up',
    follow_up: 'Follow-up',
    screenshot: 'Screen',
    keyword: 'Keyword',
    question: 'Question'
  };

  function fresh(agentId) {
    return {
      agentId: agentId || '',
      hello: null,
      link: { voce: '', outros: '' },
      levels: { voce: 0, outros: 0, voce_speaking: false, outros_speaking: false },
      transcript: [],
      transcriptRev: 0,
      partial: { voce: '', outros: '' },
      answers: [],
      cur: -1,
      notices: [],
      paused: { voce: false, outros: false },
      transcriptionOnly: false,
      ended: false
    };
  }
  S.live = fresh('');

  C.liveReset = (agentId) => {
    const keepMode = S.live.transcriptionOnly;
    S.live = fresh(agentId);
    S.live.transcriptionOnly = keepMode;
  };

  // ------------------------------------------------------------ events --
  let dirty = new Set();
  let raf = 0;
  function mark(part) {
    dirty.add(part);
    if (raf) return;
    raf = requestAnimationFrame(flush);
  }

  function flush() {
    raf = 0;
    const parts = dirty;
    dirty = new Set();
    if (S.route.view !== 'live') return;
    if (parts.has('all')) {
      C.refresh();
      return;
    }
    if (parts.has('levels')) paintLevels();
    if (parts.has('transcript')) paintTranscript();
    if (parts.has('answer')) {
      paint('liveAnswer', answerHtml(), false);
      paint('liveAnswerNav', answerNavHtml(), false);
      paint('liveFoot', footHtml(), false);
    }
    if (parts.has('notices')) paint('liveNotices', noticesHtml(), false);
  }

  function paint(id, html, stickBottom) {
    const el = document.getElementById(id);
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = html;
    if (stickBottom && atBottom) el.scrollTop = el.scrollHeight;
  }

  // Interim results arrive many times per second while someone talks; only the
  // partial bubbles change then, so the committed turns are not re-rendered.
  function paintTranscript() {
    const el = document.getElementById('liveTranscript');
    if (!el) return;
    const L = S.live;
    const live = el.querySelector('.live-partials');
    if (live && el.dataset.rev === String(L.transcriptRev)) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      live.innerHTML = partialsHtml();
      if (atBottom) el.scrollTop = el.scrollHeight;
      return;
    }
    paint('liveTranscript', transcriptHtml(), true);
    el.dataset.rev = String(L.transcriptRev);
  }

  C.liveOnEvent = (msg) => {
    const L = S.live;
    switch (msg.type) {
      case 'hello':
        L.hello = msg;
        if (msg.mode !== undefined) L.transcriptionOnly = Boolean(msg.mode);
        // The server refused the session: expired sign-in (locks the app
        // again), plan without minutes, or server down.
        if (msg.ready === false && msg.needs === 'login') {
          C.toast('Your session expired. Sign in to your account again.', 'error');
          if (C.authRefresh) C.authRefresh(true);
        } else if (msg.ready === false && msg.needs === 'upgrade') {
          C.toast('Your plan has no minutes left. Upgrade to PRO to continue.', 'error');
          if (C.authRefresh) C.authRefresh(true).then(() => C.navigate('settings/plan'));
        } else if (msg.ready === false && msg.needs === 'server') {
          C.toast('Cue server unavailable. Try again in a moment.', 'error');
        }
        if (S.ui.pendingChat) {
          const text = S.ui.pendingChat;
          S.ui.pendingChat = '';
          setTimeout(() => api.overlayCommand({ cmd: 'chat', text }), 1500);
        }
        mark('all');
        break;
      case 'status':
        L.link[msg.src] = msg.state || '';
        mark('all');
        break;
      case 'live':
        L.partial[msg.src] = fixText(msg.text || '');
        mark('transcript');
        break;
      case 'turn':
        L.partial[msg.src] = '';
        if (String(msg.text || '').trim()) L.transcript.push({ src: msg.src, text: fixText(msg.text), t: Number(msg.start) || 0 });
        if (L.transcript.length > 400) L.transcript.splice(0, L.transcript.length - 400);
        L.transcriptRev++;
        mark('transcript');
        break;
      case 'answer_start': {
        L.answers.push({
          id: msg.id,
          trigger: fixText(msg.trigger || ''),
          src: msg.src,
          reason: msg.reason || '',
          model: msg.model || '',
          image: Boolean(msg.image),
          text: '',
          status: 'streaming',
          ttft: null,
          total: null,
          understood: '',
          vote: 0
        });
        if (L.cur === -1 || L.cur === L.answers.length - 2) L.cur = -1;
        mark('answer');
        break;
      }
      case 'answer_delta': {
        const a = L.answers.find((x) => x.id === msg.id);
        if (a) {
          a.text += msg.text || '';
          mark('answer');
        }
        break;
      }
      case 'answer_done': {
        const a = L.answers.find((x) => x.id === msg.id);
        if (a) {
          a.status = msg.status || 'completed';
          if (msg.text) a.text = msg.text;
          a.ttft = Number(msg.ttft) || null;
          a.total = Number(msg.total) || null;
          a.understood = fixText(msg.understood || '');
          a.error = msg.error || '';
          mark('answer');
        }
        break;
      }
      case 'notice':
        L.notices.push({ level: msg.level || 'info', text: fixText(msg.text || ''), at: Date.now() });
        if (L.notices.length > 40) L.notices.shift();
        if (msg.level === 'error') C.toast(fixText(msg.text || ''), 'error');
        if (S.ui.liveTab === 'notices') mark('answer');
        break;
      case 'pause':
        if (msg.src === 'all') L.paused = { voce: Boolean(msg.paused), outros: Boolean(msg.paused) };
        else L.paused[msg.src] = Boolean(msg.paused);
        mark('all');
        break;
      case 'level':
        L.levels = msg;
        mark('levels');
        break;
      case 'bye':
        L.ended = true;
        mark('all');
        break;
      default:
        break;
    }
  };

  C.liveOnMode = (on) => {
    S.live.transcriptionOnly = on;
    if (S.route.view === 'live') mark('all');
  };

  C.liveOnStatus = (st) => {
    if (st.running && S.live.ended) C.liveReset(st.agentId);
    if (st.running && !S.live.agentId) S.live.agentId = st.agentId || '';
    if (S.route.view === 'live') mark('all');
  };

  C.liveLeave = () => {};

  // ---------------------------------------------------------- painting --
  function bars(level, on) {
    const v = C.clamp(Number(level) || 0, 0, 1);
    const shape = [0.45, 0.75, 1, 0.7, 0.4];
    return shape.map((k) => `<span style="height:${Math.max(18, Math.round(v * k * 100))}%"></span>`).join('');
  }

  function paintLevels() {
    const L = S.live.levels || {};
    for (const src of ['voce', 'outros']) {
      const el = document.getElementById(`lvl-${src}`);
      if (!el) continue;
      const speaking = Boolean(L[`${src}_speaking`]);
      el.classList.toggle('on', speaking);
      const spans = el.children;
      const v = C.clamp(Number(L[src]) || 0, 0, 1);
      const shape = [0.45, 0.75, 1, 0.7, 0.4];
      for (let i = 0; i < spans.length; i++) spans[i].style.height = `${Math.max(18, Math.round(v * shape[i] * 100))}%`;
    }
  }

  function transcriptHtml() {
    const L = S.live;
    const items = L.transcript.slice(-120);
    const partials = partialsHtml();
    if (!items.length && !partials) {
      return `<div class="empty" style="padding:48px 0">${icon('microphone')}<span>${S.overlayStatus.running ? 'Listening… speech shows up here.' : 'Start listening to transcribe.'}</span></div>`;
    }
    return items.map((t) => bubble(t.src, t.text, C.fmtClock(t.t), false)).join('') +
      `<div class="live-partials" style="display:contents">${partials}</div>`;
  }

  function partialsHtml() {
    const L = S.live;
    return ['outros', 'voce'].filter((src) => L.partial[src]).map((src) => bubble(src, L.partial[src], '', true)).join('');
  }

  function bubble(src, text, time, partial) {
    const you = src === 'voce';
    return `<div class="bubble ${you ? 'you' : ''} ${partial ? 'partial' : ''}">
      <span class="meta"><span class="who">${you ? 'You' : 'Interviewer'}</span>${time ? `<span class="num" style="color:var(--text-faint)">${time}</span>` : ''}</span>
      <span class="txt">${esc(text)}</span>
    </div>`;
  }

  function currentAnswer() {
    const L = S.live;
    if (!L.answers.length) return null;
    const idx = L.cur === -1 ? L.answers.length - 1 : C.clamp(L.cur, 0, L.answers.length - 1);
    return { a: L.answers[idx], idx };
  }

  function answerNavHtml() {
    const L = S.live;
    if (!L.answers.length) return '<span class="num">No answers yet</span>';
    const { idx } = currentAnswer();
    return `<button type="button" class="icon-btn" data-action="live-prev" ${idx === 0 ? 'disabled' : ''} title="Previous">${icon('caret-left')}</button>
      <span class="num">${idx + 1} / ${L.answers.length}</span>
      <button type="button" class="icon-btn" data-action="live-next" ${idx === L.answers.length - 1 ? 'disabled' : ''} title="Next">${icon('caret-right')}</button>`;
  }

  function answerHtml() {
    const L = S.live;
    const running = S.overlayStatus.running;
    const tab = S.ui.liveTab;
    if (tab === 'history') {
      if (!L.answers.length) return `<div class="empty">${icon('scroll')}<span>This session's answers are listed here.</span></div>`;
      const { idx } = currentAnswer();
      return `<div class="answer-history">${L.answers
        .map((a, i) => `<button type="button" class="${i === idx ? 'active' : ''}" data-action="live-pick" data-idx="${i}"><span class="row between"><span class="eyebrow">${esc(REASON[a.reason] || a.reason || 'Answer')}</span><span class="num">${a.ttft ? `${a.ttft} ms` : a.status === 'streaming' ? 'generating…' : ''}</span></span><span class="truncate" style="font-size:13px">${esc(a.trigger || a.understood || 'Suggested answer')}</span></button>`)
        .join('')}</div>`;
    }
    if (tab === 'notices') {
      return `<div class="stack gap-4">${noticesHtml()}</div>`;
    }
    const cur = currentAnswer();
    if (!cur) {
      if (!running) return idlePanel();
      return `<div class="empty" style="padding:64px 20px">${icon('sparkle')}<span class="t">${L.transcriptionOnly ? 'Transcription-only mode' : 'Waiting for the next question'}</span><span>${L.transcriptionOnly ? 'The copilot transcribes without suggesting answers. Turn the mode off to get suggestions again.' : 'When the interviewer asks a question, the suggested answer shows up here. Use “Answer now” to ask for one right away.'}</span>${running && !L.transcriptionOnly ? `<button type="button" class="btn" data-action="live-cmd" data-cmd="answer">${icon('lightning')}Answer now</button>` : ''}</div>`;
    }
    const a = cur.a;
    const statusPill =
      a.status === 'streaming'
        ? '<span class="pill warn"><span class="dot"></span>Generating</span>'
        : a.status === 'completed'
          ? '<span class="pill ok"><span class="dot"></span>Ready</span>'
          : `<span class="pill danger"><span class="dot"></span>${esc(a.status === 'interrupted' ? 'Interrupted' : 'Failed')}</span>`;
    return `<div class="stack gap-8">
        <div class="row"><span class="eyebrow">Question</span><span class="tag">${esc(REASON[a.reason] || a.reason || 'Auto')}</span>${a.image ? `<span class="tag">${icon('camera')} screen</span>` : ''}</div>
        <span class="answer-q">${esc(a.trigger || a.understood || '—')}</span>
        ${a.understood && a.understood !== a.trigger ? `<span class="small faint">Understood as: ${esc(a.understood)}</span>` : ''}
      </div>
      <div class="stack" style="gap:12px">
        <div class="row"><span class="eyebrow">Suggested answer</span>${statusPill}</div>
        <div class="answer-body md ${a.status === 'streaming' ? 'streaming' : ''}">${a.text ? C.md(a.text) : a.status === 'streaming' ? '' : `<span class="faint">${esc(a.error || 'No text.')}</span>`}</div>
      </div>`;
  }

  function idlePanel() {
    const agents = S.agents.filter((a) => !a.archived);
    const a = C.agentById(S.activeAgentId) || C.activeAgent();
    const ready = C.engineReady();
    const cfg = S.config || {};
    const checks = [
      ['Transcription (Deepgram)', ready.stt, 'settings/ai'],
      ['AI model', ready.llm, 'settings/ai'],
      ['Microphone (you)', cfg.mic_enabled !== false, 'settings/audio'],
      ['System audio (interviewer)', cfg.loopback_enabled !== false, 'settings/audio']
    ];
    return `<div class="stack gap-24" data-tour="live-start">
      <div class="stack gap-4"><span class="eyebrow">Ready to start</span><span class="answer-q">Open the call and start the copilot.</span><span class="muted" style="font-size:13.5px">The floating panel (HUD) appears over the meeting; this screen mirrors the transcript and answers in real time.</span></div>
      ${agents.length
        ? `<label class="field">Session<select class="select" data-change="live-agent">${C.opts(agents.map((x) => [x.id, C.agentTitle(x)]), a ? a.id : '')}</select></label>
           <div class="row wrap"><button type="button" class="btn primary lg" data-action="start-copilot" data-agent="${esc(a ? a.id : '')}">${icon('play')}Go live</button></div>`
        : `<div class="row"><button type="button" class="btn primary lg" data-action="new-session">${icon('plus')}Create session</button></div>`}
      <div class="inset" style="gap:0" data-tour="live-checks">${checks
        .map(([label, ok, to]) => `<div class="check-item ${ok ? 'done' : ''}"><span class="mark">${icon('check')}</span><span class="label grow">${esc(label)}</span>${ok ? '<span class="num">ok</span>' : `<a class="small" data-action="go" data-to="${to}">Set up</a>`}</div>`)
        .join('')}</div>
      <div class="stack gap-8" data-tour="live-shortcuts"><span class="eyebrow">HUD shortcuts</span><div class="row wrap" style="gap:6px">
        ${[['Ctrl Alt Enter', 'answer'], ['Ctrl Alt M', 'transcription only'], ['Ctrl Alt H', 'hide'], ['Ctrl Alt Q', 'stop']].map(([k, l]) => `<span class="chip"><span class="kbd">${k}</span>${l}</span>`).join('')}
        <a class="small muted" data-action="go" data-to="settings/shortcuts">All shortcuts →</a></div></div>
    </div>`;
  }

  function noticesHtml() {
    const list = S.live.notices.slice(-12).reverse();
    if (!list.length) return '<span class="small faint">No engine notices.</span>';
    return list
      .map((n) => `<div class="notice-line ${esc(n.level)}">${icon(n.level === 'error' ? 'warning' : n.level === 'warning' ? 'warning' : 'info')}<span>${esc(n.text)}</span></div>`)
      .join('');
  }

  function footHtml() {
    const cur = currentAnswer();
    const running = S.overlayStatus.running;
    const a = cur && cur.a;
    return `<span>${a ? `Answer · ${esc((REASON[a.reason] || a.reason || 'auto').toLowerCase())}` : 'Answer'}</span><span class="vsep">|</span><span>${a && a.ttft ? `${a.ttft} ms` : '—'}</span>${a && a.model ? `<span class="vsep">|</span><span>${esc(C.modelLabel(a.model))}</span>` : ''}
      <div class="actions">
        <button type="button" class="icon-btn ${a && a.vote > 0 ? 'on' : ''}" data-action="live-rate" data-vote="1" title="Good answer" ${!a || !running ? 'disabled' : ''}>${icon('thumbs-up')}</button>
        <button type="button" class="icon-btn ${a && a.vote < 0 ? 'on' : ''}" data-action="live-rate" data-vote="-1" title="Bad answer" ${!a || !running ? 'disabled' : ''}>${icon('thumbs-down')}</button>
        <button type="button" class="btn sm raised" data-action="live-cmd" data-cmd="recap" ${!running ? 'disabled' : ''} title="Recap of the conversation so far">${icon('scroll')}Recap</button>
        <button type="button" class="btn sm raised" data-action="live-cmd" data-cmd="followup" ${!running ? 'disabled' : ''} title="Suggest a follow-up question">${icon('chat')}Follow-up</button>
        <button type="button" class="btn sm raised" data-action="live-cmd" data-cmd="answer" ${!running ? 'disabled' : ''} title="Generate an answer now (Ctrl+Alt+Enter)">${icon('refresh')}Answer now</button>
      </div>`;
  }

  C.views.live = function live() {
    const L = S.live;
    const running = S.overlayStatus.running;
    const a = C.agentById(running ? S.overlayStatus.agentId || L.agentId : S.activeAgentId) || C.activeAgent();
    const docs = (a && a.documents) || [];
    const since = running && S.overlayStatus.startedAt ? C.fmtClock(Date.now() - S.overlayStatus.startedAt) : '00:00';
    const linkOk = (src) => /connected|ok|streaming|live/i.test(L.link[src] || '') || (running && L.levels && L.levels[`${src}_active`]);
    const src = (key, label, ic) => {
      const paused = L.paused[key];
      return `<button type="button" class="chip btn-chip" data-action="live-pause" data-src="${key}" ${!running ? 'disabled' : ''} title="${paused ? 'Resume' : 'Pause'} ${label.toLowerCase()}">
        <span class="level-bars" id="lvl-${key}">${bars(0)}</span>${icon(paused ? (key === 'voce' ? 'microphone-slash' : 'speaker-slash') : ic)}${label}${paused ? ' · paused' : running && !linkOk(key) ? ' · connecting' : ''}</button>`;
    };
    const tabs = [
      ['answer', 'Answer'],
      ['history', `History${L.answers.length ? ` ${L.answers.length}` : ''}`],
      ['notices', 'Notices']
    ];

    return `<div class="page wide" style="padding:20px 24px 24px;gap:12px">
      <div class="live-grid">
        <div class="live-col">
          <div class="live-bar">
            <span class="dot ${running ? 'danger live' : 'off'}"></span>
            <span class="mono" style="font-size:12px" id="liveClock">${since}</span>
            <span class="small faint truncate">${running ? 'Live' : L.ended ? 'Session ended' : 'Stopped'}</span>
            ${running
              ? `<button type="button" class="btn sm danger ml-auto" data-action="stop-copilot">${icon('stop')}Stop</button>`
              : `<button type="button" class="btn sm primary ml-auto" data-action="start-copilot" data-agent="${esc(a ? a.id : '')}" ${a ? '' : 'disabled'}>${icon('play')}Start listening</button>`}
          </div>
          <div class="row wrap" style="padding:10px 16px 0;gap:6px">${src('outros', 'Interviewer', 'speaker')}${src('voce', 'You', 'microphone')}</div>
          <div class="row between" style="padding:12px 16px 4px"><span class="eyebrow">Live transcript</span><span class="eyebrow">${plural(L.transcript.length, 'turn', 'turns')}</span></div>
          <div class="live-scroll" id="liveTranscript" data-tour="live-transcript">${transcriptHtml()}</div>
          <div class="live-ctx">
            <div class="row between"><span class="eyebrow">Context</span>${a ? `<a class="small muted" data-action="go" data-to="session/${esc(a.id)}">Edit</a>` : ''}</div>
            ${a
              ? `<div class="kv" style="font-size:12px;gap:10px"><div><span class="k">Role</span><span class="strong truncate" style="font-family:var(--font-sans);font-size:12.5px">${esc(C.agentRole(a) || '—')}</span></div><div><span class="k">Company</span><span class="strong truncate" style="font-family:var(--font-sans);font-size:12.5px">${esc(C.agentCompany(a) || '—')}</span></div></div>
                 <div class="row wrap" style="gap:6px">${docs.length ? docs.slice(0, 6).map((d) => `<span class="chip">${icon(C.docIcon(d))}<span class="truncate">${esc(fixText(d.title || d.name))}</span></span>`).join('') : '<span class="xs faint">No files: the copilot answers from the job description only.</span>'}${docs.length > 6 ? `<span class="xs faint">+${docs.length - 6}</span>` : ''}</div>`
              : '<span class="small faint">No session selected.</span>'}
          </div>
        </div>

        <div class="live-col">
          <div class="live-bar">
            <div class="segmented sm">${tabs.map(([id, label]) => `<button type="button" class="${S.ui.liveTab === id ? 'active' : ''}" data-action="live-tab" data-tab="${id}">${esc(label)}</button>`).join('')}</div>
            <label class="row small muted ml-auto" style="cursor:pointer" title="Ctrl+Alt+M in the HUD">${C.sw(`data-change="live-mode" ${running ? '' : 'disabled'}`, L.transcriptionOnly, !running)}Transcription only</label>
            <span class="row" style="gap:2px" id="liveAnswerNav">${answerNavHtml()}</span>
          </div>
          <div class="answer-pane" id="liveAnswer" data-tour="live-answer">${answerHtml()}</div>
          ${S.ui.liveTab === 'answer' ? '' : ''}
          <div class="live-foot" id="liveFoot">${footHtml()}</div>
          <div class="chat-row">
            <input class="input" id="liveChat" placeholder="${running ? 'Ask the copilot (e.g. how do I explain this project?)' : 'Start the copilot to chat'}" ${running ? '' : 'disabled'} data-input="noop"/>
            <button type="button" class="btn primary" data-action="live-chat" ${running ? '' : 'disabled'}>${icon('send')}Send</button>
          </div>
          <div id="liveNotices" hidden></div>
        </div>
      </div>
    </div>`;
  };

  C.afterRender.live = () => {
    const box = document.getElementById('liveTranscript');
    if (box) box.scrollTop = box.scrollHeight;
    paintLevels();
    const chat = document.getElementById('liveChat');
    if (chat) {
      chat.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          C.actions['live-chat']();
        }
      });
    }
  };

  C.inputs.noop = () => {};

  // Clock tick on the live page.
  setInterval(() => {
    if (S.route.view !== 'live' || !S.overlayStatus.running) return;
    const el = document.getElementById('liveClock');
    if (el && S.overlayStatus.startedAt) el.textContent = C.fmtClock(Date.now() - S.overlayStatus.startedAt);
  }, 1000);

  // ----------------------------------------------------------- actions --
  async function send(command, okMsg) {
    const res = await C.guard(() => api.overlayCommand(command), 'The copilot did not receive the command.');
    if (res && res.ok === false) C.toast(res.error || 'Command refused.', 'error');
    else if (res && okMsg) C.toast(okMsg);
    return res;
  }

  C.actions['live-cmd'] = (el) => {
    const labels = { answer: 'Generating answer…', recap: 'Generating recap…', followup: 'Generating follow-up…' };
    S.live.cur = -1;
    S.ui.liveTab = 'answer';
    send({ cmd: el.dataset.cmd }, labels[el.dataset.cmd]);
  };

  C.actions['live-chat'] = () => {
    const input = document.getElementById('liveChat');
    const text = input && input.value.trim();
    if (!text) return;
    input.value = '';
    S.live.cur = -1;
    S.ui.liveTab = 'answer';
    send({ cmd: 'chat', text });
  };

  C.actions['live-pause'] = (el) => {
    const src = el.dataset.src;
    send({ cmd: 'pause', src, paused: !S.live.paused[src] });
  };

  C.actions['live-rate'] = (el) => {
    const cur = currentAnswer();
    if (!cur) return;
    const vote = Number(el.dataset.vote);
    cur.a.vote = vote;
    send({ cmd: 'rate', id: cur.a.id, vote }, vote > 0 ? 'Marked as helpful.' : 'Thanks: the copilot avoids answers like this.');
    mark('answer');
  };

  C.actions['live-prev'] = () => {
    const cur = currentAnswer();
    if (!cur) return;
    S.live.cur = Math.max(0, cur.idx - 1);
    mark('answer');
  };

  C.actions['live-next'] = () => {
    const cur = currentAnswer();
    if (!cur) return;
    const next = cur.idx + 1;
    S.live.cur = next >= S.live.answers.length - 1 ? -1 : next;
    mark('answer');
  };

  C.actions['live-pick'] = (el) => {
    const i = Number(el.dataset.idx);
    S.live.cur = i >= S.live.answers.length - 1 ? -1 : i;
    S.ui.liveTab = 'answer';
    C.refresh();
  };

  C.actions['live-tab'] = (el) => {
    S.ui.liveTab = el.dataset.tab;
    C.refresh();
  };

  C.changes['live-mode'] = async (el) => {
    const want = el.checked;
    const res = await C.guard(() => api.setMode(want), 'Could not change the mode.');
    if (res && res.ok === false) {
      el.checked = !want;
      C.toast(res.error || 'The copilot is not running.', 'error');
    }
  };

  C.changes['live-agent'] = (el) => {
    S.activeAgentId = el.value;
    C.refresh();
  };
})();
