// Cue dashboard — dialogs: new/edit session, scheduler, profile, session
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
    return `<div class="modal-head"><div class="stack grow" style="gap:2px"><span class="t">${esc(title)}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div><button type="button" class="icon-btn" data-action="modal-close" title="Fechar">${icon('x')}</button></div>`;
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
          <div class="modal-foot"><button type="button" class="btn lg" data-cf="0">Cancelar</button><button type="button" class="btn lg ${/excluir|remover/i.test(okLabel || '') ? 'danger' : 'primary'}" data-cf="1" autofocus>${esc(okLabel || 'Confirmar')}</button></div>
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
          <label class="field">Cargo<input class="input" id="nsRole" value="${esc(st.role)}" placeholder="Ex.: Senior Product Designer" autofocus/></label>
          <div class="form-grid">
            <label class="field">Empresa<input class="input" id="nsCompany" value="${esc(st.company)}" placeholder="Ex.: Nubank ou nubank.com.br"/></label>
            <div class="form-grid" style="gap:8px"><label class="field">Data<input class="input" type="date" id="nsDate" value="${esc(st.date)}"/></label><label class="field">Hora<input class="input" type="time" id="nsTime" value="${esc(st.time)}"/></label></div>
          </div>
          <div class="field">Formato
            <div class="row wrap" style="gap:4px">${C.FORMATS.map((f) => `<button type="button" class="filter-chip ${st.format === f ? 'active' : ''}" data-ns-format="${esc(f)}">${esc(f)}</button>`).join('')}</div>
          </div>
          <label class="field">Descrição da vaga <span class="hint">opcional, ajuda muito o copiloto</span><textarea class="textarea" id="nsJob" rows="3" placeholder="Cole a descrição da vaga">${esc(st.job)}</textarea></label>
        </div>`;
      const all = [...existing, ...st.uploads];
      const step2 = `
        <div class="modal-body" style="gap:6px">
          <span class="small muted" style="padding-bottom:4px">Contexto que a IA deve usar</span>
          ${all.length
            ? all
                .map((d, i) => {
                  const on = st.picked.has(i);
                  return `<button type="button" class="check-row ${on ? 'on' : ''}" data-ns-pick="${i}"><span class="box">${icon('check')}</span><span class="grow truncate">${esc(fixText(d.title || d.name || 'Documento'))}</span><span class="xs faint">${esc(C.TAG_LABEL[C.docTag(d)])}</span></button>`;
                })
                .join('')
            : '<div class="empty" style="padding:20px">Nenhum arquivo ainda. Envie seu currículo para respostas baseadas na sua experiência.</div>'}
          <button type="button" class="btn" style="margin-top:6px;align-self:flex-start" data-ns-upload="1">${icon('upload')}Enviar arquivos</button>
          <label class="toggle-row" style="margin-top:8px;cursor:pointer"><span class="txt"><span class="t">Pesquisar a empresa automaticamente</span><span class="s">Gera um dossiê (produto, cultura, notícias) para o copiloto.</span></span>${C.sw('id="nsResearch"', st.research)}</label>
        </div>`;
      box.innerHTML = `
        ${headHtml('Nova sessão', `Passo ${st.step} / 2`)}
        ${st.step === 1 ? step1 : step2}
        <div class="modal-foot"><button type="button" class="btn lg" data-ns-back="1">${st.step === 1 ? 'Cancelar' : 'Voltar'}</button><button type="button" class="btn primary lg" data-ns-next="1">${st.step === 1 ? 'Continuar' : 'Criar sessão'}</button></div>`;
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
          C.toast('Informe pelo menos o cargo ou a empresa.', 'error');
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
        extra_instructions: 'Responda em primeira pessoa, com exemplos reais do meu currículo (método STAR), sem inventar fatos.',
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
        const deep = await C.guard(() => api.deepReadAgent(agent), 'Não foi possível indexar os arquivos.');
        if (deep) {
          C.applyAgents(deep.agents, deep.agent && deep.agent.id);
          saved = deep.agent;
        }
      }
      if (!saved) saved = await C.saveAgent(agent);
      if (!saved) {
        btn.disabled = false;
        btn.textContent = 'Criar sessão';
        return;
      }
      if (st.date) {
        const res = await C.guard(() => api.scheduleInterview({ goalId: saved.id, date: st.date, time: st.time }));
        if (res && res.agents) C.applyAgents(res.agents, saved.id);
        const cal = res && res.calendar;
        if (cal && cal.ok && !cal.skipped) C.toast('Entrevista adicionada ao Google Calendar.');
      }
      close(entry);
      C.toast(`Sessão "${C.agentTitle(saved)}" criada.`);
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
        const res = await C.guard(() => api.pickFiles('resume'), 'Não foi possível abrir os arquivos.');
        if (res && res.failed && res.failed.length) C.toast(`Sem texto legível: ${res.failed.map((f) => f.title).join(', ')}`, 'error');
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
      ${headHtml('Editar sessão', esc(C.agentTitle(a)))}
      <div class="modal-body">
        <div class="form-grid">
          <label class="field">Cargo<input class="input" id="esRole" value="${esc(fixText(a.role || ''))}"/></label>
          <label class="field">Empresa<input class="input" id="esCompany" value="${esc(fixText(a.company || ''))}"/></label>
        </div>
        <div class="field">Formato<div class="row wrap" style="gap:4px" id="esFormats">${C.FORMATS.map((f) => `<button type="button" class="filter-chip ${a.interview_format === f ? 'active' : ''}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div></div>
        <label class="field">Descrição da vaga<textarea class="textarea" id="esJob" rows="5">${esc(fixText(a.job_description || ''))}</textarea></label>
        <label class="field">Instruções para o copiloto<textarea class="textarea" id="esInstr" rows="3">${esc(fixText(a.extra_instructions || a.custom_instructions || ''))}</textarea></label>
        <label class="field">Resumo compacto (mini-compact) <span class="hint">gerado a partir dos arquivos; edite só se precisar</span><textarea class="textarea mono" id="esCompact" rows="5">${esc(fixText(a.mini_compact || ''))}</textarea></label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancelar</button><button type="button" class="btn primary lg" id="esSave">Salvar</button></div>
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
        'Sessão atualizada.'
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
      C.toast('Crie uma sessão para agendar a entrevista.');
      newSession();
      return;
    }
    const a = C.agentById(agentId) || C.activeAgent() || agents[0];
    const iv = C.agentInterview(a);
    const gconn = S.gcal.status && S.gcal.status.connected;
    const entry = mount(`<div class="modal">
      ${headHtml('Agendar entrevista', 'Lembrete do Windows 1 hora antes')}
      <div class="modal-body">
        <label class="field">Sessão<select class="select" id="scAgent">${C.opts(agents.map((x) => [x.id, C.agentTitle(x)]), a.id)}</select></label>
        <div class="form-grid"><label class="field">Data<input class="input" type="date" id="scDate" value="${esc(iv ? iv.date : '')}"/></label><label class="field">Hora<input class="input" type="time" id="scTime" value="${esc(iv ? iv.time : '')}"/></label></div>
        ${gconn ? `<label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Adicionar ao Google Calendar</span><span class="s">${esc(S.gcal.status.email || 'Conta conectada')}</span></span>${C.sw('id="scGcal"', S.gcal.status.autoSync !== false)}</label>` : ''}
      </div>
      <div class="modal-foot">${iv ? '<button type="button" class="btn lg danger left" id="scClear">Remover data</button>' : ''}<button type="button" class="btn lg" data-action="modal-close">Cancelar</button><button type="button" class="btn primary lg" id="scSave">Agendar</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#scAgent').addEventListener('change', (e) => {
      const x = C.agentInterview(C.agentById(e.target.value));
      L.querySelector('#scDate').value = x ? x.date : '';
      L.querySelector('#scTime').value = x ? x.time : '';
    });
    const outcome = (cal) => {
      if (!cal || cal.skipped) return '';
      if (cal.ok) return cal.removed ? ' Removida do Google Calendar.' : cal.removed === false ? '' : ' Adicionada ao Google Calendar.';
      return ` Google Calendar: ${cal.error || 'não atualizado.'}`;
    };
    L.querySelector('#scSave').addEventListener('click', async () => {
      const id = L.querySelector('#scAgent').value;
      const date = L.querySelector('#scDate').value;
      const time = L.querySelector('#scTime').value;
      if (!date) {
        C.toast('Escolha a data da entrevista.', 'error');
        return;
      }
      const g = L.querySelector('#scGcal');
      const res = await C.guard(() => api.scheduleInterview({ goalId: id, date, time, calendar: g ? g.checked : undefined }), 'Não foi possível agendar.');
      if (!res) return;
      if (res.ok === false) {
        C.toast(res.error || 'Não foi possível agendar.', 'error');
        return;
      }
      C.applyAgents(res.agents, id);
      close(entry);
      const d = new Date(`${date}T${time || '00:00'}`);
      C.toast(`Entrevista em ${C.fmtDateShort(d)}${time ? ` às ${time}` : ''}.${outcome(res.calendar)}`);
      C.renderShell();
      C.refresh();
    });
    const clr = L.querySelector('#scClear');
    if (clr)
      clr.addEventListener('click', async () => {
        const id = L.querySelector('#scAgent').value;
        const res = await C.guard(() => api.clearInterview(id), 'Não foi possível remover a data.');
        if (!res) return;
        await C.refreshState();
        close(entry);
        C.toast(`Data removida.${outcome(res.calendar)}`);
        C.renderShell();
        C.refresh();
      });
  };
  C.actions['open-scheduler'] = (el) => MODALS.scheduler(el.dataset.agent);

  // ----------------------------------------------------------- profile --
  MODALS.profile = () => {
    const p = S.profile || {};
    const entry = mount(`<div class="modal">
      ${headHtml('Perfil', 'Salvo só neste computador')}
      <div class="modal-body">
        <label class="field">Nome<input class="input" id="pfName" value="${esc(fixText(p.name || ''))}" autofocus/></label>
        <label class="field">E-mail<input class="input" id="pfEmail" type="email" value="${esc(p.email || '')}"/></label>
        <div class="form-grid"><label class="field">Cargo atual<input class="input" id="pfHeadline" value="${esc(fixText(p.headline || ''))}"/></label><label class="field">Senioridade<input class="input" id="pfSeniority" value="${esc(fixText(p.seniority || ''))}"/></label></div>
        <label class="field">LinkedIn<input class="input" id="pfLinkedin" value="${esc(p.linkedin || '')}" placeholder="linkedin.com/in/…"/></label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancelar</button><button type="button" class="btn primary lg" id="pfSave">Salvar</button></div>
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
        'Não foi possível salvar o perfil.'
      );
      if (!res) return;
      S.profile = res.profile || S.profile;
      close(entry);
      C.toast('Perfil atualizado.');
      C.renderShell();
      C.refresh();
    });
  };
  C.actions['open-profile'] = () => MODALS.profile();

  // ----------------------------------------------------------- summary --
  MODALS.summary = (summary) => {
    const agent = C.agentById(S.overlayStatus.agentId || S.live.agentId) || C.activeAgent();
    const entry = mount(`<div class="modal wide">
      ${headHtml('Resumo da sessão', summary.export_path ? esc(summary.export_path) : 'Gerado ao encerrar o copiloto')}
      <div class="modal-body"><div class="doc-preview md sm" style="max-height:52vh">${C.md(summary.text || 'Sem resumo.')}</div></div>
      <div class="modal-foot">
        ${summary.export_path ? `<button type="button" class="btn lg left" data-action="open-path" data-path="${esc(summary.export_path)}">${icon('external')}Abrir arquivo</button>` : '<button type="button" class="btn lg left" data-action="open-path">Abrir pasta</button>'}
        ${agent ? `<button type="button" class="btn lg" id="smDebrief">${icon('sparkle')}Salvar debrief na sessão</button>` : ''}
        <button type="button" class="btn primary lg" data-action="go" data-to="sessions/past" id="smHistory">Ver no histórico</button>
      </div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#smHistory').addEventListener('click', () => close(entry));
    const dbf = L.querySelector('#smDebrief');
    if (dbf)
      dbf.addEventListener('click', async () => {
        dbf.disabled = true;
        dbf.innerHTML = '<span class="spinner"></span>Gerando…';
        const res = await C.guard(() => api.generateDebrief({ agentId: agent.id, sessionId: summary.export_path || '', transcript: summary.text || '' }), 'Não foi possível gerar o debrief.');
        if (res && res.ok !== false) {
          await C.refreshState();
          C.toast('Debrief salvo na memória da sessão.');
          close(entry);
          C.navigate(`session/${agent.id}`);
        } else {
          dbf.disabled = false;
          dbf.textContent = 'Tentar de novo';
        }
      });
  };

  // ------------------------------------------------------- doc preview --
  MODALS['doc-preview'] = (doc) => {
    mount(`<div class="modal xwide">
      ${headHtml(fixText(doc.title || doc.name || 'Documento'), `${esc(C.TAG_LABEL[C.docTag(doc)])} · ${esc(C.fmtKb((doc.content || '').length))}`)}
      <div class="modal-body"><div class="doc-preview"><pre class="pre-text">${esc(fixText(doc.content || 'Sem texto extraído deste arquivo.'))}</pre></div></div>
      <div class="modal-foot"><button type="button" class="btn primary lg" data-action="modal-close">Fechar</button></div>
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
      ${headHtml('Colar texto', 'Vira um documento no contexto da sessão')}
      <div class="modal-body">
        <div class="form-grid"><label class="field">Título<input class="input" id="pdTitle" placeholder="Ex.: Descrição da vaga" autofocus/></label><label class="field">Tipo<select class="select" id="pdTag">${C.opts(Object.entries(C.TAG_LABEL), 'job')}</select></label></div>
        <label class="field">Sessão<select class="select" id="pdAgent">${C.opts(agents.map((x) => [x.id, C.agentTitle(x)]), a.id)}</select></label>
        <label class="field">Conteúdo<textarea class="textarea" id="pdContent" rows="10" placeholder="Cole aqui o texto"></textarea></label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancelar</button><button type="button" class="btn primary lg" id="pdSave">Adicionar</button></div>
    </div>`);
    const L = entry.layer;
    L.querySelector('#pdSave').addEventListener('click', async () => {
      const content = L.querySelector('#pdContent').value.trim();
      if (!content) {
        C.toast('Cole o conteúdo antes de salvar.', 'error');
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
      ${headHtml('Novo playbook', 'Como o copiloto estrutura as respostas')}
      <div class="modal-body">
        <label class="field">Nome<input class="input" id="pbName" placeholder="Ex.: STAR executivo" autofocus/></label>
        <div class="field">Tamanho<div class="segmented" id="pbLen">${[['Concise', 'Conciso'], ['Balanced', 'Equilibrado'], ['Thorough', 'Detalhado']].map(([v, l]) => `<button type="button" class="${v === length ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
        <label class="field">Estrutura comportamental<select class="select" id="pbStruct">${C.opts([['Auto', 'Automática'], ['STAR (Situation, Task, Action, Result)', 'STAR (Situação, Tarefa, Ação, Resultado)'], ['CAR (Context, Action, Result)', 'CAR (Contexto, Ação, Resultado)'], ['PAR (Problem, Action, Result)', 'PAR (Problema, Ação, Resultado)']], 'STAR (Situation, Task, Action, Result)')}</select></label>
        <label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Começar pela resposta</span><span class="s">O veredito vem antes do contexto.</span></span>${C.sw('id="pbLead"', true)}</label>
        <label class="toggle-row" style="cursor:pointer"><span class="txt"><span class="t">Explicitar trade-offs</span><span class="s">Nomeia alternativas e por que foram descartadas.</span></span>${C.sw('id="pbTrade"', false)}</label>
      </div>
      <div class="modal-foot"><button type="button" class="btn lg" data-action="modal-close">Cancelar</button><button type="button" class="btn primary lg" id="pbSave">Salvar e aplicar</button></div>
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
        C.toast('Dê um nome ao playbook.', 'error');
        return;
      }
      const pb = {
        name,
        answer_length: length,
        behavioral_structure: L.querySelector('#pbStruct').value,
        lead_with_answer: L.querySelector('#pbLead').checked,
        name_tradeoffs: L.querySelector('#pbTrade').checked
      };
      const res = await C.guard(() => api.savePlaybook(pb), 'Não foi possível salvar o playbook.');
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
          `Playbook "${name}" salvo e aplicado.`
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
      <div class="palette-input">${icon('magnifying-glass')}<input id="pcQuery" placeholder="Buscar sessões, arquivos, perguntas ou ações…" autofocus/><span class="kbd">Esc</span></div>
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
      out.push({ g: 'Ações', ic: 'plus', t: 'Nova sessão', run: () => newSession() });
      out.push(running ? { g: 'Ações', ic: 'stop', t: 'Encerrar copiloto', run: () => C.stopCopilot() } : { g: 'Ações', ic: 'play', t: 'Iniciar copiloto ao vivo', sub: C.activeAgent() ? C.agentTitle(C.activeAgent()) : '', run: () => C.startCopilot(C.activeAgent(), false) });
      out.push({ g: 'Ações', ic: 'calendar', t: 'Agendar entrevista', run: () => MODALS.scheduler() });
      out.push({ g: 'Ações', ic: 'eye-slash', t: S.stealthState.active ? 'Mostrar painel em capturas' : 'Ocultar painel de capturas', run: () => C.actions['toggle-stealth']() });
      [['home', 'Início', 'house'], ['sessions', 'Sessões', 'stack'], ['sessions/past', 'Histórico', 'history'], ['files', 'Arquivos', 'folder'], ['questions', 'Banco de perguntas', 'question'], ['live', 'Ao vivo', 'broadcast'], ['settings/ai', 'Configurações · IA e modelos', 'cpu'], ['settings/audio', 'Configurações · Áudio', 'microphone'], ['settings/privacy', 'Configurações · Privacidade', 'shield-check'], ['settings/calendar', 'Configurações · Calendário', 'calendar'], ['settings/shortcuts', 'Atalhos', 'keyboard'], ['settings/updates', 'Atualizações', 'download']].forEach(([to, t, ic]) =>
        out.push({ g: 'Ir para', ic, t, run: () => C.navigate(to) })
      );
      S.agents.forEach((a) => out.push({ g: 'Sessões', ic: 'stack', t: C.agentTitle(a), sub: a.archived ? 'arquivada' : `${C.readiness(a).pct}% preparado`, run: () => C.navigate(`session/${a.id}`) }));
      S.sessions.slice(0, 60).forEach((s) => {
        const d = C.sessionDate(s);
        out.push({ g: 'Histórico', ic: 'history', t: C.sessionTitle(s), sub: d ? `${C.fmtDateShort(d)} ${C.fmtTime(d)}` : '', run: () => C.navigate(`review/${s.id}`) });
      });
      S.agents.forEach((a) => (a.documents || []).forEach((d, i) => out.push({ g: 'Arquivos', ic: C.docIcon(d), t: fixText(d.title || d.name || 'Documento'), sub: C.agentTitle(a), run: () => MODALS['doc-preview'](a.documents[i]) })));
      for (const co of (S.questionBank && S.questionBank.companies) || []) {
        for (const q of co.questions || []) {
          if (q.locked) continue;
          out.push({ g: 'Perguntas', ic: 'question', t: fixText(q.text), sub: fixText(co.name), run: () => {
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
      items = q ? everything.filter((x) => C.norm(`${x.t} ${x.sub || ''} ${x.g}`).includes(q)).slice(0, 40) : everything.filter((x) => x.g === 'Ações' || x.g === 'Ir para');
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
        : '<div class="empty" style="padding:28px">Nada encontrado.</div>';
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
  C.actions['open-palette'] = () => MODALS.palette();
  void plural;
})();
