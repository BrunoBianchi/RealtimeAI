// Invite links and balances come from the signed-in account's server.
'use strict';

(function referralModule() {
  const C = window.Cue;
  const api = window.rtai;
  const { esc } = C;

  let account = {};

  function current() {
    const auth = C.state.auth;
    const signedIn = Boolean(!C.localMode() && auth?.signedIn);
    const key = signedIn && auth.account?.email
      ? JSON.stringify([auth.serverUrl || '', auth.account.email])
      : '';
    if (account.key !== key || account.signedIn !== signedIn) account = { key, signedIn };
    return account;
  }

  function refreshReferral() {
    const { view, parts } = C.state.route;
    if (view === 'home' || (view === 'settings' && parts[0] === 'plan')) C.refresh();
  }

  async function load(state, retry = false) {
    if (!state.key || state.loading || state.data || (state.error && !retry) || !api.cloudReferral) return;
    state.loading = true;
    if (retry) refreshReferral();
    let res = null;
    try {
      res = await api.cloudReferral();
    } catch (err) {
      console.error(err);
    }
    if (current() !== state) return;
    state.loading = false;
    if (res?.ok && res.data?.code && /^https?:\/\//i.test(res.data.url || '')) {
      state.data = res.data;
      state.error = '';
    } else {
      state.error = res?.status === 404 || res?.error === 'not_found' ? 'unsupported' : 'unavailable';
    }
    refreshReferral();
  }

  function pendingCard(state) {
    const note = !state.signedIn ? 'Sign in to get your referral link.'
      : state.loading ? 'Loading your referral link…'
        : state.error === 'unsupported' ? 'This server does not offer referral links yet.' : 'Your referral link is unavailable right now.';
    const action = !state.signedIn
      ? '<button type="button" class="btn sm" data-action="use-account">Sign in or create account</button>'
      : state.loading ? '' : '<button type="button" class="btn sm" data-action="referral-retry">Try again</button>';
    return `<section class="card ref-card" aria-busy="${Boolean(state.loading)}">
      <span class="eyebrow">Refer and earn</span>
      <span class="ref-card-title">Invite friends and earn minutes together.</span>
      <div class="row between wrap ref-card-progress"><span class="small muted">${note}</span>${action}</div>
    </section>`;
  }

  function linkRow(state) {
    const { url } = state.data;
    return `<div class="ref-link"><span data-no-i18n title="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</span><button type="button" class="btn primary sm" data-action="referral-copy">${state.copied ? 'Copied' : 'Copy'}</button></div>`;
  }

  function progress(data) {
    const { completed, limit, bonus_minutes: bonus, minutes_earned: minutes } = data;
    const steps = Array.from({ length: limit }, (_v, i) => `<i class="${i < completed ? 'on' : ''}"></i>`).join('');
    const note = completed >= limit
      ? C.t('All {limit} invites used · {minutes} min earned', { limit, minutes })
      : C.t('{n} of {limit} invites used · next bonus: +{bonus} min', { n: completed, limit, bonus });
    return `<div class="ref-steps" aria-hidden="true">${steps}</div><span class="small on-aurora-soft" data-no-i18n>${esc(note)}</span>`;
  }

  // Home: the small version.
  C.referralCard = () => {
    const state = current();
    if (!state.data) {
      load(state);
      return pendingCard(state);
    }
    const { bonus_minutes: bonus, completed, minutes_earned: minutes } = state.data;
    const count = C.plural(completed, 'friend', 'friends');
    return `<button type="button" class="card ref-card" data-action="referral-copy" title="Copy referral link">
      <span class="row between"><span class="eyebrow" aria-live="polite">${state.copied ? 'Copied' : 'Refer and earn'}</span><span class="ref-card-bonus mono">+${bonus} min</span></span>
      <span class="ref-card-title" data-no-i18n>${esc(C.t('Each friend who completes a first session earns {bonus} minutes for both of you.', { bonus }))}</span>
      <span class="row ref-card-progress"><span class="ref-card-people" aria-hidden="true">${Array.from({ length: Math.min(2, completed) }, () => `<i>${C.icon('users')}</i>`).join('')}<i class="ref-card-empty">${C.icon('plus')}</i></span><span class="small muted" data-no-i18n>${esc(C.t('{friends} · {minutes} min earned', { friends: count, minutes }))}</span></span>
    </button>`;
  };

  // Plan and usage: the full block.
  C.referralInvite = () => {
    const state = current();
    if (!state.data) {
      load(state);
      return pendingCard(state);
    }
    const bonus = state.data.bonus_minutes;
    return `<section class="card aurora ref-block">
      <div class="stack" style="gap:10px">
        <span class="eyebrow on-aurora">Or earn minutes</span>
        <span class="ref-title">Invite friends and cover your next interview.</span>
        <span class="on-aurora-soft" style="font-size:13px;line-height:1.5" data-no-i18n>${esc(C.t('+{bonus} min for you and for each friend who completes a first session. They enter your code when creating the account.', { bonus }))}</span>
      </div>
      <div class="stack" style="gap:10px">${linkRow(state)}${progress(state.data)}</div>
    </section>`;
  };

  C.actions['referral-retry'] = async () => {
    if (!current().key) await C.authRefresh(true);
    return load(current(), true);
  };

  C.actions['referral-copy'] = async () => {
    const state = current();
    if (!state.data) return;
    try {
      await navigator.clipboard.writeText(state.data.url);
      state.copied = true;
      refreshReferral();
      setTimeout(() => {
        state.copied = false;
        if (current() === state) refreshReferral();
      }, 1600);
    } catch (_e) {
      C.toast('Could not copy the link.', 'error');
    }
  };
})();
