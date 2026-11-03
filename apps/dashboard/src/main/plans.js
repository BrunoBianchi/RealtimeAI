// Plans of the RealTimeAI account. The server is the authority (it refuses a
// session when the quota is gone); these rules mirror cloud::PlanRules in the
// engine (src/core/include/rtai/cloud_session.hpp) and fill in what the
// server did not send, so the dashboard can explain the limit before a start.
//   Free: one single session of up to 15 minutes, once (a trial).
//   PRO:  up to 200 minutes per calendar month.
'use strict';

const PLANS = {
  free: { id: 'free', label: 'Free', minutes: 15, monthly: false, maxSessions: 1, maxSessionMinutes: 15 },
  pro: { id: 'pro', label: 'PRO', minutes: 200, monthly: true, maxSessions: null, maxSessionMinutes: 200 }
};

function planId(raw) {
  const id = String((raw && (raw.id || raw)) || '').trim().toLowerCase();
  return id === 'pro' || id === 'premium' ? 'pro' : 'free';
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// What the signed-in account may do now, from GET /v1/me ({ plan: {...} }).
function entitlement(account) {
  const p = (account && account.plan) || {};
  const rules = PLANS[planId(p)];
  const limit = num(p.minutes_limit) ?? rules.minutes;
  const used = Math.max(0, num(p.minutes_used) ?? 0);
  const sessionsUsed = Math.max(0, num(p.sessions_used) ?? 0);
  const left = Math.max(0, limit - used);
  const maxSession = Math.min(num(p.max_session_minutes) ?? rules.maxSessionMinutes, left);
  let canStart = left > 0;
  let reason = '';
  if (rules.id === 'free' && sessionsUsed >= rules.maxSessions) {
    canStart = false;
    reason = 'You already used the free 15-minute session. Upgrade to PRO to continue.';
  } else if (!canStart) {
    reason = rules.monthly
      ? `This month's ${limit} PRO minutes are used up. They renew ${p.period_end ? `on ${p.period_end}` : 'next month'}.`
      : 'You already used the free minutes. Upgrade to PRO to continue.';
  }
  return {
    planId: rules.id,
    planLabel: rules.label,
    isPro: rules.id === 'pro',
    monthly: rules.monthly,
    limitMinutes: limit,
    usedMinutes: used,
    leftMinutes: left,
    sessionsUsed,
    maxSessions: rules.maxSessions,
    maxSessionMinutes: Math.max(0, maxSession),
    periodEnd: p.period_end || '',
    canStart,
    reason
  };
}

module.exports = { PLANS, planId, entitlement };
