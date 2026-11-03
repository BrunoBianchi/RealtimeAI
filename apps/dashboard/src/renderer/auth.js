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

  // Google "G" mark (brand colours, as Google's sign-in guidelines ask).
  const GOOGLE_G = `<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path class="g-y" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path class="g-r" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path class="g-g" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path class="g-b" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>`;

  function field(name, label, type, value, placeholder, autocomplete) {
    return `<label class="auth-field"><span>${esc(label)}</span>
      <input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder || '')}" autocomplete="${autocomplete || 'off'}" spellcheck="false" data-input="auth-field" data-field="${name}"/></label>`;
  }

  function spinner(kind) {
    return A.busy === kind ? '<span class="spinner"></span>' : '';
  }

  const dis = () => (A.busy ? 'disabled' : '');

  function serverBlock() {
    const cfg = S.config || {};
    const st = S.auth || {};
    if (st.available || cfg.server_url_effective) return '';
    return `<div class="auth-server"><span>This build has no RealTimeAI server configured. Enter its address to sign in.</span>
      <input class="input sm" type="text" value="${esc(cfg.server_url || '')}" placeholder="https://server.example.com" data-change="auth-server" aria-label="Server address"/></div>`;
  }

  function pendingBlock() {
    const p = A.pending;
    return `<div class="auth-step">
      <p class="auth-sub" style="text-align:center;margin:0 auto">${p.provider === 'sso' ? 'Finish signing in with your company in the browser.' : 'Finish signing in with Google in the browser.'} If asked, confirm this code:</p>
      <div class="auth-code">${esc(p.userCode || '—')}</div>
      <div class="auth-wait"><span class="spinner"></span>Waiting for confirmation…</div>
      <button type="button" class="auth-btn" data-action="auth-reopen">${icon('external')}Open the browser again</button>
      <div class="auth-links center"><button type="button" class="auth-link" data-action="auth-cancel">Cancel</button></div></div>`;
  }

  function formBlock() {
    if (A.mode === 'sso') {
      return `<div class="auth-step">
        ${field('ssoHint', 'Work e-mail or company domain', 'text', A.ssoHint, 'you@company.com', 'email')}
        <button type="button" class="auth-btn primary" id="authSubmit" data-action="auth-sso" ${dis()}>${spinner('sso')}Continue with SSO</button>
        <div class="auth-links center"><button type="button" class="auth-link" data-action="auth-mode" data-mode="signin">Back</button></div></div>`;
    }
    if (A.mode === 'reset') {
      return `<div class="auth-step">
        ${field('email', 'Account e-mail', 'email', A.email, 'you@email.com', 'email')}
        <button type="button" class="auth-btn primary" id="authSubmit" data-action="auth-reset" ${dis()}>${spinner('reset')}Send reset link</button>
        <div class="auth-links center"><button type="button" class="auth-link" data-action="auth-mode" data-mode="signin">Back to sign in</button></div></div>`;
    }
    const signup = A.mode === 'signup';
    return `<div class="auth-step">
      <button type="button" class="auth-btn" data-action="auth-google" ${dis()}>${spinner('google') || GOOGLE_G}Continue with Google</button>
      <button type="button" class="auth-btn" data-action="auth-mode" data-mode="sso" ${dis()}>${icon('key')}Continue with SSO</button>
      <div class="auth-divider">or</div>
      ${signup ? field('name', 'Name', 'text', A.name, 'Your name', 'name') : ''}
      ${field('email', 'E-mail', 'email', A.email, 'you@email.com', 'email')}
      ${field('password', 'Password', 'password', '', signup ? 'At least 8 characters' : '', signup ? 'new-password' : 'current-password')}
      <button type="button" class="auth-btn primary" id="authSubmit" data-action="auth-password" ${dis()}>${spinner('password')}${signup ? 'Create account' : 'Sign in'}</button>
      <div class="auth-links ${signup ? 'center' : ''}">
        ${signup
          ? '<button type="button" class="auth-link" data-action="auth-mode" data-mode="signin">Already have an account? <span class="auth-link strong">Sign in</span></button>'
          : '<button type="button" class="auth-link" data-action="auth-mode" data-mode="signup">No account? <span class="auth-link strong">Sign up</span></button><button type="button" class="auth-link" data-action="auth-mode" data-mode="reset">Forgot password?</button>'}
      </div></div>`;
  }

  const TITLES = { signin: 'Welcome to Cue', signup: 'Create your account', reset: 'Reset your password', sso: 'Single sign-on' };
  const SUBS = {
    signin: 'Your real-time interview copilot. Sign in to continue.',
    signup: 'Start on the Free plan: one session of up to 15 minutes.',
    reset: 'We will e-mail you a link to choose a new password.',
    sso: 'Use the identity provider of your company.'
  };

  C.views.login = function login() {
    const expired = S.auth && S.auth.expired;
    const title = A.pending ? 'Check your browser' : TITLES[A.mode] || TITLES.signin;
    const sub = expired ? 'Your session expired. Sign in again to continue.' : SUBS[A.mode] || SUBS.signin;
    return `<div class="auth">
      <section class="auth-panel" aria-labelledby="authTitle">
        <header class="auth-head">
          <div class="auth-logo" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
          <div class="stack" style="gap:6px;align-items:center"><h1 class="auth-title" id="authTitle">${esc(title)}</h1><p class="auth-sub">${esc(sub)}</p></div>
        </header>
        <div class="auth-body">
          ${serverBlock()}
          ${A.pending ? pendingBlock() : formBlock()}
          ${A.error ? `<div class="auth-msg error" role="alert">${esc(A.error)}</div>` : ''}
          ${A.info ? `<div class="auth-msg info" role="status">${esc(A.info)}</div>` : ''}
        </div>
        <p class="auth-foot">By continuing you agree to the RealTimeAI Terms and Privacy Policy.</p>
      </section></div>`;
  };

  C.afterRender.login = () => {
    // Enter submits the visible form; the first empty field gets focus.
    const submit = document.getElementById('authSubmit');
    const inputs = [...document.querySelectorAll('[data-field]')];
    inputs.forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && submit && !submit.disabled) {
          e.preventDefault();
          submit.click();
        }
      });
    });
    const first = inputs.find((i) => !i.value);
    if (first && !A.busy) first.focus();
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
    C.toast('Signed in.');
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
        } else if (e.type === 'server_ready') {
          // The local server came up after the first status check.
          await authRefresh(true);
          return;
        } else if (e.type === 'error') {
          A.pending = null;
          A.busy = '';
          A.error = e.error || 'Could not sign in.';
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
    const res = await C.guard(() => api.cloudLogin({ provider, hint: provider === 'sso' ? A.ssoHint : '' }), 'Could not start signing in.');
    A.busy = '';
    if (res && res.ok) A.pending = { provider, userCode: res.userCode, verificationUri: res.verificationUri };
    else A.error = (res && res.error) || 'Could not start signing in.';
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
      'Could not sign in.'
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
      A.error = (res && res.error) || 'Could not sign in.';
    }
    C.refresh();
  };

  C.actions['auth-reset'] = async () => {
    A.busy = 'reset';
    A.error = '';
    C.refresh();
    const res = await C.guard(() => api.cloudResetPassword(A.email), 'Could not send the link.');
    A.busy = '';
    if (res && res.ok) {
      A.mode = 'signin';
      A.info = 'If an account exists for this e-mail, we sent a link to choose a new password.';
    } else {
      A.error = (res && res.error) || 'Could not send the link.';
    }
    C.refresh();
  };
})();
