// lipcue.com dashboard — dialogs: new/edit session, scheduler, profile, session
// summary, document preview, paste text, playbook, confirm and the Ctrl+K
// command palette.
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon, fixText, plural } = C;

  const stack = [];

  function root() {
    return document.getElementById('modalRoot');
  }

  function mount(html, opts) {
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.innerHTML = html;
    const entry = { layer, onClose: opts && opts.onClose, dismissable: !(opts && opts.sticky) };
    layer.addEventListener('mousedown', (e) => {
      if (e.target === layer && entry.dismissable) close(entry);
    });
    root().appendChild(layer);
    window.CueIcons.hydrateIcons(layer);
    stack.push(entry);
    const focus = layer.querySelector('[autofocus]') || layer.querySelector('input:not([type=hidden]),textarea,select');
    if (focus) setTimeout(() => focus.focus(), 40);
    return entry;
  }

  function close(entry) {
    const e = entry || stack[stack.length - 1];
    if (!e) return;
    const i = stack.indexOf(e);
    if (i >= 0) stack.splice(i, 1);
    e.layer.remove();
    if (e.onClose) e.onClose();
  }

  C.closeTopModal = () => {
    const top = stack[stack.length - 1];
    if (top && top.dismissable) close(top);
  };

  function headHtml(title, sub) {
    return `<div class="modal-head"><div class="stack grow" style="gap:2px"><span class="t">${esc(title)}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div><button type="button" class="icon-btn" data-action="modal-close" title="Close">${icon('x')}</button></div>`;
  }

  C.actions['modal-close'] = () => close();

  // Promise-based confirm used across views.
  C.confirm = (title, body, okLabel) =>
    new Promise((resolve) => {
      let done = false;
      const entry = mount(
        `<div class="modal" role="alertdialog">
          ${headHtml(title)}
          <div class="modal-body"><span class="muted" style="font-size:13px">${esc(body || '')}</span></div>
          <div class="modal-foot"><button type="button" class="btn lg" data-cf="0">Cancel</button><button type="button" class="btn lg ${/delete|remove|sign out/i.test(okLabel || '') ? 'danger' : 'primary'}" data-cf="1" autofocus>${esc(okLabel || 'Confirm')}</button></div>
        </div>`,
        {
          onClose: () => {
            if (!done) resolve(false);
          }
        }
      );
      entry.layer.querySelectorAll('[data-cf]').forEach((b) =>
        b.addEventListener('click', () => {
          done = true;
          resolve(b.dataset.cf === '1');
          close(entry);
        })
      );
    });

  const MODALS = {};
  C.openModal = (name, data) => {
    const fn = MODALS[name];
    if (fn) fn(data);
  };

  // ------------------------------------------------------- new session --
  function newSession(prefill) {
    const st = {
      step: 1,
      role: (prefill && prefill.role) || '',
      company: (prefill && prefill.company) || '',
      date: '',
      time: '',
      format: '',
      job: '',
      research: true,
      picked: new Set(),
      uploads: []
    };
    const existing = C.allDocs();
    // The résumé is the copilot's main source: preselect the newest one.
    const resume = existing.find((d) => C.docTag(d) === 'resume');
    if (resume) st.picked.add(existing.indexOf(resume));

    const entry = mount('<div class="modal" id="nsModal"></div>');
    const box = entry.layer.querySelector('#nsModal');

    function paint() {
      const step1 = `
        <div class="modal-body">
          <label class="field">Role<input class="input" id="nsRole" value="${esc(st.role)}" placeholder="E.g. Senior Product Designer" autofocus/></label>
          <div class="form-grid">
            <label class="field">Company<input class="input" id="nsCompany" value="${esc(st.company)}" placeholder="E.g. Nubank or nubank.com.br"/></label>
            <div class="form-grid" style="gap:8px"><label class="field">Date<input class="input" type="date" id="nsDate" value="${esc(st.date)}"/></label><label class="field">Time<input class="input" type="time" id="nsTime" value="${esc(st.time)}"/></label></div>
          </div>
          <div class="field">Format
            <div class="row wrap" style="gap:4px">${C.FORMATS.map((f) => `<button type="button" class="filter-chip ${st.format === f ? 'active' : ''}" data-ns-format="${esc(f)}">${esc(f)}</button>`).join('')}</div>
          </div>
          <label class="field">Job description <span class="hint">optional, helps the copilot a lot</span><textarea class="textarea" id="nsJob" rows="3" placeholder="Paste the job description">${esc(st.job)}</textarea></label>
        </div>`;
      const all = [...existing, ...st.uploads];
      const step2 = `
        <div class="modal-body" style="gap:6px">
          <span class="small muted" style="padding-bottom:4px">Context the AI should use</span>
          ${all.length
            ? all
                .map((d, i) => {
                  const on = st.picked.has(i);
                  return `<button type="button" class="check-row ${on ? 'on' : ''}" data-ns-pick="${i}"><span class="box">${icon('check')}</span><span class="grow truncate">${esc(fixText(d.title || d.name || 'Document'))}</span><span class="xs faint">${esc(C.TAG_LABEL[C.docTag(d)])}</span></button>`;
                })
                .join('')
            : '<div class="empty" style="padding:20px">No files yet. Upload your resume for answers based on your experience.</div>'}
          <button type="button" class="btn" style="margin-top:6px;align-self:flex-start" data-ns-upload="1">${icon('upload')}Upload files</button>
          <label class="toggle-row" style="margin-top:8px;cursor:pointer"><span class="txt"><span class="t">Research the company automatically</span><span class="s">Builds a brief (product, culture, news) for the copilot.</span></span>${C.sw('id="nsResearch"', st.research)}</label>
        </div>`;
      box.innerHTML = `
        ${headHtml('New session', `Step ${st.step} / 2`)}
        ${st.step === 1 ? step1 : step2}
        <div class="modal-foot"><button type="button" class="btn lg" data-ns-back="1">${st.step === 1 ? 'Cancel' : 'Back'}</button><button type="button" class="btn primary lg" data-ns-next="1">${st.step === 1 ? 'Continue' : 'Create session'}</button></div>`;
      window.CueIcons.hydrateIcons(box);
      const role = box.querySelector('#nsRole');
      if (role) setTimeout(() => role.focus(), 30);
      box.querySelectorAll('input').forEach((inp) =>
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            next();
          }
        })
      );
    }

    function capture() {
      if (st.step !== 1) {
        const r = box.querySelector('#nsResearch');
        if (r) st.research = r.checked;
        return;
      }
      st.role = box.querySelector('#nsRole').value.trim();
      st.company = box.querySelector('#nsCompany').value.trim();
      st.date = box.querySelector('#nsDate').value;
      st.time = box.querySelector('#nsTime').value;
      st.job = box.querySelector('#nsJob').value.trim();
    }

    async function next() {
      capture();
      if (st.step === 1) {
        if (!st.role && !st.company) {
          C.toast('Enter at least the role or the company.', 'error');
          return;
        }
        st.step = 2;
        paint();
        return;
      }
      await create();
    }

    async function create() {
      const btn = box.querySelector('[data-ns-next]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Criando…';
      const all = [...existing, ...st.uploads];
      const docs = [...st.picked].map((i) => all[i]).filter(Boolean);
      const brand = st.company.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/.]/)[0];
      const company = st.company && /\./.test(st.company) ? brand.charAt(0).toUpperCase() + brand.slice(1) : st.company;
      const agent = {
        id: `session-${Date.now()}`,
        name: company && st.role ? `${company} — ${st.role}` : company || st.role,
        session_type: 'interview',
        company,
        role: st.role,
        job_description: st.job,
        interview_format: st.format,
        extra_instructions: 'Answer in the first person, with real examples from my resume (STAR method), without making up facts.',
        company_research: '',
        documents: docs,
        next_interview_date: st.date,
        next_interview_time: st.date ? st.time : ''
      };
      if (st.research && st.company) {
        btn.innerHTML = '<span class="spinner"></span>Pesquisando a empresa…';
        const rec = await C.guard(() => api.companyRecon({ company: st.company, role: st.role, job_description: st.job }));
        if (rec && rec.dossier) {
          agent.company_research = rec.dossier;
          agent.company_dossier = rec.dossier;
        }
      }
      let saved = null;
      if (docs.length) {
        btn.innerHTML = '<span class="spinner"></span>Lendo os arquivos…';
        const deep = await C.guard(() => api.deepReadAgent(agent), 'Could not index the files.');
        if (deep) {
          C.applyAgents(deep.agents, deep.agent && deep.agent.id);
          saved = deep.agent;
        }
      }
      if (!saved) saved = await C.saveAgent(agent);
      if (!saved) {
        btn.disabled = false;
        btn.textContent = 'Create session';
        return;
      }
      if (st.date) {
        const res = await C.guard(() => api.scheduleInterview({ goalId: saved.id, date: st.date, time: st.time }));
        if (res && res.agents) C.applyAgents(res.agents, saved.id);
        const cal = res && res.calendar;
        if (cal && cal.ok && !cal.skipped) C.toast('Interview added to Google Calendar.');
      }
      close(entry);
      C.toast(`Session "${C.agentTitle(saved)}" created.`);
      C.navigate(`session/${saved.id}`);
    }

    box.addEventListener('click', async (e) => {
      const fmt = e.target.closest('[data-ns-format]');
      if (fmt) {
        capture();
        st.format = st.format === fmt.dataset.nsFormat ? '' : fmt.dataset.nsFormat;
        paint();
        return;
      }
      const pick = e.target.closest('[data-ns-pick]');
      if (pick) {
        capture();
        const i = Number(pick.dataset.nsPick);
        if (st.picked.has(i)) st.picked.delete(i);
        else st.picked.add(i);
        paint();
        return;
      }
      if (e.target.closest('[data-ns-upload]')) {
        capture();
        const res = await C.guard(() => api.pickFiles('resume'), 'Could not open the files.');
        if (res && res.failed && res.failed.length) C.toast(`No readable text: ${res.failed.map((f) => f.title).join(', ')}`, 'error');
        if (res && res.documents && res.documents.length) {
          const base = existing.length + st.uploads.length;
          st.uploads.push(...res.documents);
          res.documents.forEach((_, k) => st.picked.add(base + k));
          paint();
        }
        return;
      }
      if (e.target.closest('[data-ns-back]')) {
        if (st.step === 1) close(entry);
        else {
          capture();
          st.step = 1;
          paint();
        }
        return;
      }
      if (e.target.closest('[data-ns-next]')) next();
    });
    paint();
  }
  MODALS['new-session'] = newSession;
  C.actions['new-session'] = () => newSession();

  // ------------------------------------------------------ edit session --
  MODALS['edit-session'] = (a) => {
    if (!a) return;
    const entry = mount(`<div class="modal wide">
      ${headHtml('Edit session', esc(C.agentTitle(a)))}
      <div class="modal-body">
        <div class="form-grid">
          <label class="field">Role<input class="input" id="esRole" value="${esc(fixText(a.role || ''))}"/></label>
          <label class="field">Company<input class="input" id="esCompany" value="${esc(fixText(a.company || ''))}"/></label>
        </div>
        <div class="field">Format<div class="row wrap" style="gap:4px" id="esFormats">${C.FORMATS.map((f) => `<button type="button" class="filter-chip ${a.interview_format === f ? 'active' : ''}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div></div>
        <label class="field">Job description<textarea class="textarea" id="esJob" rows="5">${esc(fixText(a.job_description || ''))}</textarea></label>
        <label class="field">Instructions for the copilot<textarea class="textarea" id="esInstr" rows="3">${esc(fixText(a.extra_instructions || a.custom_instructions || ''))}</textarea></label>
        <label class="field">Compact summary (mini-compact) <span class="hint">generated from the files; edit only if needed</span><textarea class="textarea mono" id="esCompact" rows="5">${esc(fixText(a.mini_compact || ''))}</textarea></label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn primary lg" id="esSave">Save</button></div>
    </div>`);
    const L = entry.layer;
    let format = a.interview_format || '';
    L.querySelector('#esFormats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      format = format === b.dataset.f ? '' : b.dataset.f;
      L.querySelectorAll('#esFormats [data-f]').forEach((x) => x.classList.toggle('active', x.dataset.f === format));
    });
    L.querySelector('#esSave').addEventListener('click', async () => {
      const role = L.querySelector('#esRole').value.trim();
      const company = L.querySelector('#esCompany').value.trim();
      const instr = L.querySelector('#esInstr').value.trim();
      const compact = L.querySelector('#esCompact').value.trim();
      const changedSources = role !== (a.role || '') || company !== (a.company || '') || L.querySelector('#esJob').value.trim() !== (a.job_description || '');
      const saved = await C.saveAgent(
        {
          ...a,
          role,
          company,
          name: company && role ? `${company} — ${role}` : company || role || a.name,
          interview_format: format,
          job_description: L.querySelector('#esJob').value.trim(),
          extra_instructions: instr,
          custom_instructions: instr,
          mini_compact: changedSources && compact === (a.mini_compact || '') ? '' : compact
        },
        'Session updated.'
      );
      if (saved) {
        close(entry);
        C.refresh();
      }
    });
  };
  C.actions['edit-session'] = (el) => MODALS['edit-session'](C.agentById(el.dataset.agent));

  // --------------------------------------------------------- scheduler --
  MODALS.scheduler = (agentId) => {
    const agents = S.agents.filter((a) => !a.archived);
    if (!agents.length) {
      C.toast('Create a session to schedule the interview.');
      newSession();
      return;
    }
    const a = C.agentById(agentId) || C.activeAgent() || agents[0];
    const iv = C.agentInterview(a);
    const gconn = S.gcal.status && S.gcal.status.connected;
    const entry = mount(`<div class="modal">
      ${headHtml('Schedule interview', 'Windows reminder 1 hour before')}
      <div class="modal-body">
        <label class="field">Session<select class="select" id="scAgent">${C.opts(agents.map((x) => [x.id, C.agentTitle(x)]), a.id)}</select></label>
        <div class="form-grid"><label class="field">Date<input class="input" type="date" id="scDate" value="${esc(iv ? iv.date : '')}"/></label><label class="field">Time<input class="input" type="time" id="scTime" value="${esc(iv ? iv.time : '')}"/></label></div>
        ${gconn ? `<label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Add to Google Calendar</span><span class="s">${esc(S.gcal.status.email || 'Account connected')}</span></span>${C.sw('id="scGcal"', S.gcal.status.autoSync !== false)}</label>` : ''}
      </div>
      <div class="modal-foot">${iv ? '<button type="button" class="btn lg danger left" id="scClear">Remove date</button>' : ''}<button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn primary lg" id="scSave">Schedule</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#scAgent').addEventListener('change', (e) => {
      const x = C.agentInterview(C.agentById(e.target.value));
      L.querySelector('#scDate').value = x ? x.date : '';
      L.querySelector('#scTime').value = x ? x.time : '';
    });
    const outcome = (cal) => {
      if (!cal || cal.skipped) return '';
      if (cal.ok) return cal.removed ? ' Removed from Google Calendar.' : cal.removed === false ? '' : ' Added to Google Calendar.';
      return ` Google Calendar: ${cal.error || 'not updated.'}`;
    };
    L.querySelector('#scSave').addEventListener('click', async () => {
      const id = L.querySelector('#scAgent').value;
      const date = L.querySelector('#scDate').value;
      const time = L.querySelector('#scTime').value;
      if (!date) {
        C.toast('Pick the interview date.', 'error');
        return;
      }
      const g = L.querySelector('#scGcal');
      const res = await C.guard(() => api.scheduleInterview({ goalId: id, date, time, calendar: g ? g.checked : undefined }), 'Could not schedule.');
      if (!res) return;
      if (res.ok === false) {
        C.toast(res.error || 'Could not schedule.', 'error');
        return;
      }
      C.applyAgents(res.agents, id);
      close(entry);
      const d = new Date(`${date}T${time || '00:00'}`);
      C.toast(`Interview on ${C.fmtDateShort(d)}${time ? ` at ${time}` : ''}.${outcome(res.calendar)}`);
      C.renderShell();
      C.refresh();
    });
    const clr = L.querySelector('#scClear');
    if (clr)
      clr.addEventListener('click', async () => {
        const id = L.querySelector('#scAgent').value;
        const res = await C.guard(() => api.clearInterview(id), 'Could not remove the date.');
        if (!res) return;
        await C.refreshState();
        close(entry);
        C.toast(`Date removed.${outcome(res.calendar)}`);
        C.renderShell();
        C.refresh();
      });
  };
  C.actions['open-scheduler'] = (el) => MODALS.scheduler(el.dataset.agent);

  // ----------------------------------------------------------- profile --
  MODALS.profile = () => {
    const p = S.profile || {};
    const signedIn = Boolean(S.auth && S.auth.signedIn);
    const acct = (signedIn && S.auth.account) || null;
    const entry = mount(`<div class="modal">
      ${headHtml('Profile', signedIn ? 'Name and e-mail come from your lipcue.com account' : 'Saved only on this computer')}
      <div class="modal-body">
        <label class="field">Name<input class="input" id="pfName" value="${esc(fixText((acct && acct.name) || p.name || ''))}" ${signedIn ? 'disabled' : 'autofocus'}/></label>
        <label class="field">E-mail<input class="input" id="pfEmail" type="email" value="${esc((acct && acct.email) || p.email || '')}" ${signedIn ? 'disabled title="The e-mail of your lipcue.com account"' : ''}/></label>
        <div class="form-grid"><label class="field">Current role<input class="input" id="pfHeadline" value="${esc(fixText(p.headline || ''))}"/></label><label class="field">Seniority<input class="input" id="pfSeniority" value="${esc(fixText(p.seniority || ''))}"/></label></div>
        <label class="field">LinkedIn<input class="input" id="pfLinkedin" value="${esc(p.linkedin || '')}" placeholder="linkedin.com/in/…"/></label>
      </div>
      <div class="modal-foot">${acct ? `<button type="button" class="btn lg left" data-action="cloud-logout">${C.icon('sign-out')}Sign out</button>` : ''}<button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn primary lg" id="pfSave">Save</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#pfSave').addEventListener('click', async () => {
      const res = await C.guard(
        () =>
          api.saveProfile({
            name: L.querySelector('#pfName').value.trim(),
            email: L.querySelector('#pfEmail').value.trim(),
            headline: L.querySelector('#pfHeadline').value.trim(),
            seniority: L.querySelector('#pfSeniority').value.trim(),
            linkedin: L.querySelector('#pfLinkedin').value.trim()
          }),
        'Could not save the profile.'
      );
      if (!res) return;
      S.profile = res.profile || S.profile;
      close(entry);
      C.toast('Profile updated.');
      C.renderShell();
      C.refresh();
    });
  };
  C.actions['open-profile'] = () => MODALS.profile();

  // ---------------------------------------------------- delete account --
  MODALS['delete-account'] = () => {
    const entry = mount(`<div class="modal">
      ${headHtml('Delete account', 'This cannot be undone')}
      <div class="modal-body">
        <p class="small" style="margin:0">Your account, plan, remaining minutes, cloud files and synced data are erased from the server. Your sessions, history, question bank, settings and API keys are erased from this computer.</p>
        <label class="field">Enter your password to confirm<input class="input" id="delPassword" type="password" autocomplete="current-password" autofocus/></label>
        <div class="small" id="delError" role="alert" style="color:var(--danger)"></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn danger lg" id="delConfirm">Delete everything</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#delConfirm').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const res = await C.guard(() => api.cloudDeleteAccount(L.querySelector('#delPassword').value), 'Could not delete the account.');
      btn.disabled = false;
      if (!res) return;
      if (!res.ok) {
        L.querySelector('#delError').textContent = C.t(res.error || 'Could not delete the account.');
        return;
      }
      if (res.config) S.config = res.config;
      S.auth = { signedIn: false };
      S.profile = {};
      close(entry);
      await C.refreshState();
      await C.authRefresh(true);
      C.toast('Your account and data were deleted.');
    });
  };
  C.actions['delete-account'] = () => MODALS['delete-account']();

  // ----------------------------------------------------------- summary --
  MODALS.summary = (summary) => {
    const agent = C.agentById(S.overlayStatus.agentId || S.live.agentId) || C.activeAgent();
    const entry = mount(`<div class="modal wide">
      ${headHtml('Session summary', summary.export_path ? esc(summary.export_path) : 'Generated when the copilot stops')}
      <div class="modal-body"><div class="doc-preview md sm" style="max-height:52vh">${C.md(summary.text || 'No summary.')}</div></div>
      <div class="modal-foot">
        ${summary.export_path ? `<button type="button" class="btn lg left" data-action="open-path" data-path="${esc(summary.export_path)}">${icon('external')}Open file</button>` : '<button type="button" class="btn lg left" data-action="open-path">Open folder</button>'}
        ${agent ? `<button type="button" class="btn lg" id="smDebrief">${icon('sparkle')}Save debrief to the session</button>` : ''}
        <button type="button" class="btn primary lg" data-action="go" data-to="sessions/past" id="smHistory">View in history</button>
      </div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#smHistory').addEventListener('click', () => close(entry));
    const dbf = L.querySelector('#smDebrief');
    if (dbf)
      dbf.addEventListener('click', async () => {
        dbf.disabled = true;
        dbf.innerHTML = '<span class="spinner"></span>Gerando…';
        const res = await C.guard(() => api.generateDebrief({ agentId: agent.id, sessionId: summary.export_path || '', transcript: summary.text || '' }), 'Could not generate the debrief.');
        if (res && res.ok !== false) {
          await C.refreshState();
          C.toast('Debrief saved to the session memory.');
          close(entry);
          C.navigate(`session/${agent.id}`);
        } else {
          dbf.disabled = false;
          dbf.textContent = 'Try again';
        }
      });
  };

  // ------------------------------------------------------- doc preview --
  MODALS['doc-preview'] = (doc) => {
    mount(`<div class="modal xwide">
      ${headHtml(fixText(doc.title || doc.name || 'Document'), `${esc(C.TAG_LABEL[C.docTag(doc)])} · ${esc(C.fmtKb((doc.content || '').length))}`)}
      <div class="modal-body"><div class="doc-preview"><pre class="pre-text">${esc(fixText(doc.content || 'No text extracted from this file.'))}</pre></div></div>
      <div class="modal-foot"><button type="button" class="btn primary lg" data-action="modal-close">Close</button></div>
    </div>`);
  };

  // -------------------------------------------------------- paste text --
  MODALS['paste-doc'] = (agentId) => {
    const agents = S.agents.filter((a) => !a.archived);
    if (!agents.length) {
      newSession();
      return;
    }
    const a = C.agentById(agentId) || C.activeAgent() || agents[0];
    const entry = mount(`<div class="modal wide">
      ${headHtml('Paste text', 'Becomes a document in the session context')}
      <div class="modal-body">
        <div class="form-grid"><label class="field">Title<input class="input" id="pdTitle" placeholder="E.g. Job description" autofocus/></label><label class="field">Type<select class="select" id="pdTag">${C.opts(Object.entries(C.TAG_LABEL), 'job')}</select></label></div>
        <label class="field">Session<select class="select" id="pdAgent">${C.opts(agents.map((x) => [x.id, C.agentTitle(x)]), a.id)}</select></label>
        <label class="field">Content<textarea class="textarea" id="pdContent" rows="10" placeholder="Paste the text here"></textarea></label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn primary lg" id="pdSave">Add</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#pdSave').addEventListener('click', async () => {
      const content = L.querySelector('#pdContent').value.trim();
      if (!content) {
        C.toast('Paste the content before saving.', 'error');
        return;
      }
      const target = C.agentById(L.querySelector('#pdAgent').value);
      const tag = L.querySelector('#pdTag').value;
      const title = L.querySelector('#pdTitle').value.trim() || `${C.TAG_LABEL[tag]}.md`;
      close(entry);
      await C.attachDocs(target, { documents: [{ title, name: title, tag, path: tag, content }] });
    });
  };
  C.actions['paste-doc'] = (el) => MODALS['paste-doc'](el.dataset.agent);

  // ---------------------------------------------------------- playbook --
  MODALS.playbook = (agentId) => {
    let length = 'Balanced';
    const entry = mount(`<div class="modal">
      ${headHtml('New playbook', 'How the copilot structures answers')}
      <div class="modal-body">
        <label class="field">Name<input class="input" id="pbName" placeholder="E.g. Executive STAR" autofocus/></label>
        <div class="field">Length<div class="segmented" id="pbLen">${[['Concise', 'Concise'], ['Balanced', 'Balanced'], ['Thorough', 'Thorough']].map(([v, l]) => `<button type="button" class="${v === length ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
        <label class="field">Behavioral structure<select class="select" id="pbStruct">${C.opts([['Auto', 'Automatic'], ['STAR (Situation, Task, Action, Result)', 'STAR (Situation, Task, Action, Result)'], ['CAR (Context, Action, Result)', 'CAR (Context, Action, Result)'], ['PAR (Problem, Action, Result)', 'PAR (Problem, Action, Result)']], 'STAR (Situation, Task, Action, Result)')}</select></label>
        <label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Lead with the answer</span><span class="s">The verdict comes before the context.</span></span>${C.sw('id="pbLead"', true)}</label>
        <label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Make trade-offs explicit</span><span class="s">Names alternatives and why they were ruled out.</span></span>${C.sw('id="pbTrade"', false)}</label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancel</button><button type="button" class="btn primary lg" id="pbSave">Save and apply</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#pbLen').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      length = b.dataset.v;
      L.querySelectorAll('#pbLen [data-v]').forEach((x) => x.classList.toggle('active', x === b));
    });
    L.querySelector('#pbSave').addEventListener('click', async () => {
      const name = L.querySelector('#pbName').value.trim();
      if (!name) {
        C.toast('Give the playbook a name.', 'error');
        return;
      }
      const pb = {
        name,
        answer_length: length,
        behavioral_structure: L.querySelector('#pbStruct').value,
        lead_with_answer: L.querySelector('#pbLead').checked,
        name_tradeoffs: L.querySelector('#pbTrade').checked
      };
      const res = await C.guard(() => api.savePlaybook(pb), 'Could not save the playbook.');
      if (!res) return;
      if (res.playbooks) S.playbooks = res.playbooks;
      const a = C.agentById(agentId);
      if (a) {
        await C.saveAgent(
          {
            ...a,
            playbook_name: pb.name,
            playbook_answer_length: pb.answer_length,
            playbook_behavioral_structure: pb.behavioral_structure,
            playbook_lead_with_answer: pb.lead_with_answer,
            playbook_name_tradeoffs: pb.name_tradeoffs
          },
          `Playbook "${name}" saved and applied.`
        );
      } else C.toast(`Playbook "${name}" salvo.`);
      close(entry);
      C.refresh();
    });
  };
  C.actions['new-playbook'] = (el) => MODALS.playbook(el.dataset.agent);

  // ----------------------------------------------------------- palette --
  MODALS.palette = () => {
    if (stack.some((e) => e.palette)) return;
    const entry = mount(`<div class="modal palette">
      <div class="palette-input">${icon('magnifying-glass')}<input id="pcQuery" placeholder="Search sessions, files, questions or actions…" autofocus/><span class="kbd">Esc</span></div>
      <div class="palette-list" id="pcList"></div>
    </div>`);
    entry.palette = true;
    const L = entry.layer;
    const input = L.querySelector('#pcQuery');
    const list = L.querySelector('#pcList');
    let items = [];
    let active = 0;

    const base = () => {
      const out = [];
      const running = S.overlayStatus.running;
      out.push({ g: 'Actions', ic: 'plus', t: 'New session', run: () => newSession() });
      out.push(running ? { g: 'Actions', ic: 'stop', t: 'Stop copilot', run: () => C.stopCopilot() } : { g: 'Actions', ic: 'play', t: 'Start the live copilot', sub: C.activeAgent() ? C.agentTitle(C.activeAgent()) : '', run: () => C.startCopilot(C.activeAgent(), false) });
      out.push({ g: 'Actions', ic: 'calendar', t: 'Schedule interview', run: () => MODALS.scheduler() });
      out.push({ g: 'Actions', ic: 'eye-slash', t: S.stealthState.active ? 'Show the panel in captures' : 'Hide the panel from captures', run: () => C.actions['toggle-stealth']() });
      [['home', 'Home', 'house'], ['sessions', 'Sessions', 'stack'], ['sessions/past', 'History', 'history'], ['files', 'Files', 'folder'], ['questions', 'Question bank', 'question'], ['live', 'Live', 'broadcast'], ['settings/ai', 'Settings · AI and models', 'cpu'], ['settings/audio', 'Settings · Audio', 'microphone'], ['settings/privacy', 'Settings · Privacy', 'shield-check'], ['settings/calendar', 'Settings · Calendar', 'calendar'], ['settings/shortcuts', 'Shortcuts', 'keyboard'], ['settings/updates', 'Updates', 'download']].forEach(([to, t, ic]) =>
        out.push({ g: 'Go to', ic, t, run: () => C.navigate(to) })
      );
      S.agents.forEach((a) => out.push({ g: 'Sessions', ic: 'stack', t: C.agentTitle(a), sub: a.archived ? 'archived' : `${C.readiness(a).pct}% ready`, run: () => C.navigate(`session/${a.id}`) }));
      S.sessions.slice(0, 60).forEach((s) => {
        const d = C.sessionDate(s);
        out.push({ g: 'History', ic: 'history', t: C.sessionTitle(s), sub: d ? `${C.fmtDateShort(d)} ${C.fmtTime(d)}` : '', run: () => C.navigate(`review/${s.id}`) });
      });
      S.agents.forEach((a) => (a.documents || []).forEach((d, i) => out.push({ g: 'Files', ic: C.docIcon(d), t: fixText(d.title || d.name || 'Document'), sub: C.agentTitle(a), run: () => MODALS['doc-preview'](a.documents[i]) })));
      for (const co of (S.questionBank && S.questionBank.companies) || []) {
        for (const q of co.questions || []) {
          if (q.locked) continue;
          out.push({ g: 'Questions', ic: 'question', t: fixText(q.text), sub: fixText(co.name), run: () => {
            S.ui.qCompany = co.id;
            S.ui.qOpen = C.norm(q.text);
            C.navigate('questions');
          } });
        }
      }
      return out;
    };
    const everything = base();

    function paint() {
      const q = C.norm(input.value);
      items = q ? everything.filter((x) => C.norm(`${x.t} ${x.sub || ''} ${x.g}`).includes(q)).slice(0, 40) : everything.filter((x) => x.g === 'Actions' || x.g === 'Go to');
      active = C.clamp(active, 0, Math.max(0, items.length - 1));
      let lastG = '';
      list.innerHTML = items.length
        ? items
            .map((x, i) => {
              const g = x.g !== lastG ? `<div class="palette-group eyebrow">${esc(x.g)}</div>` : '';
              lastG = x.g;
              return `${g}<button type="button" class="palette-item ${i === active ? 'active' : ''}" data-i="${i}">${icon(x.ic)}<span class="truncate">${esc(x.t)}</span>${x.sub ? `<span class="sub truncate" style="max-width:40%">${esc(x.sub)}</span>` : ''}</button>`;
            })
            .join('')
        : '<div class="empty" style="padding:28px">Nothing found.</div>';
      const el = list.querySelector('.palette-item.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function run(i) {
      const x = items[i];
      if (!x) return;
      close(entry);
      x.run();
    }
    input.addEventListener('input', () => {
      active = 0;
      paint();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(items.length - 1, active + 1);
        paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, active - 1);
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(active);
      }
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) run(Number(b.dataset.i));
    });
    paint();
  };

  // ------------------------------------------------------ session rating --
  // Optional rating at the end of a live session or a mock interview
  // (specs/004-session-feedback-popup/contracts/feedback-dialog-ui.md).
  // Every way out but Submit saves nothing; "Don't show again" turns it off
  // for the account.
  const STAR = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 2.8l2.84 5.76 6.36.92-4.6 4.49 1.09 6.33L12 17.31l-5.69 2.99 1.09-6.33-4.6-4.49 6.36-.92z"/></svg>';
  let feedbackEntry = null;

  function feedbackDialog(ask) {
    if (!ask || !ask.id || (ask.kind !== 'live' && ask.kind !== 'mock')) return;
    if (feedbackEntry) close(feedbackEntry);
    const st = { rating: 0, hover: 0, phase: 'open', error: '' }; // open | sending | thanks | gone
    const entry = mount(
      `<div class="modal feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="fbTitle" aria-describedby="fbLead">
        <div class="modal-head"><div class="stack grow" style="gap:2px"><span class="t" id="fbTitle">Rate your session</span></div><button type="button" class="icon-btn" id="fbClose" title="Close" aria-label="Close">${icon('x')}</button></div>
        <div class="modal-body" id="fbBody"></div>
      </div>`,
      { onClose: () => { if (feedbackEntry === entry) feedbackEntry = null; } }
    );
    feedbackEntry = entry;
    const L = entry.layer;
    const body = L.querySelector('#fbBody');
    const shut = () => { if (st.phase !== 'sending') close(entry); };
    L.querySelector('#fbClose').addEventListener('click', shut);

    function paintStars() {
      const shown = st.hover || st.rating;
      L.querySelectorAll('[data-fb-star]').forEach((b) => {
        const n = Number(b.dataset.fbStar);
        b.classList.toggle('on', n <= shown);
        b.setAttribute('aria-checked', String(n === st.rating));
        b.tabIndex = n === (st.rating || 1) ? 0 : -1;
      });
      const send = L.querySelector('#fbSend');
      if (send) send.disabled = !st.rating || st.phase !== 'open';
    }

    function paint() {
      if (st.phase === 'thanks') {
        body.innerHTML = '<p class="feedback-thanks" role="status">Thanks for your feedback!</p>';
        setTimeout(() => close(entry), 1500);
        return;
      }
      const keep = L.querySelector('#fbComment');
      const comment = keep ? keep.value : '';
      body.innerHTML = `
        <p class="muted feedback-lead" id="fbLead">Your rating helps us make LipCue.com better for your next interview.</p>
        <div class="stars" role="radiogroup" aria-label="Your rating">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star" role="radio" aria-checked="false" data-fb-star="${n}" aria-label="${n} of 5 stars" title="${n} of 5 stars">${STAR}</button>`).join('')}
        </div>
        <label class="field">Can you tell us more?<textarea class="textarea" id="fbComment" rows="4" maxlength="1000" placeholder="Add feedback (optional)">${esc(comment)}</textarea><span class="hint" id="fbCount" hidden></span></label>
        ${st.error ? `<div class="small feedback-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="feedback-actions">
          <button type="button" class="btn lg" id="fbCancel">Cancel</button>
          <button type="button" class="btn primary lg" id="fbSend">${st.phase === 'sending' ? '<span class="spinner"></span>Sending…' : 'Submit'}</button>
        </div>
        <div class="feedback-foot"><button type="button" class="link-btn" id="fbNever">Don't show again</button></div>`;
      window.CueIcons.hydrateIcons(body);
      const stars = [...L.querySelectorAll('[data-fb-star]')];
      const pick = (n) => {
        st.rating = Math.min(5, Math.max(1, n));
        paintStars();
        const el = stars[st.rating - 1];
        if (el && el.focus) el.focus();
      };
      stars.forEach((b) => {
        const n = Number(b.dataset.fbStar);
        b.addEventListener('click', () => pick(n));
        b.addEventListener('mouseenter', () => { st.hover = n; paintStars(); });
        b.addEventListener('mouseleave', () => { st.hover = 0; paintStars(); });
        b.addEventListener('keydown', (e) => {
          const next = { ArrowRight: st.rating + 1, ArrowUp: st.rating + 1, ArrowLeft: st.rating - 1, ArrowDown: st.rating - 1, Home: 1, End: 5 }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          pick(next || 1);
        });
      });
      const ta = L.querySelector('#fbComment');
      const count = L.querySelector('#fbCount');
      const counter = () => {
        const n = [...ta.value].length;
        count.hidden = n < 900;
        count.textContent = `${n}/1000`;
      };
      ta.addEventListener('input', counter);
      counter();
      L.querySelector('#fbCancel').addEventListener('click', shut);
      L.querySelector('#fbSend').addEventListener('click', submit);
      L.querySelector('#fbNever').addEventListener('click', () => {
        if (st.phase === 'sending') return;
        close(entry);
        api.feedbackSetPrompt(false); // a failure stays pending: nothing to show
      });
      paintStars();
      if (stars[0] && stars[0].focus) setTimeout(() => stars[(st.rating || 1) - 1].focus(), 40);
    }

    async function submit() {
      if (!st.rating || st.phase !== 'open') return;
      const comment = L.querySelector('#fbComment').value;
      st.phase = 'sending';
      st.error = '';
      paint();
      const r = await api.feedbackSubmit({ kind: ask.kind, id: ask.id, rating: st.rating, comment }).catch(() => ({ ok: false, error: 'Could not send. Check your connection and try again.' }));
      if (r && r.ok) {
        st.phase = 'thanks';
      } else {
        st.phase = r && r.gone ? 'gone' : 'open';
        st.error = (r && r.error) || 'Could not send. Check your connection and try again.';
      }
      paint();
      if (st.phase === 'gone') {
        const send = L.querySelector('#fbSend');
        if (send) send.disabled = true;
      }
    }

    paint();
  }

  MODALS.feedback = feedbackDialog;
  C.openFeedback = feedbackDialog;
  C.closeFeedback = () => {
    if (feedbackEntry) close(feedbackEntry);
  };
  if (api && api.onFeedbackPrompt) api.onFeedbackPrompt((ask) => feedbackDialog(ask));
  if (api && api.onFeedbackClose) api.onFeedbackClose(() => C.closeFeedback());

  C.actions['open-palette'] = () => MODALS.palette();
  void plural;
})();
