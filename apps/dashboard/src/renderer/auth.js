// Cue dashboard — sign-in. Signing in is mandatory: while S.auth.signedIn is
// false, app.js renders only this screen (no sidebar, tabs or settings) and
// ignores every other action. Three ways in, all handled by the main process
// (cloud_account.js): Google and company SSO through the browser (device
// code), or e-mail + password (with sign-up and password reset).
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon } = C;

  // Screen state. The password lives only here, only until it is sent.
  const A = { mode: 'signin', email: '', name: '', password: '', ssoHint: '', busy: '', error: '', info: '', pending: null };

  function field(name, label, type, value, placeholder, autocomplete) {
    return `<label class="stack" style="gap:6px"><span class="small muted">${esc(label)}</span>
      <input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder || '')}" autocomplete="${autocomplete || 'off'}" spellcheck="false" data-input="auth-field" data-field="${name}"/></label>`;
  }

  function spinner(kind) {
    return A.busy === kind ? '<span class="spinner"></span>' : '';
  }

  function serverBlock() {
    const cfg = S.config || {};
    const st = S.auth || {};
    if (st.available || cfg.server_url_effective) return '';
    return `<div class="inset stack" style="gap:8px"><span class="small">Nenhum servidor RealTimeAI configurado nesta versão.</span>
      <input class="input sm" type="text" value="${esc(cfg.server_url || '')}" placeholder="https://servidor.exemplo.com" data-change="auth-server" aria-label="Endereço do servidor"/></div>`;
  }

  function pendingBlock() {
    const p = A.pending;
    return `<div class="stack" style="gap:12px;align-items:center;text-align:center">
      <span class="muted">${p.provider === 'sso' ? 'Conclua o login da sua empresa no navegador.' : 'Conclua o login com o Google no navegador.'} Confirme este código se for pedido:</span>
      <span class="metric mono" style="letter-spacing:.12em">${esc(p.userCode || '—')}</span>
      <span class="row" style="gap:8px"><span class="spinner"></span><span class="small faint">Aguardando a confirmação…</span></span>
      <div class="row" style="gap:8px"><button type="button" class="btn sm" data-action="auth-reopen">${icon('external')}Abrir o navegador de novo</button>
      <button type="button" class="btn sm ghost" data-action="auth-cancel">Cancelar</button></div></div>`;
  }

  function formBlock() {
    if (A.mode === 'sso') {
      return `<div class="stack" style="gap:12px">
        ${field('ssoHint', 'E-mail corporativo ou domínio da empresa', 'text', A.ssoHint, 'voce@empresa.com', 'email')}
        <button type="button" class="btn primary lg" data-action="auth-sso" ${A.busy ? 'disabled' : ''}>${spinner('sso')}Continuar com SSO</button>
        <button type="button" class="btn ghost sm" data-action="auth-mode" data-mode="signin">Voltar</button></div>`;
    }
    if (A.mode === 'reset') {
      return `<div class="stack" style="gap:12px">
        ${field('email', 'E-mail da conta', 'email', A.email, 'voce@email.com', 'email')}
        <button type="button" class="btn primary lg" data-action="auth-reset" ${A.busy ? 'disabled' : ''}>${spinner('reset')}Enviar link de recuperação</button>
        <button type="button" class="btn ghost sm" data-action="auth-mode" data-mode="signin">Voltar para entrar</button></div>`;
    }
    const signup = A.mode === 'signup';
    return `<div class="stack" style="gap:12px">
      <button type="button" class="btn lg" data-action="auth-google" ${A.busy ? 'disabled' : ''}>${spinner('google') || icon('globe')}Continuar com Google</button>
      <button type="button" class="btn lg" data-action="auth-mode" data-mode="sso" ${A.busy ? 'disabled' : ''}>${icon('key')}Entrar com SSO da empresa</button>
      <div class="row" style="gap:10px;align-items:center"><span class="grow" style="height:1px;background:var(--border-subtle)"></span><span class="xs faint">ou com e-mail</span><span class="grow" style="height:1px;background:var(--border-subtle)"></span></div>
      ${signup ? field('name', 'Nome', 'text', A.name, 'Seu nome', 'name') : ''}
      ${field('email', 'E-mail', 'email', A.email, 'voce@email.com', 'email')}
      ${field('password', signup ? 'Senha (mínimo 8 caracteres)' : 'Senha', 'password', '', '', signup ? 'new-password' : 'current-password')}
      <button type="button" class="btn primary lg" id="authSubmit" data-action="auth-password" ${A.busy ? 'disabled' : ''}>${spinner('password')}${signup ? 'Criar conta' : 'Entrar'}</button>
      <div class="row between small">
        ${signup
          ? '<a data-action="auth-mode" data-mode="signin">Já tenho conta</a><span></span>'
          : '<a data-action="auth-mode" data-mode="signup">Criar conta</a><a data-action="auth-mode" data-mode="reset">Esqueci a senha</a>'}
      </div></div>`;
  }

  C.views.login = function login() {
    const expired = S.auth && S.auth.expired;
    const title = A.mode === 'signup' ? 'Crie sua conta' : A.mode === 'reset' ? 'Recuperar senha' : 'Entre no Cue';
    return `<div class="page" style="display:flex;justify-content:center;padding-top:56px">
      <section class="card" style="width:100%;max-width:420px">
        <div class="stack" style="gap:6px;margin-bottom:18px">
          <span class="row" style="gap:10px"><span class="brand-mark" style="width:28px;height:28px">${icon('waveform')}</span><span class="strong" style="font-size:18px">${esc(title)}</span></span>
          <span class="small faint">${expired ? 'Sua sessão expirou. Entre de novo para continuar.' : 'É preciso entrar para usar o copiloto. Novas contas começam no plano Free: uma sessão de até 15 minutos.'}</span>
        </div>
        ${serverBlock()}
        ${A.pending ? pendingBlock() : formBlock()}
        ${A.error ? `<div class="small" role="alert" style="color:var(--danger);margin-top:12px">${esc(A.error)}</div>` : ''}
        ${A.info ? `<div class="small" style="color:var(--accent);margin-top:12px">${esc(A.info)}</div>` : ''}
      </section></div>`;
  };

  C.afterRender.login = () => {
    // Enter submits the e-mail form.
    const submit = document.getElementById('authSubmit');
    document.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && submit && !submit.disabled) {
          e.preventDefault();
          submit.click();
        }
      });
    });
  };

  // ------------------------------------------------------------ state --
  let lastStatusAt = 0;

  async function authRefresh(force) {
    const wasLocked = C.isLocked();
    const st = api.cloudStatus ? await C.guard(() => api.cloudStatus(Boolean(force))) : null;
    S.auth = st || { signedIn: false };
    lastStatusAt = Date.now();
    if (wasLocked !== C.isLocked()) {
      if (!C.isLocked()) C.navigate('home', true);
      else C.renderView(true);
    } else if (C.isLocked() || (S.route && S.route.view === 'settings')) {
      C.refresh();
    } else {
      C.renderShell && C.renderShell();
    }
    return S.auth;
  }
  C.authRefresh = authRefresh;

  async function signedIn(config) {
    A.pending = null;
    A.busy = '';
    A.error = '';
    A.info = '';
    A.password = '';
    if (config) S.config = config;
    await authRefresh(true);
    C.toast('Conta conectada.');
  }

  C.authInit = async () => {
    S.auth = (api.cloudStatus && (await C.guard(() => api.cloudStatus(false)))) || { signedIn: false };
    lastStatusAt = Date.now();
    if (api.onCloudEvent) {
      api.onCloudEvent(async (e) => {
        if (e.type === 'pending') {
          A.pending = { ...(A.pending || {}), userCode: e.userCode, verificationUri: e.verificationUri };
        } else if (e.type === 'signed_in') {
          await signedIn(e.config);
          return;
        } else if (e.type === 'error') {
          A.pending = null;
          A.busy = '';
          A.error = e.error || 'Não foi possível entrar.';
        }
        if (C.isLocked()) C.refresh();
      });
    }
    // An expired or revoked sign-in locks the app again (checked when the
    // window regains focus, at most every 5 minutes).
    window.addEventListener('focus', () => {
      if (Date.now() - lastStatusAt > 5 * 60 * 1000) authRefresh(true);
    });
  };

  // ---------------------------------------------------------- actions --
  C.inputs['auth-field'] = (el) => {
    A[el.dataset.field] = el.value;
  };

  C.changes['auth-server'] = async (el) => {
    await C.saveConfig({ server_url: String(el.value || '').trim() });
    await authRefresh(true);
  };

  C.actions['auth-mode'] = (el) => {
    A.mode = el.dataset.mode || 'signin';
    A.error = '';
    A.info = '';
    C.refresh();
  };

  async function browserLogin(provider) {
    A.busy = provider;
    A.error = '';
    C.refresh();
    const res = await C.guard(() => api.cloudLogin({ provider, hint: provider === 'sso' ? A.ssoHint : '' }), 'Não foi possível iniciar o login.');
    A.busy = '';
    if (res && res.ok) A.pending = { provider, userCode: res.userCode, verificationUri: res.verificationUri };
    else A.error = (res && res.error) || 'Não foi possível iniciar o login.';
    C.refresh();
  }

  C.actions['auth-google'] = () => browserLogin('google');
  C.actions['auth-sso'] = () => browserLogin('sso');

  C.actions['auth-cancel'] = async () => {
    await C.guard(() => api.cloudCancelLogin());
    A.pending = null;
    C.refresh();
  };

  C.actions['auth-reopen'] = async () => {
    if (A.pending && A.pending.verificationUri) await C.guard(() => api.openUrl(A.pending.verificationUri));
  };

  C.actions['auth-password'] = async () => {
    const signup = A.mode === 'signup';
    const password = A.password;
    A.password = ''; // never kept after the attempt
    A.busy = 'password';
    A.error = '';
    A.info = '';
    C.refresh();
    const res = await C.guard(
      () => (signup ? api.cloudSignup({ name: A.name, email: A.email, password }) : api.cloudPasswordLogin({ email: A.email, password })),
      'Não foi possível entrar.'
    );
    A.busy = '';
    if (res && res.ok) {
      await signedIn(null);
      return;
    }
    if (res && res.pendingVerification) {
      A.mode = 'signin';
      A.info = res.error;
    } else {
      A.error = (res && res.error) || 'Não foi possível entrar.';
    }
    C.refresh();
  };

  C.actions['auth-reset'] = async () => {
    A.busy = 'reset';
    A.error = '';
    C.refresh();
    const res = await C.guard(() => api.cloudResetPassword(A.email), 'Não foi possível enviar o link.');
    A.busy = '';
    if (res && res.ok) {
      A.mode = 'signin';
      A.info = 'Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha.';
    } else {
      A.error = (res && res.error) || 'Não foi possível enviar o link.';
    }
    C.refresh();
  };
})();
