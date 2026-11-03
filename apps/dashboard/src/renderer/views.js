// Cue dashboard — page views: home, sessions, session detail, review, files
// and question bank. Each view returns HTML built from Cue.state.
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon, fixText, pctBar, plural } = C;

  const FORMATS = ['Behavioral', 'Technical', 'Mixed panel', 'Culture', 'Case', 'Screening', 'System design', 'Final'];
  C.FORMATS = FORMATS;

  function formatOf(a) {
    return fixText(a.interview_format || '') || '—';
  }

  function head(title, lede, right, ruled) {
    return `<section class="page-head ${ruled ? 'ruled' : ''}">
      <div class="title-col">${typeof title === 'string' && !title.startsWith('<') ? `<h1 class="h1">${esc(title)}</h1>` : title}${lede ? `<p class="lede">${lede}</p>` : ''}</div>
      ${right ? `<div class="row wrap">${right}</div>` : ''}
    </section>`;
  }
  C.head = head;

  function monoTile(name, logo, cls) {
    if (logo) return `<span class="mono-tile ${cls || ''}"><img src="${esc(logo)}" alt=""/></span>`;
    return `<span class="mono-tile ${cls || ''}">${esc(C.monogram(name))}</span>`;
  }
  C.monoTile = monoTile;

  function companyLogo(name) {
    const bank = S.questionBank && S.questionBank.companies;
    if (!bank || !name) return '';
    const n = C.norm(name);
    const hit = bank.find((c) => C.norm(c.name) === n);
    return hit && hit.logo ? hit.logo : '';
  }
  C.companyLogo = companyLogo;

  // ================================================================ HOME ==
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function calCard(a, iv) {
    const r = C.readiness(a);
    const soon = iv.days <= 1;
    const today = iv.days === 0;
    const reminder = S.gcal.status && S.gcal.status.connected ? `${S.gcal.status.reminderMin ?? 60} min antes` : '1h antes';
    return `<div class="cal-card ${soon ? 'soon' : ''}">
      <div class="row top" style="gap:14px">
        <div class="date-tile"><span class="d">${C.pad2(iv.at.getDate())}</span><span class="m">${C.MONTHS[iv.at.getMonth()]}</span></div>
        <div class="stack gap-4 grow" style="gap:3px">
          <span class="small muted truncate">${esc(C.agentCompany(a) || 'No company set')}</span>
          <span class="truncate" style="font-size:14.5px;font-weight:500;letter-spacing:-.01em;line-height:1.35">${esc(C.agentRole(a) || a.name || 'Entrevista')}</span>
        </div>
        <span class="pill ${soon ? 'ok' : ''}"><span class="dot"></span>${esc(C.relDays(iv.days))}</span>
      </div>
      <div class="cal-meta">
        <span>${icon('clock')}<span class="mono" style="font-size:11.5px">${iv.hasTime ? esc(iv.time) : 'No time set'}</span></span>
        <span>${icon('users')}${esc(formatOf(a))}</span>
        <span>${icon('bell')}${esc(reminder)}</span>
      </div>
      <div class="meter-row">
        <div class="lbl small"><span class="faint">Preparo</span><span class="num" style="color:var(--text)">${r.pct}%</span></div>
        ${pctBar(r.pct)}
      </div>
      <div class="cal-actions">
        ${today
          ? `<button type="button" class="btn primary flex1" data-action="start-copilot" data-agent="${esc(a.id)}">${icon('video')}Join the room</button>`
          : `<button type="button" class="btn flex1" data-action="start-copilot" data-agent="${esc(a.id)}" data-demo="1">${icon('play')}Practice</button>`}
        <button type="button" class="btn flex1" data-action="go" data-to="session/${esc(a.id)}">${icon('folder')}Contexto</button>
      </div>
    </div>`;
  }

  // Last sessions with a measured first-token latency, oldest → newest.
  function latencyPoints() {
    return S.sessions
      .map((s) => ({ s, v: C.sessionLatency(s), d: C.sessionDate(s) }))
      .filter((p) => p.v != null && p.d)
      .slice(0, 14)
      .reverse();
  }

  function niceStep(span) {
    const raw = span / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((x) => x >= raw) || raw;
  }

  function latencyChart(pts) {
    if (pts.length < 2) {
      return `<div class="chart-box"><div class="empty" style="padding:36px 10px">${icon('chart')}<span>Latency shows up after two sessions with copilot answers.</span></div></div>`;
    }
    const vals = pts.map((p) => p.v);
    const step = niceStep(Math.max(1, Math.max(...vals) - Math.min(...vals)));
    const lo = Math.max(0, Math.floor(Math.min(...vals) / step) * step);
    const hi = Math.ceil(Math.max(...vals) / step) * step + (Math.max(...vals) === Math.ceil(Math.max(...vals) / step) * step ? step : 0);
    const ticks = [];
    for (let v = hi; v >= lo - 1e-6; v -= step) ticks.push(Math.round(v));
    const W = 300;
    const H = 120;
    const y = (v) => ((hi - v) / (hi - lo || 1)) * H;
    const xy = pts.map((p, i) => [(i * W) / (pts.length - 1), y(p.v)]);
    const line = xy.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const area = `M0 ${H} ${xy.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')} L${W} ${H} Z`;
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const grid = ticks.map((t) => `<line x1="0" y1="${y(t).toFixed(1)}" x2="${W}" y2="${y(t).toFixed(1)}" stroke="var(--border-subtle)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`).join('');
    const avgLine = `<line x1="0" y1="${y(avg).toFixed(1)}" x2="${W}" y2="${y(avg).toFixed(1)}" stroke="var(--text-faint)" stroke-dasharray="1 3" vector-effect="non-scaling-stroke"/>`;
    const dots = xy
      .map(([px, py], i) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="var(--accent)" stroke="var(--surface-raised)" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>${esc(C.fmtDateShort(pts[i].d))} ${esc(C.fmtTime(pts[i].d))} · ${esc(C.sessionTitle(pts[i].s))}: ${Math.round(pts[i].v)} ms</title></circle>`)
      .join('');
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    const best = Math.min(...vals);
    return `<div class="chart-box">
      <div class="chart-wrap">
        <div class="chart-y">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="First-token latency per session, in milliseconds">
          <defs><linearGradient id="latArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          ${grid}${avgLine}
          <path d="${area}" fill="url(#latArea)"/>
          <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
          ${dots}
        </svg>
      </div>
      <div class="chart-axis" style="padding-left:52px"><span>${esc(C.fmtDateShort(pts[0].d))}</span><span>${esc(C.fmtDateShort(mid.d))}</span><span style="color:var(--text-secondary)">${esc(C.fmtDateShort(pts[pts.length - 1].d))}</span></div>
      <div class="chart-foot"><span>Average <b>${avg} ms</b></span><span>Best <b>${Math.round(best)} ms</b></span><span>Last <b>${Math.round(vals[vals.length - 1])} ms</b></span><span>${plural(pts.length, 'session', 'sessions')} · ms</span></div>
    </div>`;
  }

  // Behavioral = the "tell me about a time..." questions about you (JEV "pessoal").
  const CAT_LABEL = {
    Behavioral: 'Personal',
    Technical: 'Technical',
    Culture: 'Culture',
    'Domain knowledge': 'Domain',
    Leadership: 'Leadership',
    Salary: 'Salary',
    Opening: 'Opening',
    Experience: 'Experience',
    General: 'General',
    'System design': 'System design',
    Coding: 'Coding'
  };
  C.catLabel = (c) => CAT_LABEL[c] || fixText(c || 'Other');

  function categoryBars() {
    const counts = {};
    let total = 0;
    for (const co of (S.questionBank && S.questionBank.companies) || []) {
      for (const q of co.questions || []) {
        const k = C.catLabel(q.category);
        counts[k] = (counts[k] || 0) + 1;
        total += 1;
      }
    }
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!rows.length) {
      return { total, html: `<div class="empty" style="padding:24px 10px">${icon('question')}<span>Questions detected in your sessions show up here.</span></div>` };
    }
    const max = rows[0][1];
    return {
      total,
      html: rows
        .map(([label, n]) => `<div class="meter-row"><div class="lbl"><span>${esc(label)}</span><span class="num">${n}</span></div>${pctBar((n / max) * 100, 'thick')}</div>`)
        .join('')
    };
  }

  C.views.home = function home() {
    const name = firstName(fixText(S.profile.name || ''));
    const agents = S.agents.filter((a) => !a.archived);
    const up = C.upcomingAgents();
    const week = up.filter(({ iv }) => iv.days <= 7).length;
    const cfg = S.config || {};
    // One latency number everywhere on the page: the average the chart shows.
    const latPts = latencyPoints();
    const lat = latPts.length ? Math.round(latPts.reduce((acc, p) => acc + p.v, 0) / latPts.length) : null;
    const running = S.overlayStatus.running;
    const u = C.usage();
    const stealthOn = Boolean(S.stealthState && S.stealthState.active);
    const ready = C.engineReady();
    const gconn = S.gcal.status && S.gcal.status.connected;
    const cats = categoryBars();
    const prep = agents
      .map((a) => ({ a, r: C.readiness(a), iv: C.agentInterview(a) }))
      .sort((x, y) => (x.iv && x.iv.days >= 0 ? x.iv.at : Infinity) - (y.iv && y.iv.days >= 0 ? y.iv.at : Infinity) || x.r.pct - y.r.pct)
      .slice(0, 3);

    const setupBanner = !ready.ok
      ? `<div class="banner warn">${icon('key')}<span class="grow">${!ready.stt ? 'Add your transcription key (Deepgram) so the copilot can hear the interview.' : 'Add an AI key (OpenRouter, Cerebras, OpenAI…) so the copilot can suggest answers.'}</span><button type="button" class="btn sm" data-action="go" data-to="settings/ai">Set up</button></div>`
      : '';

    const liveBanner = running
      ? `<div class="banner">${icon('broadcast')}<span class="grow">Copilot ${S.overlayStatus.mode === 'demo' ? 'in practice' : 'live'}${C.agentById(S.overlayStatus.agentId) ? ` · ${esc(C.agentTitle(C.agentById(S.overlayStatus.agentId)))}` : ''}</span><button type="button" class="btn sm" data-action="go" data-to="live">Open live panel</button><button type="button" class="btn sm danger" data-action="stop-copilot">${icon('stop')}Stop</button></div>`
      : '';

    return `<div class="page">
      ${head(
        `<div class="title-row"><h1 class="h1">${esc(greeting())}${name ? `, ${esc(name)}` : ''}</h1>${agents.length ? `<span class="pill ok"><span class="dot"></span>${plural(agents.length, 'active session', 'active sessions')}</span>` : ''}</div>`,
        'Overview of your preparation and the copilot performance.',
        `<button type="button" class="status-chip" data-action="go" data-to="settings/ai"><span class="dot ${ready.ok ? '' : 'warn'}"></span>${esc(C.modelLabel(cfg.model))}<span class="vsep">|</span><span class="num">${lat ? `${lat} ms` : 'no measurements'}</span></button>
         <button type="button" class="status-chip" data-action="go" data-to="settings/privacy">${icon('shield-check')}${cfg.save_sessions === false ? 'Not recording' : 'Local recording'}<span class="vsep">|</span><span class="sub">${stealthOn ? 'Hidden' : 'Visible'} in captures</span></button>`,
        true
      )}
      ${liveBanner}${setupBanner}${C.proAd('card', 'Get more with Cue PRO')}

      <section class="card" style="gap:16px">
        <div class="row top" style="gap:12px">
          <span class="icon-tile">${icon('calendar')}</span>
          <div class="stack gap-4 grow" style="gap:0"><span class="h2">Upcoming interviews</span><span class="small faint">${gconn ? `Synced with Google Calendar${S.gcal.status.email ? ` · ${esc(S.gcal.status.email)}` : ''}` : 'Dates set in your sessions'}</span></div>
          <span class="pill lg">${week ? `${week} in 7 days` : `${up.length} scheduled`}</span>
          <button type="button" class="btn primary" data-action="open-scheduler">${icon('plus')}Schedule</button>
        </div>
        ${up.length
          ? `<div class="cal-grid">${up.slice(0, 4).map(({ a, iv }) => calCard(a, iv)).join('')}</div>`
          : `<div class="empty boxed">${icon('calendar')}<span class="t">No interviews scheduled</span><span>Set a session date to see the countdown and get reminders.</span><div class="row"><button type="button" class="btn" data-action="open-scheduler">${icon('calendar')}Schedule interview</button><button type="button" class="btn primary" data-action="new-session">${icon('plus')}New session</button></div></div>`}
        <div class="reminder-bar"><span class="dot sm"></span><span style="color:var(--text)" class="nowrap">Smart reminder</span><span class="grow">${gconn ? `Google Calendar reminds you ${S.gcal.status.reminderMin ?? 60} min before; Windows notification 1 hour before.` : 'Windows notification 1 hour before each interview.'}</span><a class="nowrap" data-action="go" data-to="settings/calendar">Set up</a></div>
      </section>

      <section class="grid-2">
        <div class="card">
          <div class="row between"><span class="eyebrow">Active model</span><span class="pill ${running ? 'danger' : ready.ok ? 'ok' : 'warn'}">${running ? 'In use' : ready.ok ? 'Streaming' : 'No key'}</span></div>
          <div class="stack gap-4">
            <div class="row between" style="align-items:baseline"><span style="font-size:15px;font-weight:500">${esc(C.modelLabel(cfg.model))}</span><span class="num">${lat ? `~${lat}ms` : '—'}</span></div>
            <span class="muted" style="font-size:13px">via ${esc(C.providerFor(cfg.model))} · ${cfg.auto_suggest === false ? 'on-demand' : 'automatic'} answers in ${esc(cfg.ai_response_language && cfg.ai_response_language !== 'auto' ? cfg.ai_response_language : 'the conversation language')}.</span>
          </div>
          <div class="toggle-row boxed">
            <span class="txt"><span class="t">Hide from screen</span><span class="s">Panel invisible in recordings and screen sharing</span></span>
            ${C.sw('data-change="stealth-switch" aria-label="Hide from screen"', stealthOn)}
          </div>
          <a class="small muted" style="margin-top:auto" data-action="go" data-to="settings/ai">Change the model in settings →</a>
        </div>
        <div class="card">
          <div class="row between"><span class="eyebrow">Usage and quota</span><span class="pill">${esc(u.planLabel)} plan</span></div>
          <div class="stack gap-4"><span class="metric">${u.usedMin}<span class="unit"> ${u.limit ? `/ ${u.limit} min` : 'min'}</span></span><span class="muted" style="font-size:13px">Transcribed in ${esc(u.monthLabel)}</span></div>
          ${u.limit ? pctBar(u.pct) : ''}
          <div class="kv"><div><span class="k">Sessions</span><span class="v">${u.sessions}</span></div><div><span class="k">Questions</span><span class="v">${u.questions}</span></div></div>
          <div class="card-foot"><span>${u.limit ? `Renews on ${esc(u.renewLabel)}` : `${esc(u.monthLabel)} cycle`}</span><span style="color:var(--text-secondary)">${u.limit ? `${u.left} min left` : `${u.answers} answers`}</span></div>
        </div>
      </section>

      <section class="stack gap-16">
        <div class="card tight">
          <div class="card-head"><div class="stack gap-4" style="gap:0"><span class="t">Sessions in preparation</span><span class="s">Context the copilot uses live</span></div><a class="small muted nowrap" data-action="go" data-to="sessions">View all (${agents.length})</a></div>
          ${prep.length
            ? prep
                .map(({ a, r }) => `<button type="button" class="list-row" data-action="go" data-to="session/${esc(a.id)}">
                  ${monoTile(C.agentCompany(a) || a.name, companyLogo(C.agentCompany(a)))}
                  <span class="stack grow" style="gap:0"><span class="truncate" style="font-size:13.5px;font-weight:500">${esc(C.agentTitle(a))}</span><span class="small faint">${plural((a.documents || []).length, 'documento vinculado', 'documentos vinculados')}</span></span>
                  ${pctBar(r.pct, 'w96')}
                  <span class="num" style="color:var(--text-secondary);width:34px;text-align:right">${r.pct}%</span>
                  ${icon('caret-right', 'faint')}
                </button>`)
                .join('')
            : `<div class="empty">${icon('stack')}<span class="t">No sessions yet</span><span>Each session brings together the job, your files and the instructions the AI uses live.</span><button type="button" class="btn primary" data-action="new-session">${icon('plus')}Create session</button></div>`}
        </div>

        <div class="card" style="gap:22px">
          <div class="card-head"><div class="stack gap-4" style="gap:0"><span class="t">Performance</span><span class="s">Copilot latency and detected questions</span></div><span class="pill ok"><span class="dot"></span>Real data</span></div>
          <div class="grid-2" style="gap:20px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
            <div class="stack gap-8" style="gap:10px">
              <div class="row between top"><div class="stack" style="gap:0"><span style="font-size:13px">First token per session</span><span class="xs faint">Average of the last ${latPts.length || 0} sessions, in ms</span></div><span class="num" style="color:var(--accent);font-size:13px">${lat ? `${lat} ms` : '—'}</span></div>
              ${latencyChart(latPts)}
            </div>
            <div class="stack gap-8" style="gap:10px">
              <div class="row between" style="align-items:baseline"><span style="font-size:13px">Questions by category</span><span class="num">${cats.total} in the bank</span></div>
              <div class="inset" style="flex:1;justify-content:center;gap:12px">${cats.html}</div>
            </div>
          </div>
        </div>
      </section>
    </div>`;
  };

  function firstName(n) {
    return String(n || '').trim().split(/\s+/)[0] || '';
  }

  C.changes['stealth-switch'] = async (el) => {
    const want = el.checked;
    const res = await C.guard(() => api.setStealthMode({ active: want }), 'Could not change hidden mode.');
    if (res && (res.status || res.state)) S.stealthState = res.status || res.state;
    else if (res) S.stealthState = { ...S.stealthState, active: want };
    C.toast(want ? 'Panel hidden from recordings and screen sharing.' : 'Panel visible in recordings.');
    C.renderShell();
  };

  // ============================================================ SESSIONS ==
  function sessionRowsPast() {
    const list = S.sessions;
    if (!list.length) {
      return `<div class="empty boxed">${icon('history')}<span class="t">No recorded sessions</span><span>When you stop the copilot, the transcript and answers show up here.</span><button type="button" class="btn primary" data-action="go" data-to="live">${icon('broadcast')}Go to Live</button></div>`;
    }
    const cols = 'grid-template-columns:minmax(0,1fr) 140px 100px 100px auto';
    return `<div class="card flush">
      <div class="table-head" style="${cols}"><span>Session</span><span>JEV score</span><span>Answers</span><span>Latency</span><span></span></div>
      ${list
        .map((s) => {
          const d = C.sessionDate(s);
          const a = C.agentForSession(s);
          const title = C.sessionTitle(s);
          const mode = s.mode === 'demo' ? 'Practice' : s.mode === 'live' ? 'Live' : 'Session';
          const answers = Number(s.suggestions || s.answersCount || 0);
          const lat = C.sessionLatency(s);
          return `<div class="table-row clickable" style="${cols}" data-action="go" data-to="review/${esc(s.id)}">
            <div class="row" style="gap:12px;min-width:0">${monoTile(a ? C.agentCompany(a) : title, a ? companyLogo(C.agentCompany(a)) : '')}<div class="stack" style="gap:0;min-width:0"><span class="truncate strong">${esc(title)}</span><span class="truncate faint" style="font-size:12.5px">${esc(mode)} · <span class="mono" style="font-size:11.5px">${d ? `${esc(C.fmtDateShort(d))} · ${esc(C.fmtTime(d))}` : '—'} · ${esc(C.fmtDuration(s.durationSeconds))}</span></span></div></div>
            ${Number.isFinite(s.jevScore)
              ? `<div class="row"><span class="mono" style="font-size:14px;font-weight:500;width:26px;color:${C.scoreTone(s.jevScore).color}">${s.jevScore}</span>${pctBar(s.jevScore, `grow ${C.scoreTone(s.jevScore).cls === 'ok' ? '' : C.scoreTone(s.jevScore).cls}`)}</div>`
              : `<span class="small faint">${s.hasEvents ? 'Not evaluated' : '—'}</span>`}
            <span class="mono" style="font-size:13px">${answers}</span>
            <span class="mono" style="font-size:12px;color:var(--text-secondary)">${lat ? `${Math.round(lat)} ms` : '—'}</span>
            <button type="button" class="btn" data-action="go" data-to="review/${esc(s.id)}" data-stop="1">View review${icon('arrow-right')}</button>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  function sessionRowsUpcoming() {
    const list = S.agents.filter((a) => S.ui.showArchived || !a.archived);
    if (!list.length) {
      return `<div class="empty boxed">${icon('stack')}<span class="t">Create your first session</span><span>Enter the role and company, then attach your resume and the job description.</span><button type="button" class="btn primary" data-action="new-session">${icon('plus')}New session</button></div>`;
    }
    const sorted = list
      .map((a) => ({ a, iv: C.agentInterview(a), r: C.readiness(a) }))
      .sort((x, y) => {
        const ax = x.iv && x.iv.days >= 0 ? x.iv.at.getTime() : Infinity;
        const ay = y.iv && y.iv.days >= 0 ? y.iv.at.getTime() : Infinity;
        return ax - ay || C.agentTitle(x.a).localeCompare(C.agentTitle(y.a));
      });
    const cols = 'grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) 130px 190px';
    return `<div class="card flush">
      <div class="table-head" style="${cols}"><span>Vaga</span><span>Formato</span><span>Data</span><span>Preparo</span><span></span></div>
      ${sorted
        .map(({ a, iv, r }) => `<div class="table-row clickable" style="${cols}" data-action="go" data-to="session/${esc(a.id)}">
          <div class="row" style="gap:12px;min-width:0">${monoTile(C.agentCompany(a) || a.name, companyLogo(C.agentCompany(a)))}<div class="stack" style="gap:1px;min-width:0"><span class="strong truncate">${esc(C.agentRole(a) || a.name)}${a.archived ? ' <span class="tag">Archived</span>' : ''}</span><span class="truncate faint" style="font-size:12.5px">${esc(C.agentCompany(a) || '—')} · ${plural((a.documents || []).length, 'file', 'files')}</span></div></div>
          <span class="muted" style="font-size:13px">${esc(formatOf(a))}</span>
          <span class="mono" style="font-size:12px;color:var(--text-secondary)">${iv ? `${esc(C.fmtDateShort(iv.at))}${iv.hasTime ? ` · ${esc(iv.time)}` : ''}${iv.days < 0 ? ' <span class="faint">(passou)</span>' : ''}` : '—'}</span>
          <div class="row">${pctBar(r.pct, 'neutral grow')}<span class="num" style="color:var(--text-secondary);width:32px;text-align:right">${r.pct}%</span></div>
          <div class="row" style="justify-content:flex-end">
            <button type="button" class="btn sm" data-action="start-copilot" data-agent="${esc(a.id)}" data-demo="1" data-stop="1" title="Practice with training questions">${icon('robot')}Practice</button>
            <button type="button" class="btn sm" data-action="start-copilot" data-agent="${esc(a.id)}" data-stop="1">${icon('play')}Start</button>
          </div>
        </div>`)
        .join('')}
    </div>`;
  }

  C.views.sessions = function sessions() {
    const past = S.ui.sessTab === 'past';
    const nArchived = S.agents.filter((a) => a.archived).length;
    return `<div class="page tight">
      ${head(past ? 'History' : 'Sessions', past ? 'Sessions recorded by the copilot, with transcript, answers and review.' : 'Each session brings together the job, your files and the instructions the AI uses live.',
        `${past ? `<button type="button" class="btn" data-action="open-path">${icon('folder')}Open folder</button>` : ''}<button type="button" class="btn primary lg" data-action="new-session">${icon('plus')}New session</button>`)}
      <div class="row between wrap">
        <div class="segmented">
          <button type="button" class="${past ? '' : 'active'}" data-action="go" data-to="sessions">Upcoming<span class="num">${S.agents.filter((a) => !a.archived).length}</span></button>
          <button type="button" class="${past ? 'active' : ''}" data-action="go" data-to="sessions/past">Completed<span class="num">${S.sessions.length}</span></button>
        </div>
        ${!past && nArchived ? `<label class="row small muted" style="cursor:pointer">${C.sw('data-change="toggle-archived"', S.ui.showArchived)}Show archived (${nArchived})</label>` : ''}
      </div>
      ${past ? sessionRowsPast() : sessionRowsUpcoming()}
    </div>`;
  };

  C.changes['toggle-archived'] = (el) => {
    S.ui.showArchived = el.checked;
    C.refresh();
  };

  // ====================================================== SESSION DETAIL ==
  C.views.session = function sessionDetail(parts) {
    const a = C.agentById(parts[0]);
    if (!a) {
      return `<div class="page"><div class="empty boxed">${icon('stack')}<span class="t">Session not found</span><button type="button" class="btn" data-action="go" data-to="sessions">Back to Sessions</button></div></div>`;
    }
    S.activeAgentId = a.id;
    const iv = C.agentInterview(a);
    const r = C.readiness(a);
    const docs = a.documents || [];
    const recs = C.sessionsForAgent(a);
    const mem = a.goal_memory || { strengths: a.goal_memory_strengths || [], improve: a.goal_memory_improve || [] };
    const running = S.overlayStatus.running && S.overlayStatus.agentId === a.id;
    const pbNames = [...new Set([...(S.playbooks || []).map((p) => p.name), a.playbook_name || 'Standard STAR'])].filter(Boolean);
    const research = fixText(a.company_research || a.company_dossier || '');

    return `<div class="page tight">
      <button type="button" class="link-btn" data-action="go" data-to="sessions">${icon('arrow-left')}Sessions</button>
      <section class="page-head ruled" style="align-items:center">
        <div class="row" style="gap:16px;min-width:0;flex:1">
          ${monoTile(C.agentCompany(a) || a.name, companyLogo(C.agentCompany(a)), 'lg')}
          <div class="stack gap-4" style="min-width:0">
            <h1 class="h1 truncate" style="font-size:22px">${esc(C.agentTitle(a))}</h1>
            <div class="cal-meta" style="font-size:12.5px">
              <span>${icon('calendar')}<span class="mono" style="font-size:12px">${iv ? `${esc(C.fmtDateShort(iv.at))}${iv.hasTime ? ` · ${esc(iv.time)}` : ''} · ${esc(C.relDays(iv.days).toLowerCase())}` : 'No date'}</span></span>
              <span>${icon('users')}${esc(formatOf(a))}</span>
              <span>${icon('flag')}${esc(fixText(a.stage || 'Active') === 'Active' ? 'Em andamento' : fixText(a.stage))}</span>
            </div>
          </div>
        </div>
        <div class="row wrap">
          <button type="button" class="btn" data-action="edit-session" data-agent="${esc(a.id)}">${icon('pencil')}Edit</button>
          <button type="button" class="btn" data-action="open-scheduler" data-agent="${esc(a.id)}">${icon('calendar')}${iv ? 'Reschedule' : 'Schedule'}</button>
          <button type="button" class="btn" data-action="start-copilot" data-agent="${esc(a.id)}" data-demo="1">${icon('robot')}Practice</button>
          ${running
            ? `<button type="button" class="btn live" data-action="go" data-to="live">${icon('broadcast')}Live now</button>`
            : `<button type="button" class="btn primary" data-action="start-copilot" data-agent="${esc(a.id)}">${icon('play')}Go live</button>`}
        </div>
      </section>

      <section class="grid-2">
        <div class="card">
          <div class="row between"><span class="eyebrow">Preparo</span><span class="num" style="color:var(--text)">${r.pct}%</span></div>
          ${pctBar(r.pct, 'thick')}
          <div class="checklist">${r.items
            .map((i) => `<div class="check-item ${i.done ? 'done' : ''}"><span class="mark">${icon('check')}</span><span class="label grow">${esc(i.label)}</span><span class="num">+${i.w}</span></div>`)
            .join('')}</div>
        </div>
        <div class="card">
          <div class="row between"><span class="eyebrow">Copilot answers</span>${a.playbook_name ? `<span class="pill">${esc(fixText(a.playbook_name))}</span>` : ''}</div>
          <label class="field">Playbook (answer structure and length)
            <div class="row"><select class="select" data-change="agent-playbook" data-agent="${esc(a.id)}">${C.opts(pbNames.map((n) => [n, fixText(n)]), a.playbook_name || 'Standard STAR')}</select><button type="button" class="btn icon-only" data-action="new-playbook" data-agent="${esc(a.id)}" title="New playbook">${icon('plus')}</button></div>
          </label>
          <div class="form-grid">
            <label class="field">Answer language<select class="select" data-change="agent-field" data-field="answer_language" data-agent="${esc(a.id)}">${C.opts([['pt-BR', 'Portuguese (Brazil)'], ['en-US', 'English'], ['es', 'Spanish']], a.answer_language || 'pt-BR')}</select></label>
            <label class="field">Coding language<select class="select" data-change="agent-field" data-field="coding_language" data-agent="${esc(a.id)}">${C.opts([['', 'Per the job'], ['Python', 'Python'], ['JavaScript', 'JavaScript'], ['TypeScript', 'TypeScript'], ['Java', 'Java'], ['Go', 'Go'], ['C++', 'C++'], ['C#', 'C#'], ['Kotlin', 'Kotlin'], ['Rust', 'Rust'], ['SQL', 'SQL']], a.coding_language || '')}</select></label>
          </div>
          <label class="field">Process stage<select class="select" data-change="agent-field" data-field="stage" data-agent="${esc(a.id)}">${C.opts([['Active', 'In progress'], ['Applied', 'Applied'], ['Screening', 'Screening'], ['Technical', 'Technical'], ['Final', 'Final'], ['Offer', 'Offer'], ['Closed', 'Closed']], a.stage || 'Active')}</select></label>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="stack" style="gap:0"><span class="t">Job context</span><span class="s">The copilot reads this before every answer</span></div><button type="button" class="btn sm" data-action="save-context" data-agent="${esc(a.id)}">${icon('check')}Save context</button></div>
        <label class="field">Job description<textarea class="textarea" id="ctxJob" rows="6" placeholder="Paste the job description here">${esc(fixText(a.job_description || ''))}</textarea></label>
        <label class="field"><span class="row between">Company research<button type="button" class="link-btn" data-action="company-recon" data-agent="${esc(a.id)}">${icon('sparkle')}Research automatically</button></span><textarea class="textarea" id="ctxResearch" rows="6" placeholder="Product, culture, recent news, stack…">${esc(research)}</textarea></label>
        <label class="field">Instructions for the copilot<textarea class="textarea" id="ctxInstr" rows="3" placeholder="E.g. answer in the first person, use real examples from my resume">${esc(fixText(a.extra_instructions || a.custom_instructions || ''))}</textarea></label>
      </section>

      <section class="grid-2">
        <div class="card tight">
          <div class="card-head"><div class="stack" style="gap:0"><span class="t">Linked files</span><span class="s">${plural(docs.length, 'file', 'files')} in this session context</span></div>
            <div class="row"><button type="button" class="btn sm" data-action="paste-doc" data-agent="${esc(a.id)}">${icon('note')}Paste text</button><button type="button" class="btn sm" data-action="add-docs" data-agent="${esc(a.id)}" data-tag="material">${icon('upload')}Add</button></div></div>
          ${!docs.some((d) => C.docTag(d) === 'resume') ? `<button type="button" class="dropzone" data-action="add-docs" data-agent="${esc(a.id)}" data-tag="resume" style="padding:20px">${icon('file-text')}<span style="font-size:13px">Attach your resume</span><span class="num">It is the main source for the answers</span></button>` : ''}
          ${docs.length
            ? docs
                .map((d, i) => `<div class="list-row" style="cursor:default">${icon(C.docIcon(d), 'faint')}<span class="stack grow" style="gap:0"><span class="truncate" style="font-size:13px">${esc(fixText(d.title || d.name || 'Documento'))}</span><span class="xs faint">${esc(C.TAG_LABEL[C.docTag(d)])} · ${esc(C.fmtKb((d.content || '').length))}</span></span>
                  <button type="button" class="icon-btn" title="Preview" data-action="preview-doc" data-agent="${esc(a.id)}" data-idx="${i}">${icon('eye')}</button>
                  <button type="button" class="icon-btn danger" title="Remove" data-action="remove-doc" data-agent="${esc(a.id)}" data-idx="${i}">${icon('x')}</button></div>`)
                .join('')
            : ''}
        </div>
        <div class="card tight">
          <div class="card-head"><div class="stack" style="gap:0"><span class="t">Copilot memory</span><span class="s">Learnings from the debriefs for this job</span></div></div>
          ${a.next_focus ? `<div class="inset"><span class="eyebrow">Next focus</span><span style="font-size:13px">${esc(fixText(a.next_focus).replace(/^Focus on:\s*/i, ''))}</span></div>` : ''}
          ${(mem.strengths || []).length || (mem.improve || []).length
            ? `${(mem.strengths || []).slice(0, 3).map((x) => `<div class="bullet">${esc(fixText(x))}</div>`).join('')}${(mem.improve || []).slice(0, 3).map((x) => `<div class="bullet neutral">${esc(fixText(x))}</div>`).join('')}`
            : `<div class="empty" style="padding:20px">${icon('sparkle')}<span>Generate a debrief after a session so the copilot remembers strengths and what to improve.</span></div>`}
        </div>
      </section>

      <section class="card flush">
        <div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--border-subtle)"><span class="strong">Recorded sessions for this job</span><span class="num">${recs.length}</span></div>
        ${recs.length
          ? recs
              .slice(0, 8)
              .map((s) => {
                const d = C.sessionDate(s);
                return `<div class="table-row clickable" style="grid-template-columns:minmax(0,1fr) 120px auto" data-action="go" data-to="review/${esc(s.id)}"><span class="truncate">${s.mode === 'demo' ? 'Practice' : 'Live'} · <span class="mono faint" style="font-size:12px">${d ? `${esc(C.fmtDateShort(d))} ${esc(C.fmtTime(d))}` : '—'}</span></span><span class="num">${esc(C.fmtDuration(s.durationSeconds))}</span><span class="row small muted">View review${icon('caret-right')}</span></div>`;
              })
              .join('')
          : `<div class="empty" style="padding:24px">${icon('history')}<span>No recorded sessions for this job yet.</span></div>`}
      </section>

      <section class="row wrap" style="justify-content:flex-end">
        <button type="button" class="btn" data-action="archive-session" data-agent="${esc(a.id)}">${icon('tray')}${a.archived ? 'Desarquivar' : 'Arquivar'}</button>
        <button type="button" class="btn danger" data-action="delete-session" data-agent="${esc(a.id)}">${icon('trash')}Delete session</button>
      </section>
    </div>`;
  };

  C.changes['agent-field'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const label = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : el.value;
    await C.saveAgent({ ...a, [el.dataset.field]: el.value }, `Updated: ${label}.`);
    C.refresh();
  };

  C.changes['agent-playbook'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    const pb = (S.playbooks || []).find((p) => p.name === el.value);
    if (!a) return;
    const patch = pb
      ? {
          playbook_name: pb.name,
          playbook_answer_length: pb.answer_length,
          playbook_behavioral_structure: pb.behavioral_structure,
          playbook_lead_with_answer: pb.lead_with_answer,
          playbook_name_tradeoffs: pb.name_tradeoffs
        }
      : { playbook_name: el.value };
    await C.saveAgent({ ...a, ...patch }, `Playbook "${fixText(el.value)}" applied.`);
    C.refresh();
  };

  C.actions['save-context'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const research = document.getElementById('ctxResearch').value.trim();
    const instr = document.getElementById('ctxInstr').value.trim();
    await C.saveAgent(
      {
        ...a,
        job_description: document.getElementById('ctxJob').value.trim(),
        company_research: research,
        company_dossier: research,
        extra_instructions: instr,
        custom_instructions: instr,
        mini_compact: ''
      },
      'Context saved.'
    );
    C.refresh();
  };

  C.actions['company-recon'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a || !C.agentCompany(a)) {
      C.toast('Set the session company first.', 'error');
      return;
    }
    const prev = el.innerHTML;
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Pesquisando…';
    const res = await C.guard(() => api.companyRecon({ company: a.company, role: a.role, job_description: a.job_description }), 'A pesquisa falhou.');
    el.disabled = false;
    el.innerHTML = prev;
    if (res && res.dossier) {
      const box = document.getElementById('ctxResearch');
      if (box) box.value = fixText(res.dossier);
      C.toast('Research ready. Review it and click Save context.');
    }
  };

  C.actions['add-docs'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const res = await C.guard(() => api.pickFiles(el.dataset.tag || 'material'), 'Could not open the files.');
    await attachDocs(a, res, el.dataset.tag);
  };

  async function attachDocs(a, res, forceTag) {
    if (!res) return;
    if (res.failed && res.failed.length) C.toast(`No readable text: ${res.failed.map((f) => f.title).join(', ')}`, 'error');
    if (!Array.isArray(res.documents) || !res.documents.length) return;
    const incoming = res.documents.map((d) => (forceTag === 'resume' ? { ...d, tag: 'resume' } : d));
    let docs = [...(a.documents || [])];
    if (incoming.some((d) => C.docTag(d) === 'resume') && forceTag === 'resume') docs = docs.filter((d) => C.docTag(d) !== 'resume');
    docs.push(...incoming);
    C.toast(`Reading ${plural(incoming.length, 'file', 'files')}…`);
    const deep = await C.guard(() => api.deepReadAgent({ ...a, documents: docs }), 'Could not index the files.');
    if (!deep) return;
    C.applyAgents(deep.agents, (deep.agent && deep.agent.id) || a.id);
    C.toast(`${plural(incoming.length, 'file added', 'files added')} to ${C.agentTitle(a)}.`);
    C.refresh();
  }
  C.attachDocs = attachDocs;

  C.actions['remove-doc'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const idx = Number(el.dataset.idx);
    const doc = (a.documents || [])[idx];
    if (!doc) return;
    const ok = await C.confirm(`Remove "${fixText(doc.title || doc.name)}" from this session?`, 'The copilot stops using the file. The original on your computer is not changed.', 'Remove');
    if (!ok) return;
    const docs = (a.documents || []).filter((_, i) => i !== idx);
    await C.saveAgent({ ...a, documents: docs, mini_compact: '' }, 'File removed.');
    C.refresh();
  };

  C.actions['preview-doc'] = (el) => {
    const a = C.agentById(el.dataset.agent);
    const doc = a && (a.documents || [])[Number(el.dataset.idx)];
    if (doc) C.openModal('doc-preview', doc);
  };

  C.actions['archive-session'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    await C.saveAgent({ ...a, archived: !a.archived }, a.archived ? 'Session unarchived.' : 'Session archived.');
    C.refresh();
  };

  C.actions['delete-session'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const ok = await C.confirm(`Delete "${C.agentTitle(a)}"?`, 'The job, linked files and instructions are deleted. Recordings in History are kept.', 'Delete');
    if (!ok) return;
    const res = await C.guard(() => api.deleteAgent(a.id), 'Could not delete.');
    if (!res) return;
    C.applyAgents(res.agents, '');
    C.toast('Session deleted.');
    C.navigate('sessions');
  };

  // ============================================================== REVIEW ==
  // Speech metrics come from the transcript; answer quality comes from the
  // JEV judge (main process), one fixed rubric for every question.
  const JEV_CRITERIA = [
    ['adequacao', 'Relevance', 'Answers exactly what was asked'],
    ['cultura', 'Company culture', 'Alignment with the values and way of working'],
    ['estrutura', 'Structure', 'STAR on behavioral, clear reasoning on technical'],
    ['evidencias', 'Evidence', 'Concrete examples and numbers consistent with the resume'],
    ['objetividade', 'Conciseness', 'Gets straight to the point']
  ];
  C.JEV_CRITERIA = JEV_CRITERIA;
  const TIPO_LABEL = { comportamental: 'Behavioral', tecnica: 'Technical', cultura: 'Culture', motivacao: 'Motivation', outra: 'General' };

  // Real fillers only: "tipo" as a crutch ("tipo assim", "tipo,"), not "tipo de dado".
  const FILLER_RES = [
    ['tipo', /(?<!\p{L})tipo(?=\s*(?:,|assim|\.|$))/giu],
    ['né', /(?<!\p{L})né(?!\p{L})/giu],
    ['sabe', /(?<!\p{L})sabe\s*\?|,\s*sabe(?!\p{L})/giu],
    ['ahn/hum', /(?<!\p{L})(?:ahn+|hum+|hmm+|éé+)(?!\p{L})/giu],
    ['like', /(?<!\p{L})like,/giu],
    ['you know', /(?<!\p{L})you know(?!\p{L})/giu]
  ];
  const QUESTION_RE = /\?\s*$|^(como|por ?que|qual|quais|o que|quando|onde|quanto|me (conta|fala|diz)|conte|descreva|explique|fale|voc[eê] (pode|poderia|conseguiria|j[aá])|what|why|how|tell me|describe|can you|could you|walk me)\b/i;

  function parseJsonl(text) {
    const evs = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line || line[0] !== '{') continue;
      try {
        evs.push(JSON.parse(line));
      } catch (_e) {}
    }
    return evs;
  }

  // The engine emits one turn per endpoint (a few words); consecutive turns of
  // the same speaker are one block, which is what a person calls "a fala".
  function blocksOf(evs) {
    const out = [];
    for (const e of evs) {
      if (e.type !== 'turn' || !String(e.text || '').trim()) continue;
      const src = e.src === 'voce' ? 'voce' : 'outros';
      const t0 = Number(e.t0 || e.t) || 0;
      const t1 = Number(e.t) || t0;
      const last = out[out.length - 1];
      if (last && last.src === src) {
        last.text += ` ${fixText(e.text).trim()}`;
        last.t1 = t1;
      } else out.push({ src, text: fixText(e.text).trim(), t0, t1 });
    }
    return out;
  }

  const wordsIn = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;

  function analyze(s, evs) {
    const blocks = blocksOf(evs);
    const you = blocks.filter((b) => b.src === 'voce');
    const others = blocks.filter((b) => b.src === 'outros');
    const sugg = evs.filter((e) => e.type === 'suggestion');
    const completed = sugg.filter((x) => x.status === 'completed');
    const failed = sugg.filter((x) => x.status && x.status !== 'completed');
    const youWords = you.reduce((a, b) => a + wordsIn(b.text), 0);
    const othersWords = others.reduce((a, b) => a + wordsIn(b.text), 0);
    const talkPct = youWords + othersWords ? Math.round((youWords / (youWords + othersWords)) * 100) : null;

    // Pace over whole answers (pauses included), the way a listener hears it.
    const timed = you.filter((b) => b.t1 - b.t0 >= 4000 && wordsIn(b.text) >= 8);
    const timedWords = timed.reduce((a, b) => a + wordsIn(b.text), 0);
    const timedMs = timed.reduce((a, b) => a + (b.t1 - b.t0), 0);
    const wpm = timedMs ? Math.round(timedWords / (timedMs / 60000)) : null;
    const youMinutes = you.reduce((a, b) => a + Math.max(0, b.t1 - b.t0), 0) / 60000;

    const fillerCounts = [];
    for (const [label, re] of FILLER_RES) {
      let n = 0;
      for (const b of you) n += (b.text.match(re) || []).length;
      if (n) fillerCounts.push([label, n]);
    }
    fillerCounts.sort((a, b) => b[1] - a[1]);
    const fillers = fillerCounts.reduce((a, [, n]) => a + n, 0);
    const fillersPerMin = youMinutes > 0.5 ? Math.round((fillers / youMinutes) * 10) / 10 : null;

    // Interviewer blocks that ask something, and whether the copilot answered them.
    const questions = [];
    others.forEach((b, i) => {
      const next = others[i + 1];
      const end = next ? next.t0 : Infinity;
      const sg = sugg.find((x) => Number(x.t) >= b.t0 && Number(x.t) < end);
      const asks = (sg && sg.reason === 'question') || b.text.split(/(?<=[.?!])\s+/).some((x) => QUESTION_RE.test(x.trim()));
      if (asks) questions.push({ b, answered: Boolean(sg && sg.status === 'completed') });
    });
    const ttfts = completed.map((x) => Number(x.ttft_ms)).filter((v) => v > 0);
    const avgTtft = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;
    const avgAnswerSec = you.length ? Math.round(you.reduce((a, b) => a + (b.t1 - b.t0), 0) / you.length / 1000) : null;

    const items = [];
    for (const b of blocks) items.push({ kind: 'turn', t: b.t0, b });
    for (const x of sugg) items.push({ kind: 'sugg', t: Number(x.t) || 0, x });
    items.sort((a, b) => a.t - b.t);

    return { blocks, you, others, sugg, completed, failed, talkPct, wpm, fillers, fillerCounts, fillersPerMin, questions, avgTtft, avgAnswerSec, items };
  }

  function scoreTone(v) {
    if (v == null) return { color: 'var(--text-tertiary)', cls: '', label: 'No score' };
    if (v >= 85) return { color: 'var(--accent)', cls: 'ok', label: 'Excellent' };
    if (v >= 70) return { color: 'var(--accent)', cls: 'ok', label: 'Good' };
    if (v >= 50) return { color: 'var(--warning)', cls: 'warn', label: 'Fair' };
    return { color: 'var(--danger)', cls: 'danger', label: 'Weak' };
  }
  C.scoreTone = scoreTone;

  async function loadReview(id) {
    const s = S.sessions.find((x) => x.id === id);
    if (!s) return;
    const cache = (S.ui.reviews[id] = { loading: true });
    const [jl, mdRes] = await Promise.all([
      C.guard(() => api.readSessionDetail(`${id}.jsonl`)),
      C.guard(() => api.readSessionDetail(s.fileName || `${id}.md`))
    ]);
    const evs = jl && jl.content && jl.content !== 'Session file not found.' ? parseJsonl(jl.content) : [];
    Object.assign(cache, { loading: false, evs, md: (mdRes && mdRes.content) || '', a: evs.length ? analyze(s, evs) : null });
    if (S.route.view === 'review' && S.route.parts[0] === id) C.refresh();
    if (evs.length) runJev(id, false);
  }

  async function runJev(id, force) {
    const cache = S.ui.reviews[id];
    if (!cache || cache.jevLoading) return;
    const s = S.sessions.find((x) => x.id === id);
    const agent = s && C.agentForSession(s);
    cache.jevLoading = true;
    cache.jevError = '';
    if (S.route.view === 'review' && S.route.parts[0] === id) C.refresh();
    const res = await C.guard(() => api.evaluateSession(id, agent ? agent.id : '', force), 'The JEV evaluation failed.');
    cache.jevLoading = false;
    if (res && res.ok) {
      cache.jev = res.evaluation;
      if (s) s.jevScore = res.evaluation.score;
    } else cache.jevError = (res && res.error) || 'The JEV evaluation failed.';
    if (S.route.view === 'review' && S.route.parts[0] === id) C.refresh();
  }

  C.actions['jev-run'] = (el) => runJev(el.dataset.session, true);
  C.actions['jev-toggle'] = (el) => {
    const card = el.closest('.qcard');
    if (card) card.classList.toggle('open');
  };

  function ring(score, size) {
    const tone = scoreTone(score);
    const circ = 2 * Math.PI * 52;
    const dash = score == null ? `0 ${circ}` : `${(circ * score) / 100} ${circ}`;
    return `<div class="score-ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 120 120" style="width:${size}px;height:${size}px"><circle cx="60" cy="60" r="52" fill="none" stroke="var(--track)" stroke-width="7"/><circle cx="60" cy="60" r="52" fill="none" stroke="${tone.color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 60 60)"/></svg><div class="center"><span class="v">${score == null ? '—' : score}</span><span class="num">/ 100</span></div></div>`;
  }

  function jevSection(s, cache, agent) {
    const J = cache.jev;
    const company = agent ? C.agentCompany(agent) : '';
    if (cache.jevLoading) {
      return `<div class="card" style="gap:16px"><div class="row between"><span class="eyebrow">JEV evaluation</span><span class="pill warn"><span class="spinner"></span>Evaluating</span></div>
        <div class="row" style="gap:20px">${ring(null, 112)}<div class="stack gap-8 grow"><span style="font-size:14px">Evaluating each question with the same rubric${company ? `, including the culture of ${esc(company)}` : ''}…</span><span class="num">Takes a few seconds; the result is saved with the session.</span></div></div></div>`;
    }
    if (!J) {
      return `<div class="card" style="gap:14px"><div class="row between"><span class="eyebrow">JEV evaluation</span><span class="pill"><span class="dot"></span>Pending</span></div>
        <div class="row wrap" style="gap:16px"><span class="grow muted" style="font-size:13.5px">${esc(cache.jevError || 'The session has not been evaluated yet.')}</span>
        ${/OpenRouter/i.test(cache.jevError || '') ? '<button type="button" class="btn" data-action="go" data-to="settings/ai">Set up key</button>' : ''}
        <button type="button" class="btn primary" data-action="jev-run" data-session="${esc(s.id)}">${icon('sparkle')}Evaluate with JEV</button></div></div>`;
    }
    const tone = scoreTone(J.score);
    const when = J.evaluatedAt ? new Date(J.evaluatedAt) : null;
    return `<div class="card" style="gap:16px">
      <div class="row between"><span class="eyebrow">JEV evaluation</span><span class="pill ${tone.cls}"><span class="dot"></span>${tone.label}</span></div>
      <div class="row wrap" style="gap:20px 28px">
        ${ring(J.score, 112)}
        <div class="stack gap-8" style="flex:1 1 280px;max-width:640px">
          <span style="font-size:14px;line-height:1.6;color:var(--text-body)">${esc(J.resumo || `${plural(J.items.length, 'question evaluated', 'questions evaluated')} with the same rubric.`)}</span>
          <span class="num">${plural(J.items.length, 'question', 'questions')} · reference culture: ${esc(fixText(J.company || company || 'not set'))}${when ? ` · ${esc(C.fmtDateShort(when))} ${esc(C.fmtTime(when))}` : ''}${J.partial ? ' · partial' : ''}</span>
        </div>
        <button type="button" class="btn sm ml-auto" data-action="jev-run" data-session="${esc(s.id)}" title="Evaluate again">${icon('refresh')}Re-evaluate</button>
      </div>
    </div>`;
  }

  function criteriaCard(J) {
    return `<div class="card tight"><span class="eyebrow">JEV criteria · average across questions</span>
      ${JEV_CRITERIA.map(([k, label, hint]) => {
        const v = J ? J.criteria[k] : null;
        const tone = scoreTone(v);
        return `<div class="meter-row" style="gap:5px"><div class="lbl"><span>${esc(label)}</span><span class="num" style="color:var(--text-secondary)">${v == null ? '—' : v}</span></div>${pctBar(v || 0, tone.cls === 'ok' ? '' : tone.cls)}<span class="xs faint">${esc(hint)}</span></div>`;
      }).join('')}</div>`;
  }

  function metricsCard(A) {
    const pace = A.wpm == null ? 'Not enough speech' : A.wpm < 110 ? 'Slow (ideal 120–160)' : A.wpm <= 160 ? 'Within ideal (120–160)' : 'Fast (ideal 120–160)';
    const metrics = [
      ['Talk time', A.talkPct != null && A.you.length ? `${A.talkPct}%` : '—', 'Your share of the words · ideal 55–65%'],
      ['Ritmo', A.wpm ? `${A.wpm} ppm` : '—', pace],
      ['Filler words', A.fillersPerMin != null ? `${A.fillersPerMin}/min` : '—', A.fillerCounts.length ? A.fillerCounts.slice(0, 3).map(([w, n]) => `"${w}" ${n}×`).join(' · ') : 'None detected'],
      ['Answers', String(A.you.length), A.avgAnswerSec ? `Average length ${C.fmtDuration(A.avgAnswerSec)}` : 'Your turns']
    ];
    return `<div class="card"><span class="eyebrow">Speech metrics</span>
      <div class="kv" style="gap:16px 12px">${metrics.map(([l, v, h]) => `<div style="gap:2px"><span class="k">${esc(l)}</span><span style="font-size:20px;font-weight:600;letter-spacing:-.03em">${esc(v)}</span><span class="xs muted">${esc(h)}</span></div>`).join('')}</div></div>`;
  }

  function copilotCard(A) {
    const answered = A.questions.filter((q) => q.answered).length;
    const pct = A.questions.length ? Math.round((answered / A.questions.length) * 100) : null;
    return `<div class="card"><span class="eyebrow">Copiloto</span>
      <div class="kv" style="gap:16px 12px">
        <div style="gap:2px"><span class="k">Questions answered</span><span style="font-size:20px;font-weight:600;letter-spacing:-.03em">${pct == null ? '—' : `${pct}%`}</span><span class="xs muted">${A.questions.length ? `${answered} of ${A.questions.length} questions` : 'No questions detected'}</span></div>
        <div style="gap:2px"><span class="k">First token</span><span style="font-size:20px;font-weight:600;letter-spacing:-.03em">${A.avgTtft ? `${A.avgTtft} ms` : '—'}</span><span class="xs muted">Average of ${plural(A.completed.length, 'answer', 'answers')}</span></div>
        <div style="gap:2px"><span class="k">Failures</span><span style="font-size:20px;font-weight:600;letter-spacing:-.03em">${A.failed.length}</span><span class="xs muted">${A.failed.length ? 'Interrupted or failed' : 'None'}</span></div>
        <div style="gap:2px"><span class="k">Turns</span><span style="font-size:20px;font-weight:600;letter-spacing:-.03em">${A.others.length} / ${A.you.length}</span><span class="xs muted">Interviewer / you</span></div>
      </div></div>`;
  }

  function insightLists(A, J) {
    const strengths = J && J.fortes.length ? J.fortes.slice() : [];
    const improve = J && J.melhorar.length ? J.melhorar.slice() : [];
    if (A.talkPct != null && A.you.length && (A.talkPct < 45 || A.talkPct > 75)) improve.push(A.talkPct > 75 ? `You spoke ${A.talkPct}% of the words; leave more room for the interviewer.` : `You spoke only ${A.talkPct}% of the words; develop your answers more.`);
    if (A.wpm && A.wpm > 170) improve.push(`Pace of ${A.wpm} words per minute: slow down on technical answers.`);
    if (A.fillersPerMin != null && A.fillersPerMin >= 2) improve.push(`${A.fillersPerMin} filler words per minute (${A.fillerCounts.slice(0, 2).map(([w, n]) => `"${w}" ${n}×`).join(', ')}).`);
    if (A.wpm && A.wpm >= 120 && A.wpm <= 160) strengths.push(`Comfortable pace: ${A.wpm} words per minute.`);
    return { strengths, improve };
  }

  function chips(notas) {
    return JEV_CRITERIA.map(([k, label]) => {
      const v = notas[k];
      const tone = scoreTone(v == null ? null : v * 10);
      return `<span class="chip" title="${esc(label)}"><span class="dot sm" style="background:${tone.color}"></span>${esc(label.split(' ')[0])} <b class="mono" style="font-weight:500;color:var(--text)">${v == null ? '—' : v}</b></span>`;
    }).join('');
  }

  function questionCards(J) {
    if (!J || !J.items.length) return '';
    return `<section class="stack gap-8">
      <div class="row between" style="padding:0 2px"><span class="eyebrow">Evaluated questions · same rubric for all</span><span class="small faint">Scores from 0 to 10 per criterion</span></div>
      ${J.items
        .map((it, n) => {
          const tone = scoreTone(it.score);
          return `<div class="qcard collapsible">
            <button type="button" data-action="jev-toggle">
              <span class="mono faint" style="font-size:11px;width:22px;flex:none">${String(n + 1).padStart(2, '0')}</span>
              <div class="stack grow" style="gap:10px">
                <span class="q">${esc(fixText(it.pergunta))}</span>
                <div class="row wrap" style="gap:6px"><span class="tag">${esc(TIPO_LABEL[it.tipo] || 'General')}</span>${chips(it.notas)}</div>
                ${it.veredito ? `<span class="small muted">${esc(fixText(it.veredito))}</span>` : ''}
              </div>
              <span class="pill ${tone.cls} lg" style="flex:none"><span class="mono">${it.score == null ? '—' : it.score}</span></span>
              ${icon('caret-down', 'faint')}
            </button>
            <div class="detail">
              ${it.dica ? `<div class="note" style="margin-top:14px">${icon('arrow-up-right')}<span><b style="color:var(--text);font-weight:500">Como melhorar:</b> ${esc(fixText(it.dica))}</span></div>` : ''}
              <div class="grid-2" style="gap:12px">
                <div class="inset"><span class="eyebrow">Your answer${it.answerSeconds ? ` · ${C.fmtDuration(it.answerSeconds)}` : ''}</span><span style="font-size:13px;line-height:1.6;color:var(--text-body)">${esc(fixText(it.answer))}</span></div>
                <div class="inset"><span class="eyebrow">Copilot suggestion${it.ttftMs ? ` · ${it.ttftMs} ms` : ''}</span>${it.copilot ? `<div class="md sm">${C.md(it.copilot)}</div>` : '<span class="small faint">The copilot did not answer this question.</span>'}</div>
              </div>
              <span class="xs faint">Transcribed question: “${esc(fixText(it.question).slice(-300))}”</span>
            </div>
          </div>`;
        })
        .join('')}
    </section>`;
  }

  C.views.review = function review(parts) {
    const id = parts[0];
    const s = S.sessions.find((x) => x.id === id);
    if (!s) {
      return `<div class="page"><div class="empty boxed">${icon('history')}<span class="t">Session not found</span><button type="button" class="btn" data-action="go" data-to="sessions/past">Back to history</button></div></div>`;
    }
    const cache = S.ui.reviews[id];
    if (!cache) loadReview(id);
    const d = C.sessionDate(s);
    const agent = C.agentForSession(s);
    const title = C.sessionTitle(s);
    const headHtml = `<button type="button" class="link-btn" data-action="go" data-to="sessions/past">${icon('arrow-left')}History</button>
      <section class="page-head ruled" style="align-items:center">
        <div class="row" style="gap:16px;min-width:0;flex:1">
          ${monoTile(agent ? C.agentCompany(agent) : title, agent ? companyLogo(C.agentCompany(agent)) : '', 'lg')}
          <div class="stack gap-4" style="min-width:0">
            <h1 class="h1 truncate" style="font-size:22px">${esc(title)}</h1>
            <div class="cal-meta" style="font-size:12.5px">
              <span>${icon('calendar')}<span class="mono" style="font-size:12px">${d ? `${esc(C.fmtDateShort(d))} · ${esc(C.fmtTime(d))}` : '—'}</span></span>
              <span>${icon('clock')}<span class="mono" style="font-size:12px">${esc(C.fmtDuration(s.durationSeconds))}</span></span>
              <span>${icon('broadcast')}${s.mode === 'demo' ? 'Practice' : 'Live'}</span>
              ${s.llmModel ? `<span>${icon('cpu')}${esc(C.modelLabel(s.llmModel))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="row wrap">
          <button type="button" class="btn" data-action="open-path" data-path="${esc(s.fullPath || '')}">${icon('download')}Open file</button>
          ${agent ? `<button type="button" class="btn" data-action="gen-debrief" data-session="${esc(s.id)}" data-agent="${esc(agent.id)}">${icon('sparkle')}Save debrief</button>` : ''}
          ${agent ? `<button type="button" class="btn primary" data-action="start-copilot" data-agent="${esc(agent.id)}" data-demo="1">${icon('refresh')}Practice again</button>` : ''}
        </div>
      </section>`;

    if (!cache || cache.loading) {
      return `<div class="page tight">${headHtml}<div class="card"><div class="skeleton" style="height:112px"></div></div><div class="grid-2"><div class="card"><div class="skeleton" style="height:120px"></div></div><div class="card"><div class="skeleton" style="height:120px"></div></div></div></div>`;
    }
    const A = cache.a;
    if (!A) {
      return `<div class="page tight">${headHtml}
        <div class="banner warn">${icon('info')}<span class="grow">This session has no event log (older version); showing the saved file.</span></div>
        <section class="card"><div class="md sm">${C.md(cache.md || 'Empty file.')}</div></section></div>`;
    }
    const J = cache.jev;
    const { strengths, improve } = insightLists(A, J);
    const transcript = A.items.length
      ? A.items
          .map((it) => {
            const ts = C.fmtClock(it.t);
            if (it.kind === 'turn') {
              const you = it.b.src === 'voce';
              return `<div class="turn ${you ? 'you' : ''}"><span class="ts">${ts}</span><div class="stack" style="gap:6px"><span class="who">${you ? 'You' : 'Interviewer'}</span><span class="txt">${esc(it.b.text)}</span></div></div>`;
            }
            const x = it.x;
            const ok = x.status === 'completed';
            return `<div class="turn"><span class="ts">${ts}</span><div class="stack" style="gap:6px">
              <span class="who row" style="gap:8px">${icon('sparkle')}Copiloto${x.understood ? `<span class="faint truncate" style="font-weight:400">· ${esc(fixText(x.understood).slice(0, 110))}</span>` : ''}</span>
              <div class="note" style="margin-top:0"><span class="mono nowrap" style="font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid ${ok ? 'var(--accent-border)' : 'var(--danger-border)'};color:${ok ? 'var(--accent)' : 'var(--danger)'}">${ok ? `${Math.round(Number(x.ttft_ms) || 0)} ms` : esc(x.status || 'falhou')}</span><div class="md sm grow">${C.md(x.text || '')}</div></div>
            </div></div>`;
          })
          .join('')
      : `<div class="empty">${icon('text-align-left')}<span>No transcript recorded.</span></div>`;

    return `<div class="page tight">${headHtml}
      ${jevSection(s, cache, agent)}
      <section class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))">
        ${criteriaCard(J)}
        <div class="stack gap-16">${metricsCard(A)}${copilotCard(A)}</div>
      </section>
      <section class="grid-2">
        <div class="card tight"><div class="row">${icon('check-circle')}<span class="strong" style="font-size:14px">Strengths</span></div>${strengths.length ? strengths.map((x) => `<div class="bullet">${esc(fixText(x))}</div>`).join('') : `<span class="small faint">${J ? 'Nothing to highlight in this session.' : 'Shown after the JEV evaluation.'}</span>`}</div>
        <div class="card tight"><div class="row">${icon('arrow-up-right')}<span class="strong" style="font-size:14px">To improve</span></div>${improve.length ? improve.map((x) => `<div class="bullet neutral">${esc(fixText(x))}</div>`).join('') : `<span class="small faint">${J ? 'Nothing to watch out for.' : 'Shown after the JEV evaluation.'}</span>`}</div>
      </section>
      ${questionCards(J)}
      <section class="card flush">
        <div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--border-subtle)"><div class="row">${icon('text-align-left', 'faint')}<span class="strong" style="font-size:14px">Full transcript</span></div><span class="num">${plural(A.blocks.length, 'turn', 'turns')} · ${plural(A.sugg.length, 'copilot answer', 'copilot answers')}</span></div>
        ${transcript}
      </section>
    </div>`;
  };

  C.actions['gen-debrief'] = async (el) => {
    const s = S.sessions.find((x) => x.id === el.dataset.session);
    const prev = el.innerHTML;
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Gerando…';
    const res = await C.guard(() => api.generateDebrief({ agentId: el.dataset.agent, sessionId: s ? s.fileName : el.dataset.session }), 'Could not generate the debrief.');
    el.disabled = false;
    el.innerHTML = prev;
    if (!res) return;
    if (res.ok === false) {
      C.toast(res.error || 'Debrief unavailable.', 'error');
      return;
    }
    await C.refreshState();
    C.toast('Debrief saved to the session memory.');
    C.navigate(`session/${el.dataset.agent}`);
  };

  // =============================================================== FILES ==
  function fileRows() {
    const q = C.norm(S.ui.filesQuery);
    const rows = [];
    for (const a of S.agents) {
      (a.documents || []).forEach((d, idx) => {
        const name = fixText(d.title || d.name || 'Documento');
        if (q && !C.norm(`${name} ${C.agentTitle(a)} ${C.TAG_LABEL[C.docTag(d)]}`).includes(q)) return;
        rows.push({ a, d, idx, name });
      });
    }
    return rows;
  }

  C.views.files = function files() {
    const rows = fileRows();
    const agents = S.agents.filter((a) => !a.archived);
    const target = C.agentById(S.ui.filesTarget) || C.activeAgent();
    const cols = 'grid-template-columns:20px minmax(0,1fr) minmax(0,150px) minmax(0,170px) 70px 96px 56px';
    return `<div class="page tight">
      ${head('Files', 'Resume, job description and portfolio give the answers context.', `<button type="button" class="btn" data-action="paste-doc" data-agent="${esc(target ? target.id : '')}">${icon('note')}Paste text</button>`)}
      ${agents.length
        ? `<div class="row wrap"><span class="small muted">Link new files to</span><select class="select sm" style="width:auto;min-width:260px" data-change="files-target">${C.opts(agents.map((a) => [a.id, C.agentTitle(a)]), target ? target.id : '')}</select></div>
           <button type="button" class="dropzone" id="filesDrop" data-action="files-pick">
             ${icon('upload')}
             <span style="font-size:14px">Drag files or <u>choose from your computer</u></span>
             <span class="num">PDF · DOCX · TXT · MD · code</span>
           </button>`
        : `<div class="empty boxed">${icon('folder')}<span class="t">Create a session to attach files</span><button type="button" class="btn primary" data-action="new-session">${icon('plus')}New session</button></div>`}
      <div class="row between wrap">
        <div class="search-box">${icon('magnifying-glass')}<input type="text" placeholder="Search file or session" value="${esc(S.ui.filesQuery)}" data-input="files-query"/></div>
        <span class="num">${plural(rows.length, 'file', 'files')}</span>
      </div>
      <div class="card flush" id="filesTable">
        <div class="table-head" style="${cols}"><span></span><span>Name</span><span>Type</span><span>Session</span><span style="text-align:right">Size</span><span>Status</span><span></span></div>
        ${rows.length
          ? rows
              .map(({ a, d, idx, name }) => {
                const hasText = Boolean((d.content || '').trim());
                return `<div class="table-row" style="${cols};padding-top:12px;padding-bottom:12px">
                  ${icon(C.docIcon(d), 'faint')}
                  <span class="truncate" style="font-size:13.5px">${esc(name)}</span>
                  <span><select class="select sm" data-change="doc-tag" data-agent="${esc(a.id)}" data-idx="${idx}">${C.opts(Object.entries(C.TAG_LABEL), C.docTag(d))}</select></span>
                  <a class="truncate small muted" data-action="go" data-to="session/${esc(a.id)}">${esc(C.agentTitle(a))}</a>
                  <span class="num" style="text-align:right">${esc(C.fmtKb((d.content || '').length))}</span>
                  <span class="row small" style="gap:6px;color:${hasText ? 'var(--accent)' : 'var(--warning)'}"><span class="dot sm" style="background:currentColor"></span>${hasText ? 'Indexado' : 'Sem texto'}</span>
                  <span class="row" style="gap:2px;justify-content:flex-end"><button type="button" class="icon-btn" title="Preview" data-action="preview-doc" data-agent="${esc(a.id)}" data-idx="${idx}">${icon('eye')}</button><button type="button" class="icon-btn danger" title="Remove" data-action="remove-doc" data-agent="${esc(a.id)}" data-idx="${idx}">${icon('x')}</button></span>
                </div>`;
              })
              .join('')
          : `<div class="empty">${icon('file-text')}<span>${S.ui.filesQuery ? 'No files match this search.' : 'No files attached yet.'}</span></div>`}
      </div>
    </div>`;
  };

  C.afterRender.files = () => {
    const zone = document.getElementById('filesDrop');
    if (!zone) return;
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const target = C.agentById(S.ui.filesTarget) || C.activeAgent();
      if (!target) return;
      const paths = [...(e.dataTransfer.files || [])].map((f) => api.getPathForFile(f)).filter(Boolean);
      if (!paths.length) {
        C.toast('Could not read the dropped files.', 'error');
        return;
      }
      const res = await C.guard(() => api.importFiles(paths, 'material'), 'Failed to import the files.');
      await attachDocs(target, res);
    });
  };

  C.actions['files-pick'] = async () => {
    const target = C.agentById(S.ui.filesTarget) || C.activeAgent();
    if (!target) return;
    const res = await C.guard(() => api.pickFiles('material'), 'Could not open the files.');
    await attachDocs(target, res);
  };

  C.changes['files-target'] = (el) => {
    S.ui.filesTarget = el.value;
  };

  C.inputs['files-query'] = (el) => {
    S.ui.filesQuery = el.value;
    const pos = el.selectionStart;
    C.refresh();
    const again = document.querySelector('[data-input="files-query"]');
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  };

  C.changes['doc-tag'] = async (el) => {
    const a = C.agentById(el.dataset.agent);
    if (!a) return;
    const idx = Number(el.dataset.idx);
    const docs = (a.documents || []).map((d, i) => (i === idx ? { ...d, tag: el.value, path: el.value } : d));
    await C.saveAgent({ ...a, documents: docs, mini_compact: '' }, `Type changed to ${C.TAG_LABEL[el.value]}.`);
  };

  // ======================================================= QUESTION BANK ==
  // Frequency = in how many of your recorded interviews with that company the
  // question came up (interviewsCount / interviewsReported), nothing else.
  function allQuestions() {
    const out = [];
    const byText = new Map();
    for (const co of (S.questionBank && S.questionBank.companies) || []) {
      const total = Math.max(1, Number(co.interviewsReported) || 1);
      for (const q of co.questions || []) {
        const key = C.norm(q.text);
        let item = byText.get(key);
        if (!item) {
          item = { q, key, companies: [], seen: 0, total: 0 };
          byText.set(key, item);
          out.push(item);
        }
        item.companies.push(co);
        item.seen += Math.max(1, Number(q.interviewsCount) || 1);
        item.total += total;
      }
    }
    for (const it of out) it.freq = Math.round((Math.min(it.seen, it.total) / it.total) * 100);
    return out.sort((a, b) => b.seen - a.seen || b.freq - a.freq);
  }

  C.views.questions = function questions() {
    const bank = S.questionBank;
    if (!bank) {
      C.loadQuestionBank().then(() => S.route.view === 'questions' && C.refresh());
      return `<div class="page"><div class="card"><div class="skeleton" style="height:160px"></div></div></div>`;
    }
    const companies = bank.companies || [];
    const all = allQuestions();
    const coFilter = S.ui.qCompany;
    const co = companies.find((c) => c.id === coFilter);
    const cats = [...new Set(all.map((x) => C.catLabel(x.q.category)))];
    const q = C.norm(S.ui.qQuery);
    const list = all.filter((x) => {
      if (co && !x.companies.includes(co)) return false;
      if (S.ui.qCat !== 'all' && C.catLabel(x.q.category) !== S.ui.qCat) return false;
      if (q && !C.norm(`${x.q.text} ${x.q.subCategory || ''} ${x.q.category || ''}`).includes(q)) return false;
      return true;
    });
    const share = S.config.share_anonymized_questions !== false;
    const rebuilding = S.ui.qRebuilding;

    return `<div class="page tight">
      ${head('Question bank', 'Questions interviewers asked in your recorded sessions, by company and topic.',
        `<span class="status-chip"><span class="mono" style="font-size:12px">${all.length}</span><span class="faint">questions</span></span><span class="status-chip"><span class="mono" style="font-size:12px">${companies.length}</span><span class="faint">companies</span></span><button type="button" class="btn" data-action="q-rebuild" ${rebuilding ? 'disabled' : ''} title="Reads all recorded sessions again">${rebuilding ? '<span class="spinner"></span>Rebuilding…' : `${icon('refresh')}Rebuild`}</button>`)}
      <div class="banner ${share ? '' : 'warn'}">${icon('shield-check')}<span class="grow">${share ? 'At the end of each session, the interviewer questions are anonymized, validated and added here. Your answers never leave your computer.' : 'Question collection is off: new sessions do not feed the bank.'}</span>${C.sw('data-change="share-questions" aria-label="Collect questions"', share)}</div>
      ${companies.length
        ? `<nav class="tabs">
            <button type="button" class="${coFilter === 'all' ? 'active' : ''}" data-action="q-company" data-id="all">All<span class="num">${all.length}</span></button>
            ${companies
              .map((c) => `<button type="button" class="${coFilter === c.id ? 'active' : ''}" data-action="q-company" data-id="${esc(c.id)}">${c.logo ? `<span class="mono-tile xs" style="padding:0;width:20px"><img src="${esc(c.logo)}" alt=""/></span>` : `<span class="mono-tile xs">${esc(c.monogram || C.monogram(c.name))}</span>`}${esc(fixText(c.name))}<span class="num">${(c.questions || []).length}</span></button>`)
              .join('')}
          </nav>
          <section class="row wrap" style="gap:12px">
            <div class="search-box">${icon('magnifying-glass')}<input type="text" placeholder="Search question or topic" value="${esc(S.ui.qQuery)}" data-input="q-query"/></div>
            <div class="row wrap" style="gap:4px">
              <button type="button" class="filter-chip ${S.ui.qCat === 'all' ? 'active' : ''}" data-action="q-cat" data-cat="all">All</button>
              ${cats.map((c) => `<button type="button" class="filter-chip ${S.ui.qCat === c ? 'active' : ''}" data-action="q-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
            </div>
          </section>
          <section class="stack gap-8">
            <div class="row between" style="padding:0 2px"><span class="eyebrow">${plural(list.length, 'result', 'results')}${co ? ` · ${esc(fixText(co.name))} · ${plural(Number(co.interviewsReported) || 1, 'interview', 'interviews')}` : ''}</span><span class="small faint">Most frequent first</span></div>
            ${list.length ? list.map((x) => qCard(x)).join('') : `<div class="card"><div class="empty">No questions match these filters.</div></div>`}
          </section>`
        : `<div class="empty boxed">${icon('question')}<span class="t">The bank is still empty</span><span>It is built from what the interviewer said in your recorded sessions.</span>${S.sessions.some((s) => s.hasEvents) ? `<button type="button" class="btn primary" data-action="q-rebuild" ${rebuilding ? 'disabled' : ''}>${icon('refresh')}Build from ${plural(S.sessions.filter((s) => s.hasEvents).length, 'session', 'sessions')}</button>` : ''}</div>`}
    </div>`;
  };

  function qCard(x) {
    const open = S.ui.qOpen === x.key;
    const text = fixText(x.q.text);
    const sub = fixText(x.q.subCategory || '');
    const agents = S.agents.filter((a) => !a.archived);
    return `<div class="qcard ${open ? 'open' : ''}">
      <button type="button" data-action="q-toggle" data-key="${esc(x.key)}">
        <div class="stack grow" style="gap:10px">
          <span class="q">${esc(text)}</span>
          <div class="row wrap" style="gap:8px 12px">
            <span class="small muted nowrap">${esc(C.catLabel(x.q.category))}</span>
            <span class="row" style="gap:3px">${x.companies.slice(0, 3).map((c) => `<span class="mono-tile xs">${esc(c.monogram || C.monogram(c.name))}</span>`).join('')}${x.companies.length > 3 ? `<span class="xs faint" style="margin-left:4px">+${x.companies.length - 3}</span>` : ''}</span>
            ${sub && sub !== C.catLabel(x.q.category) ? `<span class="tag">${esc(sub.split(' · ')[0])}</span>` : ''}
          </div>
        </div>
        <div class="stack" style="align-items:flex-end;gap:6px;flex:none" title="In ${x.seen} of ${x.total} interviews"><span class="mono" style="font-size:12px;color:var(--text-body)">${x.seen}/${x.total}</span>${pctBar(x.freq, 'w56')}</div>
        ${icon(open ? 'caret-up' : 'caret-down', 'faint')}
      </button>
      ${open
        ? `<div class="detail">
            <div class="grid-3" style="padding-top:14px;gap:18px">
              <div class="stack gap-8"><span class="eyebrow">Empresas</span><div class="row wrap" style="gap:6px">${x.companies.map((c) => `<span class="chip"><span class="mono-tile xs" style="height:18px">${esc(c.monogram || C.monogram(c.name))}</span>${esc(fixText(c.name))}</span>`).join('')}</div></div>
              <div class="stack gap-8"><span class="eyebrow">Cargo</span><div class="row wrap" style="gap:6px">${[...new Set(x.companies.map((c) => fixText(c.role || '')).filter(Boolean))].map((r) => `<span class="chip">${esc(r)}</span>`).join('') || '<span class="small faint">—</span>'}</div></div>
              <div class="stack gap-8"><span class="eyebrow">Frequency</span><span class="small muted">Appeared in ${x.seen} of ${plural(x.total, 'recorded interview', 'recorded interviews')}${x.q.lastReported && x.q.lastReported !== 'Today' ? ` · last on ${esc(x.q.lastReported)}` : ''}</span></div>
            </div>
            <div class="row wrap">
              <button type="button" class="btn primary lg" data-action="q-practice" data-key="${esc(x.key)}">${icon('microphone')}Practice with AI</button>
              ${agents.length ? `<select class="select sm" style="width:auto;max-width:260px" id="qAddTarget">${C.opts(agents.map((a) => [a.id, C.agentTitle(a)]), (C.activeAgent() || {}).id)}</select><button type="button" class="btn lg" data-action="q-add" data-key="${esc(x.key)}">${icon('bookmark')}Add to session</button>` : ''}
              <button type="button" class="btn lg ghost" data-action="q-copy" data-key="${esc(x.key)}">${icon('copy')}Copy</button>
            </div>
          </div>`
        : ''}
    </div>`;
  }

  function findQ(key) {
    return allQuestions().find((x) => x.key === key);
  }

  C.actions['q-company'] = (el) => {
    S.ui.qCompany = el.dataset.id;
    S.ui.qOpen = '';
    C.refresh();
  };
  C.actions['q-cat'] = (el) => {
    S.ui.qCat = el.dataset.cat;
    C.refresh();
  };
  C.actions['q-toggle'] = (el) => {
    S.ui.qOpen = S.ui.qOpen === el.dataset.key ? '' : el.dataset.key;
    C.refresh();
  };
  C.inputs['q-query'] = (el) => {
    S.ui.qQuery = el.value;
    const pos = el.selectionStart;
    C.refresh();
    const again = document.querySelector('[data-input="q-query"]');
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  };
  C.changes['share-questions'] = async (el) => {
    const on = el.checked;
    await C.guard(() => api.setQuestionSharing(on), 'Could not change collection.');
    S.config.share_anonymized_questions = on;
    C.toast(on ? 'Question collection on.' : 'Question collection off.');
    C.refresh();
  };
  C.actions['q-rebuild'] = async () => {
    S.ui.qRebuilding = true;
    C.refresh();
    const res = await C.guard(() => api.rebuildQuestionBank(), 'Could not rebuild the bank.');
    S.ui.qRebuilding = false;
    if (res && res.bank) {
      S.questionBank = res.bank;
      S.ui.qCompany = 'all';
      C.toast(`Bank rebuilt: ${plural(res.added || 0, 'question', 'questions')} from your sessions.`);
    }
    C.renderShell();
    C.refresh();
  };
  C.actions['q-copy'] = async (el) => {
    const x = findQ(el.dataset.key);
    if (!x) return;
    try {
      await navigator.clipboard.writeText(fixText(x.q.text));
      C.toast('Question copied.');
    } catch (_e) {
      C.toast('Could not copy.', 'error');
    }
  };
  C.actions['q-add'] = async (el) => {
    const x = findQ(el.dataset.key);
    const sel = document.getElementById('qAddTarget');
    const a = sel && C.agentById(sel.value);
    if (!x || !a) return;
    const line = `Likely question: ${fixText(x.q.text)}`;
    const cur = fixText(a.extra_instructions || a.custom_instructions || '');
    if (cur.includes(line)) {
      C.toast('This question is already in the session.');
      return;
    }
    const next = cur ? `${cur}\n${line}` : line;
    await C.saveAgent({ ...a, extra_instructions: next, custom_instructions: next, mini_compact: '' }, `Added to the instructions of ${C.agentTitle(a)}.`);
  };
  C.actions['q-practice'] = async (el) => {
    const x = findQ(el.dataset.key);
    if (!x) return;
    const text = fixText(x.q.text);
    if (S.overlayStatus.running) {
      const res = await C.guard(() => api.overlayCommand({ cmd: 'chat', text: `Como eu responderia: "${text}"` }));
      if (res && res.ok) {
        C.toast('Question sent to the copilot.');
        C.navigate('live');
      } else {
        C.toast((res && res.error) || 'The copilot did not receive the question.', 'error');
      }
      return;
    }
    const match = S.agents.find((a) => x.companies.some((c) => C.norm(c.name) === C.norm(C.agentCompany(a)))) || C.activeAgent();
    S.ui.pendingChat = `Como eu responderia: "${text}"`;
    await C.startCopilot(match, true);
  };
})();
