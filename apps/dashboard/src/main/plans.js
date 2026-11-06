// Plans of the lipcue.com account. The server is the authority (it refuses a
// session when the quota is gone); these rules mirror cloud::PlanRules in the
// engine (src/core/include/rtai/cloud_session.hpp) and fill in what the
// server did not send, so the dashboard can explain the limit before a start.
//   Free: one single session of up to 15 minutes, once (a trial).
//   PRO:  up to 200 minutes and 1 mock interview per calendar month.
'use strict';

const PLANS = {
  free: { id: 'free', label: 'Free', minutes: 15, monthly: false, maxSessions: 1, maxSessionMinutes: 15 },
  pro: { id: 'pro', label: 'PRO', minutes: 200, monthly: true, maxSessions: null, maxSessionMinutes: 200 }
};

// Prices in US dollars; the server's plans.go holds the same catalog.
const PRICING = {
  proMonthly: 19,
  packs: [
    { id: 'tokens_60', minutes: 60, price: 7 },
    { id: 'tokens_150', minutes: 150, price: 16 },
    { id: 'tokens_400', minutes: 400, price: 40 }
  ],
  // Basic is text-only with Orby; Advanced adds voice and camera image analysis.
  // PRO's monthly mock is Advanced. Purchased credits are mode-specific.
  mockPacks: [
    { id: 'mock_basic_1', mode: 'basic', interviews: 1, price: 2.99 },
    { id: 'mock_basic_3', mode: 'basic', interviews: 3, price: 7.99 },
    { id: 'mock_advanced_1', mode: 'advanced', interviews: 1, price: 7.99 },
    { id: 'mock_advanced_3', mode: 'advanced', interviews: 3, price: 20.99 }
  ]
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
  const credit = Math.max(0, num(p.credit_minutes) ?? 0);
  const mocksLimit = Math.max(0, num(p.mocks_limit) ?? (rules.id === 'pro' ? 1 : 0));
  const mocksUsed = Math.max(0, num(p.mocks_used) ?? 0);
  const mockCredits = Math.max(0, num(p.mock_credits) ?? 0);
  const mockBasicCredits = Math.max(0, num(p.mock_basic_credits) ?? 0);
  const mockAdvancedCredits = Math.max(0, num(p.mock_advanced_credits) ?? mockCredits);
  const mocksLeft = Math.max(0, mocksLimit - mocksUsed);
  const trialUsed = rules.id === 'free' && sessionsUsed >= rules.maxSessions;
  const left = trialUsed && credit > 0 ? 0 : Math.max(0, limit - used);
  const maxSession = Math.min(num(p.max_session_minutes) ?? rules.maxSessionMinutes, left + credit);
  let canStart = left + credit > 0;
  let reason = '';
  if (trialUsed && credit <= 0) {
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
    creditMinutes: credit,
    sessionsUsed,
    maxSessions: rules.maxSessions,
    maxSessionMinutes: Math.max(0, maxSession),
    periodEnd: p.period_end || '',
    canStart,
    mocksLimit,
    mocksLeft,
    mockCredits,
    mockBasicCredits,
    mockAdvancedCredits,
    canMock: mocksLeft + mockBasicCredits + mockAdvancedCredits > 0,
    reason
  };
}

module.exports = { PLANS, PRICING, planId, entitlement };
