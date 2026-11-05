// lipcue.com dashboard — sign-in. Until the user signs in or picks local mode,
// app.js renders only this screen (no sidebar, tabs or settings) and ignores
// every other action. Ways in, handled by the main process (cloud_account.js):
// e-mail + password (with sign-up and password reset), or "Continue locally" ([servidor]
// modo = local: own API keys, no account, PRO features shown as ads).
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon } = C;

  // Screen state. The password lives only here, only until it is sent.
  const A = { mode: 'signin', email: '', name: '', password: '', busy: '', error: '', info: '' };


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
    return `<div class="auth-server"><span>This build has no lipcue.com server configured. Enter its address to sign in.</span>
      <input class="input sm" type="text" value="${esc(cfg.server_url || '')}" placeholder="https://server.example.com" data-change="auth-server" aria-label="Server address"/></div>`;
  }

  function formBlock() {
    if (A.mode === 'reset') {
      return `<div class="auth-step">
        ${field('email', 'Account e-mail', 'email', A.email, 'you@email.com', 'email')}
        <button type="button" class="auth-btn primary" id="authSubmit" data-action="auth-reset" ${dis()}>${spinner('reset')}Send reset link</button>
        <div class="auth-links center"><button type="button" class="auth-link" data-action="auth-mode" data-mode="signin">Back to sign in</button></div></div>`;
    }
    const signup = A.mode === 'signup';
    return `<div class="auth-step">
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

  // Local mode: no account and no server, only the user's own API keys.
  function localBlock() {
    return `<div class="auth-local">
      <div class="auth-divider">or</div>
      <button type="button" class="auth-btn" data-action="auth-local" ${dis()}>${icon('key')}Continue locally with my API keys</button>
      <p class="auth-local-note">No account and nothing sent to our servers. Answers start ${C.LOCAL_ANSWER_DELAY_MS} ms later than with PRO, and cloud backup, sync and Google Calendar stay off.</p>
    </div>`;
  }

  const TITLES = { signin: 'Welcome to lipcue.com', signup: 'Create your account', reset: 'Reset your password' };
  const SUBS = {
    signin: 'Your real-time interview copilot. Sign in to continue.',
    signup: 'Start on the Free plan: one session of up to 15 minutes.',
    reset: 'We will e-mail you a link to choose a new password.'
  };

  C.views.login = function login() {
    const expired = S.auth && S.auth.expired;
    const title = TITLES[A.mode] || TITLES.signin;
    const sub = expired ? 'Your session expired. Sign in again to continue.' : SUBS[A.mode] || SUBS.signin;
    return `<div class="auth">
      <section class="auth-panel" aria-labelledby="authTitle">
        <header class="auth-head">
          <div class="auth-logo" aria-label="LipCue">${C.fullLogo ? C.fullLogo('auth-logo-svg') : icon('lipcue')}</div>
          <div class="stack" style="gap:6px;align-items:center"><h1 class="auth-title" id="authTitle">${esc(title)}</h1><p class="auth-sub">${esc(sub)}</p></div>
        </header>
        <div class="auth-body">
          ${serverBlock()}
          ${formBlock()}
          ${A.error ? `<div class="auth-msg error" role="alert">${esc(A.error)}</div>` : ''}
          ${A.info ? `<div class="auth-msg info" role="status">${esc(A.info)}</div>` : ''}
        </div>
        ${localBlock()}
        <p class="auth-foot">By continuing you agree to the lipcue.com Terms and Privacy Policy.</p>
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
    if (S.auth.account) S.profile = { ...S.profile, name: S.auth.account.name || '', email: S.auth.account.email || '' };
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
        if (e.type === 'signed_in') {
          await signedIn(e.config);
          return;
        } else if (e.type === 'server_ready') {
          // The local server came up after the first status check.
          await authRefresh(true);
          return;
        } else if (e.type === 'error') {
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

  // Opens the sign-in screen on a given form (used by "Get PRO").
  C.authMode = (mode) => {
    A.mode = TITLES[mode] ? mode : 'signin';
    A.error = '';
    A.info = '';
  };

  C.actions['auth-mode'] = (el) => {
    A.mode = el.dataset.mode || 'signin';
    A.error = '';
    A.info = '';
    C.refresh();
  };

  C.actions['auth-local'] = async () => {
    A.error = '';
    A.info = '';
    const res = await C.saveConfig({ server_mode: 'local' });
    if (!res) return;
    C.navigate('settings/ai', true);
    C.toast('Local mode. Add your Deepgram key and an AI key to start.');
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
