// lipcue.com dashboard — Profile. Every number comes from what really happened on
// this computer: live sessions, mock interviews, pair programming runs and JEV
// evaluations. XP and achievements are derived from those records and grant no
// minutes, because only the server can vouch for a reward.
'use strict';

(function profileModule() {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon } = C;

  const D = { loaded: false, loading: false, pair: { submissions: [], sessions: [] }, jev: [], mocks: [], catalog: null, copied: false };
  C.profileData = D;

  const LEVEL_XP = 250;
  const RELOAD_AFTER_MS = 3000;
  const attemptedText = (n) => (n === 1 ? C.t('1 attempted') : C.t('{n} attempted', { n }));
  const JEV_SKILLS = [['adequacao', 'Relevance'], ['cultura', 'Culture'], ['estrutura', 'Structure'], ['evidencias', 'Evidence'], ['objetividade', 'Objectivity']];
  const STAGE_ORDER = ['Applied', 'Screening', 'Technical', 'Final', 'Offer'];
  const ERRORS = [['wrong', 'Wrong answer', 'var(--danger-bright)'], ['runtime', 'Runtime error', 'var(--warning)'], ['compile', 'Compile error', 'var(--text-tertiary)'], ['timeout', 'Time limit', 'var(--accent)']];

  async function load() {
    if (D.loading || !api.pairHistory) return;
    D.loading = true;
    const [pair, jev, mocks, catalog] = await Promise.all([api.pairHistory(), api.jevHistory(), api.mockList(), api.pairCatalog()]);
    D.pair = pair || D.pair;
    D.jev = Array.isArray(jev) ? jev : [];
    D.mocks = Array.isArray(mocks) ? mocks : [];
    D.catalog = catalog;
    D.loaded = true;
    D.loadedAt = Date.now();
    D.loading = false;
    if (S.route.view === 'profile') C.refresh();
  }

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Longest and current run of consecutive days. A current streak survives until
  // the end of the day after the last activity.
  function streaks(days, today) {
    let longest = 0;
    let run = 0;
    let prev = null;
    for (const key of [...days].sort()) {
      const d = new Date(`${key}T12:00:00`);
      run = prev && Math.round((d - prev) / 864e5) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    let current = 0;
    const cursor = new Date(today);
    if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(dayKey(cursor))) {
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { longest, current };
  }

  // The whole page's numbers from plain records. Pure, so it can be tested.
  function computeStats({ sessions, mocks, pair, jev, problems, agents, sessionDate, now }) {
    const submissions = pair.submissions || [];
    const byId = new Map((problems || []).map((p) => [p.id, p]));
    const accepted = submissions.filter((s) => s.status === 'accepted');
    const solvedIds = new Set(accepted.map((s) => s.problemId).filter((id) => byId.has(id)));
    const attempted = new Set(submissions.map((s) => s.problemId));
    const solvedBy = { Easy: 0, Medium: 0, Hard: 0 };
    const totalBy = { Easy: 0, Medium: 0, Hard: 0 };
    for (const p of problems || []) {
      totalBy[p.difficulty] += 1;
      if (solvedIds.has(p.id)) solvedBy[p.difficulty] += 1;
    }
    const errors = {};
    for (const [k] of ERRORS) errors[k] = submissions.filter((s) => s.status === k).length;

    const evaluated = sessions.filter((s) => Number.isFinite(s.jevScore));
    const scores = [...evaluated.map((s) => s.jevScore), ...mocks.map((m) => m.evaluation && m.evaluation.score).filter(Number.isFinite)];
    const jevAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const skills = JEV_SKILLS.map(([k, label]) => {
      const vals = [...jev, ...mocks.map((m) => m.evaluation).filter(Boolean)].map((e) => e.criteria && e.criteria[k]).filter(Number.isFinite);
      return { key: k, label, value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, count: vals.length };
    });

    // One count per day, from every kind of practice.
    const perDay = new Map();
    const bump = (ms) => {
      if (!Number.isFinite(ms)) return;
      const key = dayKey(new Date(ms));
      perDay.set(key, (perDay.get(key) || 0) + 1);
    };
    for (const s of submissions) bump(s.ts);
    for (const m of mocks) bump(m.startedAt);
    for (const s of pair.sessions || []) bump(s.ts);
    for (const s of sessions) {
      const d = sessionDate(s);
      if (d) bump(d.getTime());
    }
    const streak = streaks(new Set(perDay.keys()), now);

    const langs = new Set(accepted.map((s) => s.language));
    const hardSolved = solvedBy.Hard > 0;
    const allEasy = totalBy.Easy > 0 && solvedBy.Easy === totalBy.Easy;
    const allSolved = byId.size > 0 && solvedIds.size === byId.size;
    const bestScore = scores.length ? Math.max(...scores) : 0;
    const activeAgents = agents.filter((a) => !a.archived);
    const reached = (stage) => activeAgents.filter((a) => STAGE_ORDER.indexOf(a.stage) >= STAGE_ORDER.indexOf(stage)).length;

    const count = (n, target) => `${Math.min(n, target)}/${target}`;
    const achievements = [
      { id: 'first-session', icon: 'broadcast', title: 'First live session', done: sessions.length >= 1, progress: count(sessions.length, 1) },
      { id: 'ten-sessions', icon: 'history', title: '10 live sessions', done: sessions.length >= 10, progress: count(sessions.length, 10) },
      { id: 'first-mock', icon: 'robot', title: 'First mock interview', done: mocks.length >= 1, progress: count(mocks.length, 1) },
      { id: 'five-mocks', icon: 'microphone', title: '5 mock interviews', done: mocks.length >= 5, progress: count(mocks.length, 5) },
      { id: 'first-solve', icon: 'code', title: 'First problem solved', done: solvedIds.size >= 1, progress: count(solvedIds.size, 1) },
      { id: 'all-easy', icon: 'check-circle', title: 'All easy problems', done: allEasy, progress: count(solvedBy.Easy, totalBy.Easy) },
      { id: 'hard-solve', icon: 'lightning', title: 'Solved a hard problem', done: hardSolved, progress: count(solvedBy.Hard, 1) },
      { id: 'all-solved', icon: 'target', title: 'Every problem solved', done: allSolved, progress: count(solvedIds.size, byId.size) },
      { id: 'polyglot', icon: 'globe', title: 'Solved in 2 languages', done: langs.size >= 2, progress: count(langs.size, 2) },
      { id: 'streak-7', icon: 'calendar', title: '7-day streak', done: streak.longest >= 7, progress: count(streak.longest, 7) },
      { id: 'jev-80', icon: 'sparkle', title: 'JEV score of 8.0', done: bestScore >= 80, progress: bestScore ? (bestScore / 10).toFixed(1) : '—' },
      { id: 'offer', icon: 'flag', title: 'Reached an offer', done: reached('Offer') >= 1, progress: count(reached('Offer'), 1) }
    ];

    const xp = sessions.length * 40 + evaluated.length * 20 + mocks.length * 60 + submissions.length * 5
      + solvedBy.Easy * 50 + solvedBy.Medium * 100 + solvedBy.Hard * 150;
    const level = Math.floor(xp / LEVEL_XP) + 1;

    return {
      xp, level, levelXp: xp % LEVEL_XP, solved: solvedIds.size, attempted: attempted.size, solvedBy, totalBy, submissions: submissions.length,
      accepted: accepted.length, errors, errorsTotal: submissions.length - accepted.length, jevAvg, skills, perDay, streak, achievements,
      funnel: [['Processes', activeAgents.length], ...STAGE_ORDER.slice(1).map((st) => [st, reached(st)])],
      activeProcesses: activeAgents.filter((a) => a.stage !== 'Closed').length,
      questions: sessions.reduce((sum, s) => sum + (Number(s.questionsCount) || 0), 0)
    };
  }
  C.profileStats = computeStats;

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function heatClass(n) {
    return n <= 0 ? '' : n === 1 ? 'heat-1' : n === 2 ? 'heat-2' : n <= 4 ? 'heat-3' : 'heat-4';
  }

  function hero(st, name) {
    const p = S.profile || {};
    const u = C.usage();
    const sub = [p.headline, p.seniority].filter(Boolean).join(' · ');
    const toNext = LEVEL_XP - st.levelXp;
    return `<section class="card aurora prof-hero">
      <div class="prof-avatar" style="--p:${pct(st.levelXp, LEVEL_XP)}"><div data-no-i18n>${esc(initials(name))}</div><span class="prof-level" data-no-i18n>${esc(C.t('LEVEL {n}', { n: st.level }))}</span></div>
      <div class="stack" style="gap:8px;min-width:0">
        <div class="row" style="gap:10px"><h1 class="h1" style="font-size:28px;line-height:1.1" data-no-i18n>${esc(name || C.t('Your profile'))}</h1>${u.planLabel ? `<span class="plan-badge">${esc(u.planLabel)}</span>` : ''}</div>
        ${sub ? `<span class="on-aurora-soft" data-no-i18n>${esc(C.fixText(sub))}</span>` : '<span class="on-aurora-soft">Add your role and seniority in Edit profile.</span>'}
        <div class="prof-xp"><div class="bar6"><i style="width:${pct(st.levelXp, LEVEL_XP)}%"></i></div><span class="num on-aurora-soft" style="font-size:12px" data-no-i18n>${esc(C.t('{xp} / {max} XP · {left} XP to level {next}', { xp: st.levelXp, max: LEVEL_XP, left: toNext, next: st.level + 1 }))}</span></div>
      </div>
      <div class="stack" style="gap:8px">
        <button type="button" class="btn primary lg" data-action="profile-copy">${icon(D.copied ? 'check' : 'copy')}${D.copied ? 'Copied' : 'Copy summary'}</button>
        <button type="button" class="btn glass lg" data-action="open-profile">Edit profile</button>
      </div>
    </section>`;
  }

  function statStrip(st) {
    const items = [
      ['Live sessions', String(S.sessions.length), st.questions ? C.t('{n} questions', { n: st.questions }) : '—', ''],
      ['Mock interviews', String(D.mocks.length), D.mocks.length ? C.t('{n} evaluated', { n: D.mocks.filter((m) => m.evaluation).length }) : '—', ''],
      ['Problems solved', `${st.solved}`, attemptedText(st.attempted), ''],
      ['Average JEV', st.jevAvg == null ? '—' : (st.jevAvg / 10).toFixed(1), st.streak.current === 1 ? C.t('1-day streak') : st.streak.current ? C.t('{n}-day streak', { n: st.streak.current }) : C.t('No streak yet'), st.streak.current ? 'up' : '']
    ];
    return `<section class="stat-strip">${items.map(([l, v, d, c]) => `<div class="stat"><span class="stat-l">${l}</span><span class="stat-v">${esc(v)}</span><span class="stat-d ${c}" data-no-i18n>${esc(d)}</span></div>`).join('')}</section>`;
  }

  function solvedCard(st) {
    const total = (D.catalog ? D.catalog.problems.length : 0) || 1;
    const seg = (n) => (n / total) * 100;
    const e = seg(st.solvedBy.Easy);
    const m = e + seg(st.solvedBy.Medium);
    const h = m + seg(st.solvedBy.Hard);
    const donut = `conic-gradient(var(--accent-bright) 0 ${e}%, var(--warning) ${e}% ${m}%, var(--danger-bright) ${m}% ${h}%, var(--track) ${h}% 100%)`;
    const rows = [['Easy', 'var(--accent-bright)'], ['Medium', 'var(--warning)'], ['Hard', 'var(--danger-bright)']];
    return `<section class="card prof-solved">
      <div class="prof-donut" style="--donut:${donut}"><div><span class="row" style="align-items:baseline;gap:2px"><span class="mono" style="font-size:32px;font-weight:600;letter-spacing:-.03em">${st.solved}</span><span class="num" style="font-size:13px">/${D.catalog ? D.catalog.problems.length : 0}</span></span><span class="small" style="color:var(--accent-bright);font-weight:500">Solved</span><span class="num" style="font-size:11px" data-no-i18n>${esc(attemptedText(st.attempted))}</span></div></div>
      <div class="stack" style="gap:14px">
        <span class="eyebrow">Problems · pair programming</span>
        ${rows.map(([d, color]) => `<div class="stack" style="gap:6px"><div class="row between" style="align-items:baseline"><span class="small" style="color:${color};font-weight:500">${d}</span><span class="num mid" data-no-i18n><span class="strong">${st.solvedBy[d]}</span> / ${st.totalBy[d]}</span></div><div class="bar6"><i style="width:${pct(st.solvedBy[d], st.totalBy[d])}%;background:${color}"></i></div></div>`).join('')}
      </div>
      <div class="stack prof-divided" style="gap:14px">
        <span class="eyebrow" data-no-i18n>${esc(C.t('Submissions · {n} in total', { n: st.submissions }))}</span>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          <div class="stack" style="gap:3px"><span class="small muted">Accepted</span><span class="mono" style="font-size:22px;font-weight:600;color:var(--accent-bright)">${st.accepted}</span></div>
          <div class="stack" style="gap:3px"><span class="small muted">Errors</span><span class="mono" style="font-size:22px;font-weight:600;color:var(--danger-bright)">${st.errorsTotal}</span></div>
          <div class="stack" style="gap:3px"><span class="small muted">Acceptance</span><span class="mono" style="font-size:22px;font-weight:600">${st.submissions ? `${pct(st.accepted, st.submissions)}%` : '—'}</span></div>
        </div>
        <div class="err-bar">${ERRORS.map(([k, , color]) => (st.errors[k] ? `<i style="flex:${st.errors[k]};background:${color}"></i>` : '')).join('')}</div>
        <div class="err-legend">${ERRORS.map(([k, label, color]) => `<span><i style="background:${color}"></i><em>${label}</em><b>${st.errors[k]}</b></span>`).join('')}</div>
      </div>
    </section>`;
  }

  function yearCard(st, now) {
    const start = new Date(now);
    start.setDate(start.getDate() - 52 * 7 - start.getDay());
    const cells = [];
    let total = 0;
    let activeDays = 0;
    const months = [];
    for (let i = 0, d = new Date(start); d <= now; i += 1, d.setDate(d.getDate() + 1)) {
      const n = st.perDay.get(dayKey(d)) || 0;
      total += n;
      if (n) activeDays += 1;
      cells.push(`<i class="${heatClass(n)}" title="${dayKey(d)}: ${n}"></i>`);
      if (d.getDate() === 1 && d.getMonth() % 3 === 0) months.push(d.toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', year: '2-digit' }));
    }
    return `<section class="card" style="gap:14px;padding:20px 22px">
      <div class="row between wrap" style="gap:10px"><span class="strong" style="font-size:15px" data-no-i18n>${esc(total === 1 ? C.t('1 practice activity in the last year') : C.t('{n} practice activities in the last year', { n: total }))}</span><span class="row small muted" style="gap:16px"><span>Active days <span class="mono" style="color:var(--text)">${activeDays}</span></span><span>Longest streak <span class="mono" style="color:var(--text)">${st.streak.longest}</span></span></span></div>
      <div class="year-grid">${cells.join('')}</div>
      <div class="row between num" style="font-size:11px" data-no-i18n>${months.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
    </section>`;
  }

  function funnelCard(st) {
    const max = Math.max(1, ...st.funnel.map(([, v]) => v));
    return `<section class="card" style="gap:16px">
      <div class="row between"><span class="eyebrow">Hiring funnel</span><a class="small" style="color:var(--accent-bright)" data-action="go" data-to="sessions">Edit</a></div>
      <span class="small muted" data-no-i18n>${esc(st.activeProcesses === 1 ? C.t('1 active process, from the stage of each session') : st.activeProcesses ? C.t('{n} active processes, from the stage of each session', { n: st.activeProcesses }) : C.t('Set the process stage on each session to fill this in.'))}</span>
      <div class="stack" style="gap:0">${st.funnel.map(([label, v]) => `<div class="funnel-row"><span>${esc(label)}</span><div class="bar8"><i style="width:${pct(v, max)}%"></i></div><span class="score-num">${v}</span></div>`).join('')}</div>
    </section>`;
  }

  function streakCard(st, now) {
    const start = new Date(now);
    start.setDate(start.getDate() - 41);
    const cells = [];
    for (let i = 0, d = new Date(start); i < 42; i += 1, d.setDate(d.getDate() + 1)) cells.push(`<i class="${heatClass(st.perDay.get(dayKey(d)) || 0)}"></i>`);
    const left = 7 - st.streak.current;
    const note = st.streak.current === 0 ? C.t('Practice today to start a streak.')
      : left === 1 ? C.t('1 more day to reach a 7-day streak.') : st.streak.current < 7 ? C.t('{n} more days to reach a 7-day streak.', { n: left })
        : C.t('Keep it going: your longest streak is {n} days.', { n: st.streak.longest });
    return `<section class="card" style="gap:14px">
      <div class="row between"><span class="eyebrow">Training streak</span><span class="mono" style="font-size:13px;font-weight:600;color:var(--accent-bright)" data-no-i18n>${esc(st.streak.current === 1 ? C.t('1 day') : C.t('{n} days', { n: st.streak.current }))}</span></div>
      <div class="streak-grid">${cells.join('')}</div>
      <div class="row between num" style="font-size:11px"><span>6 weeks ago</span><span>today</span></div>
      <span class="small muted" data-no-i18n>${esc(note)}</span>
    </section>`;
  }

  function badgesCard(st) {
    const done = st.achievements.filter((a) => a.done).length;
    return `<section class="card" style="gap:14px" data-tour="profile-badges">
      <div class="row between wrap" style="gap:8px"><span class="eyebrow" data-no-i18n>${esc(C.t('Achievements · {n} of {total}', { n: done, total: st.achievements.length }))}</span><span class="small muted">Earned from your real activity on this computer</span></div>
      <div class="badge-grid">${st.achievements.map((a) => `<div class="badge ${a.done ? 'on' : ''}"><div class="badge-i">${icon(a.icon)}</div><span class="badge-t">${esc(a.title)}</span><span class="badge-r">${a.done ? esc(C.t('Unlocked')) : esc(a.progress)}</span></div>`).join('')}</div>
    </section>`;
  }

  function skillsCard(st) {
    const evaluated = Math.max(...st.skills.map((s) => s.count), 0);
    return `<section class="card" style="gap:12px">
      <span class="eyebrow">Skills · average JEV score</span>
      ${st.skills.map((s) => {
        const tone = C.scoreTone(s.value);
        return `<div class="skill-row"><span>${esc(s.label)}</span><div class="bar6"><i style="width:${s.value == null ? 0 : s.value}%;background:${tone.color}"></i></div><span class="score-num" style="color:${tone.color}">${s.value == null ? '—' : (s.value / 10).toFixed(1)}</span></div>`;
      }).join('')}
      <span class="small faint" data-no-i18n>${esc(evaluated === 1 ? C.t('From 1 evaluated interview.') : evaluated ? C.t('From {n} evaluated interviews.', { n: evaluated }) : C.t('Evaluate a session or finish a mock interview to see this.'))}</span>
    </section>`;
  }

  // The share card only says what the records prove. No name and no company: the
  // text leaves this computer only when the person shares it.
  function shareFacts(st) {
    const parts = [];
    if (st.jevAvg != null) parts.push([(st.jevAvg / 10).toFixed(1), 'JEV']);
    if (st.solved) parts.push([String(st.solved), st.solved === 1 ? C.t('problem solved') : C.t('problems solved')]);
    if (st.questions) parts.push([String(st.questions), st.questions === 1 ? C.t('question') : C.t('questions')]);
    if (st.streak.longest) parts.push([String(st.streak.longest), st.streak.longest === 1 ? C.t('training day in a row') : C.t('training days in a row')]);
    return parts;
  }

  function shareText(st) {
    const facts = shareFacts(st).map(([v, l]) => `${v} ${l}`).join(' · ');
    return `${C.t('Preparing for interviews with LipCue: level {n}.', { n: st.level })}${facts ? ` ${facts}.` : ''}`;
  }

  function shareCard(st) {
    const facts = shareFacts(st);
    return `<section class="card aurora" style="gap:12px">
      <span class="eyebrow on-aurora">Achievement card</span>
      ${facts.length ? `<div class="share-card">
        <span class="share-t" data-no-i18n>${esc(C.t('Preparing for interviews with LipCue: level {n}.', { n: st.level }))}</span>
        <div class="share-stats" data-no-i18n>${facts.map(([v, l]) => `<span><b>${esc(v)}</b> ${esc(l)}</span>`).join('')}</div>
      </div>
      <div class="row wrap" style="gap:8px">
        <button type="button" class="btn primary sm grow" data-action="profile-linkedin">Share on LinkedIn</button>
        <button type="button" class="btn glass sm" data-action="profile-image">${icon('download')}Download image</button>
      </div>` : '<span class="on-aurora-soft">Finish a session, a mock interview or a problem to create your card.</span>'}
    </section>`;
  }

  function performance() {
    return `<section class="two-eq">
      <div class="card" style="gap:12px"><span class="eyebrow">Answer speed</span>${C.latencyChart()}</div>
      <div class="card" style="gap:12px"><span class="eyebrow">Questions by category</span>${C.categoryBars().html}</div>
    </section>`;
  }

  function stats() {
    return computeStats({
      sessions: S.sessions, mocks: D.mocks, pair: D.pair, jev: D.jev, problems: D.catalog ? D.catalog.problems : [],
      agents: S.agents, sessionDate: C.sessionDate, now: new Date()
    });
  }

  C.views.profile = () => {
    const acct = (S.auth && S.auth.signedIn && S.auth.account) || null;
    const name = C.fixText((acct && acct.name) || (S.profile && S.profile.name) || '');
    const st = stats();
    const now = new Date();
    return `<div class="page design-page prof-page">
      ${hero(st, name)}
      ${statStrip(st)}
      ${solvedCard(st)}
      ${yearCard(st, now)}
      <section class="two-1">${funnelCard(st)}${streakCard(st, now)}</section>
      ${badgesCard(st)}
      <section class="two-eq">${skillsCard(st)}${shareCard(st)}</section>
      ${performance()}
    </div>`;
  };

  C.afterRender.profile = () => {
    // Coming back after a pair session or a mock interview must show the new numbers.
    if (!D.loaded || Date.now() - D.loadedAt > RELOAD_AFTER_MS) load();
  };

  C.actions['profile-copy'] = async () => {
    try {
      await navigator.clipboard.writeText(shareText(stats()));
      D.copied = true;
      C.refresh();
      setTimeout(() => {
        D.copied = false;
        C.refresh();
      }, 1600);
    } catch (_e) {
      C.toast('Could not copy the summary.', 'error');
    }
  };

  C.actions['profile-linkedin'] = () => {
    api.openUrl(`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(shareText(stats()))}`);
  };

  // A PNG of the card, drawn locally. Canvas colors are rgb() like the rest of the app.
  C.actions['profile-image'] = () => {
    const st = stats();
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 628;
    const ctx = canvas.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, 1200, 628);
    bg.addColorStop(0, 'rgb(12,13,12)');
    bg.addColorStop(0.55, 'rgb(26,68,44)');
    bg.addColorStop(1, 'rgb(12,13,12)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1200, 628);
    ctx.fillStyle = 'rgb(74,222,128)';
    ctx.font = '600 34px Geist, sans-serif';
    ctx.fillText('LipCue', 72, 96);
    ctx.fillStyle = 'rgb(244,244,245)';
    ctx.font = '600 56px Geist, sans-serif';
    const line = C.t('Preparing for interviews with LipCue: level {n}.', { n: st.level });
    const words = line.split(' ');
    let y = 230;
    let row = '';
    for (const w of words) {
      const next = row ? `${row} ${w}` : w;
      if (ctx.measureText(next).width > 1040) {
        ctx.fillText(row, 72, y);
        y += 70;
        row = w;
      } else {
        row = next;
      }
    }
    ctx.fillText(row, 72, y);
    let x = 72;
    for (const [v, l] of shareFacts(st)) {
      ctx.fillStyle = 'rgb(74,222,128)';
      ctx.font = '600 44px "Geist Mono", monospace';
      ctx.fillText(v, x, 500);
      ctx.fillStyle = 'rgb(196,201,197)';
      ctx.font = '400 22px Geist, sans-serif';
      ctx.fillText(l, x, 540);
      x += Math.max(ctx.measureText(l).width, 120) + 56;
    }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'lipcue-achievement.png';
    a.click();
  };
})();
