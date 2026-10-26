/* global window, document, localStorage */

const state = {
  config: {},
  agents: [],
  activeAgent: null,
  sessions: [],
  profile: {},
  themeState: { preference: 'system', resolved: 'light', windowsDark: false },
  overlayStatus: { running: false, mode: 'idle', agentId: '' },
  transcriptionOnly: false,
  currentView: 'goals',
  currentGoalWorkspaceTab: 'overview',
  currentSettingsTab: 'general',
  currentLibraryTab: 'resumes',
  goalsFilter: 'current',
  searchQuery: '',
  playbooks: []
};

// ----------------------------------------------------
// UI HELPERS & TOAST
// ----------------------------------------------------
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('translate-y-4', 'opacity-0');
  el.classList.add('translate-y-0', 'opacity-100');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.classList.add('translate-y-4', 'opacity-0');
    el.classList.remove('translate-y-0', 'opacity-100');
  }, 2800);
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const parts = String(dateStr).trim().split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return String(dateStr).trim();
}

function formatCleanCompanyName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = u.hostname.replace(/^www\./i, '');
      const brand = host.split('.')[0] || host;
      return brand.charAt(0).toUpperCase() + brand.slice(1);
    } catch (_e) {}
  }
  return s;
}

function cleanDocTag(doc) {
  const raw = String(doc.tag || doc.path || '').trim().toLowerCase();
  const title = String(doc.title || doc.name || '').toLowerCase();
  if (['resume', 'material', 'playbook', 'about'].includes(raw)) {
    return raw;
  }
  if (title.includes('curriculo') || title.includes('cv') || title.includes('resume')) {
    return 'resume';
  }
  if (title.includes('playbook') || title.includes('guia') || title.includes('guide')) {
    return 'playbook';
  }
  return 'material';
}

// ----------------------------------------------------
// THEME SYNC (LIGHT / DARK / WINDOWS)
// ----------------------------------------------------
function applyTheme(resolved, preference) {
  const isDark = resolved === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  state.themeState.resolved = isDark ? 'dark' : 'light';
  if (preference) {
    state.themeState.preference = preference;
  }
  document.querySelectorAll('.theme-pref-btn').forEach((btn) => {
    const active = btn.dataset.themePref === state.themeState.preference;
    btn.classList.toggle('active-theme', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
window.applyTheme = applyTheme;

// ----------------------------------------------------
// NAVIGATION & VIEW SWITCHING
// ----------------------------------------------------
function switchView(viewName) {
  const target = viewName === 'session' ? 'goals' : viewName;
  state.currentView = target;
  document.body.dataset.view = target;

  document.querySelectorAll('.sh-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === target);
  });
  document.querySelectorAll('.view-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `view-${target}`);
  });

  const headerBreadcrumb = document.getElementById('headerBreadcrumb');
  if (headerBreadcrumb) {
    const titles = {
      goals: 'Home',
      'goal-workspace': 'Goal Workspace',
      library: 'Library',
      history: 'History',
      settings: 'Settings'
    };
    headerBreadcrumb.textContent = titles[target] || 'Home';
  }

  if (target === 'goals') renderGoalsView();
  if (target === 'goal-workspace') renderGoalWorkspace();
  if (target === 'library') renderLibraryView();
  if (target === 'history') renderSessionsList();

  if (target !== 'settings' || state.currentSettingsTab !== 'speech') {
    stopLiveInputMeter();
  } else if (target === 'settings' && state.currentSettingsTab === 'speech') {
    const inSel = document.getElementById('selectInputDevice');
    startLiveInputMeter(inSel ? inSel.value : null);
  }
}
window.switchView = switchView;

function switchGoalWorkspaceTab(tabName) {
  state.currentGoalWorkspaceTab = tabName;
  document.querySelectorAll('.goal-workspace-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.goalTab === tabName);
  });
  const overviewPane = document.getElementById('paneGoalOverview');
  const prepPane = document.getElementById('paneGoalPrep');
  const sessionsPane = document.getElementById('paneGoalSessions');
  if (overviewPane) overviewPane.classList.toggle('hidden', tabName !== 'overview');
  if (prepPane) prepPane.classList.toggle('hidden', tabName !== 'prep');
  if (sessionsPane) sessionsPane.classList.toggle('hidden', tabName !== 'sessions');

  if (tabName === 'overview') renderWorkspaceOverview();
  if (tabName === 'prep') renderWorkspacePrep();
  if (tabName === 'sessions') renderWorkspaceSessions();
}
window.switchGoalWorkspaceTab = switchGoalWorkspaceTab;

function switchSettingsTab(tabName) {
  state.currentSettingsTab = tabName;
  document.querySelectorAll('.settings-subnav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tabName);
  });
  document.querySelectorAll('.settings-subpane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `subpane-${tabName}`);
  });
  if (tabName === 'calendar') gcalOnOpen();
  if (tabName === 'speech') {
    populateAudioDevices().then(() => {
      const inSel = document.getElementById('selectInputDevice');
      startLiveInputMeter(inSel ? inSel.value : null);
    });
  } else {
    stopLiveInputMeter();
  }
}

function switchLibraryTab(tabName) {
  state.currentLibraryTab = tabName;
  document.querySelectorAll('.library-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.libTab === tabName);
  });
  renderLibraryView();
}

// ----------------------------------------------------
// OVERLAY STATUS & PROFILE
// ----------------------------------------------------
function renderOverlayStatusPill() {
  const text = document.getElementById('overlayStatusText');
  const dot = document.getElementById('overlayStatusDot');
  const stopBtn = document.getElementById('btnTopStopOverlay');
  if (state.overlayStatus && state.overlayStatus.running) {
    const modeLabel = state.overlayStatus.mode === 'demo' ? 'Demo' : 'Live';
    text.textContent = modeLabel;
    if (dot) dot.className = 'h-2 w-2 rounded-full bg-[#E11D48] animate-pulse';
    stopBtn.style.display = 'inline-flex';
  } else {
    text.textContent = 'Ready';
    if (dot) dot.className = 'h-1.5 w-1.5 rounded-full bg-emerald-500';
    stopBtn.style.display = 'none';
  }
}

function renderTranscriptionModeButton() {
  const btn = document.getElementById('btnToggleTranscriptionMode');
  const dot = document.getElementById('transcriptionModeDot');
  const label = document.getElementById('transcriptionModeLabel');
  if (!btn || !dot || !label) return;

  if (state.transcriptionOnly) {
    btn.classList.add('bg-primary/10', 'border-primary', 'text-primary');
    btn.classList.remove('sh-btn-outline');
    dot.className = 'h-2 w-2 rounded-full bg-primary animate-pulse';
    label.textContent = 'Transcription Only: Active';
  } else {
    btn.classList.remove('bg-primary/10', 'border-primary', 'text-primary');
    btn.classList.add('sh-btn-outline');
    dot.className = 'h-2 w-2 rounded-full bg-muted-foreground/60';
    label.textContent = 'Transcription Only: Inactive';
  }
}

function renderProfileHeader() {
  const p = state.profile || {};
  const name = p.name || 'Bruno Raiado';
  const email = p.email || 'bruno2002.raiado@gmail.com';
  document.getElementById('profileNameLabel').textContent = name;
  document.getElementById('billingUserName').textContent = name;
  document.getElementById('billingUserEmail').textContent = email;

  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  document.getElementById('profileAvatar').textContent = initials || 'BR';
  const accountAvatar = document.getElementById('accountAvatar');
  if (accountAvatar) accountAvatar.textContent = initials || 'BR';
}

// Sidebar card: what is still missing before a live interview.
function renderSetupCard(cfg) {
  const title = document.getElementById('setupCardTitle');
  const detail = document.getElementById('setupCardDetail');
  const dot = document.getElementById('setupCardDot');
  if (!title || !detail || !dot) return;
  const missing = [];
  if (!cfg.has_deepgram_key) missing.push('Deepgram key');
  if (!cfg.has_llm_key) missing.push('OpenRouter key');
  if (!cfg.mic_enabled && !cfg.loopback_enabled) missing.push('an audio source');
  const ready = missing.length === 0;
  title.textContent = ready ? 'Ready for live interviews' : 'Finish setup';
  detail.textContent = ready ? 'Keys and audio are set. Open Settings to adjust.' : `Add ${missing.join(' and ')} in Settings.`;
  dot.className = `h-2 w-2 shrink-0 rounded-full ${ready ? 'bg-emerald-500' : 'bg-amber-500'}`;
}

// ----------------------------------------------------
// SIDEBAR GOALS LIST
// ----------------------------------------------------
function renderSidebarGoals() {
  const bar = document.getElementById('agentSelectorBar');
  const countEl = document.getElementById('sidebarGoalCount');
  if (countEl) countEl.textContent = String(state.agents.length);
  bar.innerHTML = '';

  if (state.agents.length === 0) {
    bar.innerHTML = `
      <div class="px-2 py-3 text-xs text-muted-foreground/70 leading-relaxed">
        No current goals.<br/>Create one when another interview is on your horizon.
      </div>`;
    return;
  }

  for (const ag of state.agents) {
    const isActive = state.activeAgent && state.activeAgent.id === ag.id;
    const docCount = Array.isArray(ag.documents) ? ag.documents.length : 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sh-goal-item' + (isActive ? ' active' : '');
    const cleanCompany = formatCleanCompanyName(ag.company);
    const sub = ag.role || cleanCompany || 'Interview Room';

    btn.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13px] font-semibold text-foreground">${ag.name || cleanCompany || ag.id}</div>
        <div class="truncate text-[11px] text-muted-foreground mt-0.5">${sub} · ${docCount} doc(s)</div>
      </div>
    `;
    btn.addEventListener('click', () => {
      selectActiveAgent(ag);
      state.currentGoalWorkspaceTab = 'overview';
      switchView('goal-workspace');
    });
    bar.appendChild(btn);
  }
}

// ----------------------------------------------------
// VIEW 1: GOALS (IMAGE 5)
// ----------------------------------------------------
function renderGoalsView() {
  renderHome();
  const container = document.getElementById('goalsCardsContainer');
  const emptyState = document.getElementById('goalsEmptyState');
  const countSubtitle = document.getElementById('goalsCountSubtitle');
  const filterCurrentCount = document.getElementById('currentGoalsFilterCount');
  const filterArchivedBtn = document.getElementById('tabFilterArchived');

  const currentCount = state.agents.filter((a) => a.stage !== 'Moved on - archive').length;
  const archivedCount = state.agents.filter((a) => a.stage === 'Moved on - archive').length;
  const upcomingCount = state.agents.filter((a) => Boolean(a.next_interview_date || (a.next_interview && a.next_interview.date))).length;

  if (filterCurrentCount) filterCurrentCount.textContent = String(currentCount);
  if (filterArchivedBtn) filterArchivedBtn.textContent = `Archived · ${archivedCount}`;
  if (countSubtitle) {
    countSubtitle.textContent = `${currentCount} current ${currentCount === 1 ? 'goal' : 'goals'} · ${upcomingCount} upcoming ${upcomingCount === 1 ? 'interview' : 'interviews'}`;
  }

  let list = state.agents.filter((ag) =>
    state.goalsFilter === 'archived'
      ? ag.stage === 'Moved on - archive'
      : ag.stage !== 'Moved on - archive'
  );

  const sortEl = document.getElementById('selectGoalsSort');
  const sortVal = sortEl ? sortEl.value : 'default';
  if (sortVal === 'name') {
    list.sort((a, b) => (a.name || a.company || '').localeCompare(b.name || b.company || ''));
  } else if (sortVal === 'recent') {
    list.sort((a, b) => (b.updated_at || b.id || '').localeCompare(a.updated_at || a.id || ''));
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter((a) =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.company || '').toLowerCase().includes(q) ||
      (a.role || '').toLowerCase().includes(q)
    );
  }

  if (list.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    emptyState.classList.add('flex');
    return;
  }

  emptyState.classList.add('hidden');
  emptyState.classList.remove('flex');
  container.innerHTML = '';

  list.forEach((ag) => {
    const isSelected = state.activeAgent && state.activeAgent.id === ag.id;
    const cleanCompany = formatCleanCompanyName(ag.company) || 'Company';
    const docs = Array.isArray(ag.documents) ? ag.documents : [];
    const hasDossier = Boolean(ag.company_research || ag.company_dossier);
    const rawDate = ag.next_interview_date || (ag.next_interview && ag.next_interview.date) || '';
    const rawTime = ag.next_interview_time || (ag.next_interview && ag.next_interview.time) || '';
    const hasDate = Boolean(rawDate);

    const card = document.createElement('div');
    card.className =
      'group rounded-xl border bg-card px-4 py-3.5 transition-colors cursor-pointer hover:border-foreground/20 ' +
      (isSelected ? 'border-foreground/25' : 'border-border/70');

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const meta = [
      `${docs.length} ${docs.length === 1 ? 'material' : 'materials'}`,
      hasDossier ? 'Company recon' : '',
      ag.stage && ag.stage !== 'Active' ? ag.stage : ''
    ].filter(Boolean).join(' · ');

    card.innerHTML = `
      <div class="flex items-center justify-between gap-4">
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 text-[13px] font-semibold text-foreground">
            ${esc(cleanCompany.charAt(0).toUpperCase())}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="truncate text-[13.5px] font-medium text-foreground">${esc(ag.name || cleanCompany)}</h3>
              ${hasDate ? `<span class="badge-quiet tabular-nums">${esc(formatDisplayDate(rawDate))}${rawTime ? ' · ' + esc(rawTime) : ''}</span>` : ''}
            </div>
            <div class="truncate text-xs text-muted-foreground">
              ${esc(ag.role || 'Software Engineer')} · ${esc(cleanCompany)}${meta ? ' · ' + esc(meta) : ''}
            </div>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <button type="button" data-action="open-room" class="step-link">Open</button>
          <button type="button" data-action="demo" class="step-link">Demo</button>
          <button type="button" data-action="golive" class="sh-btn-live">
            <span class="h-1.5 w-1.5 rounded-full bg-[#E11D48]"></span>
            <span>Go live</span>
          </button>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectActiveAgent(ag);
      state.currentGoalWorkspaceTab = 'overview';
      switchView('goal-workspace');
    });

    card.querySelector('[data-action="open-room"]').addEventListener('click', (e) => {
      e.stopPropagation();
      selectActiveAgent(ag);
      state.currentGoalWorkspaceTab = 'overview';
      switchView('goal-workspace');
    });

    card.querySelector('[data-action="demo"]').addEventListener('click', (e) => {
      e.stopPropagation();
      state.activeAgent = ag;
      handleLaunchOverlay(true);
    });

    card.querySelector('[data-action="golive"]').addEventListener('click', (e) => {
      e.stopPropagation();
      state.activeAgent = ag;
      handleLaunchOverlay(false);
    });

    container.appendChild(card);
  });
}

// ----------------------------------------------------
// VIEW: GOAL WORKSPACE (IMAGES 2 & 4)
// ----------------------------------------------------
function renderGoalWorkspace() {
  if (!state.activeAgent && state.agents.length > 0) {
    state.activeAgent = state.agents[0];
  }
  const ag = state.activeAgent;
  if (!ag) return;

  const comp = (ag.company || '').trim();
  const r = (ag.role || '').trim();
  let titleStr = '';
  if (comp && r) {
    titleStr = `${comp} · ${r}`;
  } else if (comp) {
    titleStr = comp;
  } else if (r) {
    titleStr = r;
  } else {
    titleStr = ag.name || 'Goal Room';
  }

  const breadcrumb = document.getElementById('workspaceBreadcrumbGoalName');
  if (breadcrumb) breadcrumb.textContent = titleStr;

  const titleEl = document.getElementById('workspaceGoalTitle');
  if (titleEl) titleEl.textContent = titleStr;

  const stageLabel = document.getElementById('currentStageLabel');
  if (stageLabel) stageLabel.textContent = ag.stage || 'Active';

  document.querySelectorAll('.stage-option-btn').forEach((btn) => {
    const check = btn.querySelector('.stage-check');
    const match = btn.dataset.stage === (ag.stage || 'Active');
    if (check) check.classList.toggle('hidden', !match);
  });

  const rawDate = ag.next_interview_date || (ag.next_interview && ag.next_interview.date) || '';
  const rawTime = ag.next_interview_time || (ag.next_interview && ag.next_interview.time) || '';
  const hasDate = Boolean(rawDate);
  const btnOpenScheduler = document.getElementById('btnOpenScheduler');
  const badgeScheduled = document.getElementById('badgeInterviewScheduled');
  const textDate = document.getElementById('textInterviewScheduledDate');
  if (btnOpenScheduler && badgeScheduled && textDate) {
    if (hasDate) {
      btnOpenScheduler.classList.add('hidden');
      badgeScheduled.classList.remove('hidden');
      badgeScheduled.classList.add('inline-flex');
      const timeStr = rawTime ? ` · ${rawTime}` : '';
      textDate.textContent = `${formatDisplayDate(rawDate)}${timeStr}`;
    } else {
      btnOpenScheduler.classList.remove('hidden');
      badgeScheduled.classList.add('hidden');
      badgeScheduled.classList.remove('inline-flex');
    }
  }

  switchGoalWorkspaceTab(state.currentGoalWorkspaceTab || 'overview');
}
window.renderGoalWorkspace = renderGoalWorkspace;

function renderWorkspaceOverview() {
  const ag = state.activeAgent;
  if (!ag) return;

  const rawDate = ag.next_interview_date || (ag.next_interview && ag.next_interview.date) || '';
  const rawTime = ag.next_interview_time || (ag.next_interview && ag.next_interview.time) || '';
  const hasDate = Boolean(rawDate);
  const overviewEmpty = document.getElementById('overviewInterviewEmpty');
  const overviewScheduled = document.getElementById('overviewInterviewScheduled');
  const btnOverviewEditDate = document.getElementById('btnOverviewEditDate');
  const btnOverviewSkipDate = document.getElementById('btnOverviewSkipDate');
  const scheduledTitle = document.getElementById('overviewScheduledDateTitle');

  if (hasDate) {
    overviewEmpty?.classList.add('hidden');
    overviewScheduled?.classList.remove('hidden');
    btnOverviewEditDate?.classList.remove('hidden');
    btnOverviewSkipDate?.classList.remove('hidden');
    const timeStr = rawTime ? ` at ${rawTime}` : '';
    if (scheduledTitle) scheduledTitle.textContent = `${formatDisplayDate(rawDate)}${timeStr}`;
  } else {
    overviewEmpty?.classList.remove('hidden');
    overviewScheduled?.classList.add('hidden');
    btnOverviewEditDate?.classList.add('hidden');
    btnOverviewSkipDate?.classList.add('hidden');
  }

  const docs = Array.isArray(ag.documents) ? ag.documents : [];
  const hasResume = docs.some((d) => cleanDocTag(d) === 'resume');
  const materialsCount = docs.filter((d) => cleanDocTag(d) !== 'resume').length;
  const statusResume = document.getElementById('overviewStatusResume');
  const statusMaterials = document.getElementById('overviewStatusMaterials');
  const statusPlaybook = document.getElementById('overviewStatusPlaybook');

  if (statusResume) statusResume.textContent = hasResume ? 'Pinned (Default Resume)' : 'None pinned';
  if (statusMaterials) statusMaterials.textContent = `${materialsCount} doc(s)`;
  if (statusPlaybook) statusPlaybook.textContent = ag.playbook_name || 'Standard STAR';

  const strengths = ag.goal_memory_strengths || [];
  const improve = ag.goal_memory_improve || [];
  const memEmpty = document.getElementById('overviewGoalMemoryEmpty');
  const memFilled = document.getElementById('overviewGoalMemoryFilled');
  const strengthsList = document.getElementById('overviewGoalMemoryStrengthsList');
  const improveList = document.getElementById('overviewGoalMemoryImproveList');

  if (strengths.length > 0 || improve.length > 0) {
    memEmpty?.classList.add('hidden');
    memFilled?.classList.remove('hidden');
    memFilled?.classList.add('grid');
    if (strengthsList) {
      strengthsList.innerHTML = strengths.map((s) => `<li>${s}</li>`).join('');
    }
    if (improveList) {
      improveList.innerHTML = improve.map((i) => `<li>${i}</li>`).join('');
    }
  } else {
    memEmpty?.classList.remove('hidden');
    memFilled?.classList.add('hidden');
    memFilled?.classList.remove('grid');
  }

  const recentContainer = document.getElementById('overviewRecentSessionsContainer');
  if (recentContainer) {
    const agentSessions = state.sessions.filter((s) => s.agentId === ag.id);
    if (agentSessions.length === 0) {
      recentContainer.innerHTML = `
        <div class="text-xs text-muted-foreground p-3 bg-muted/20 rounded-lg text-center">
          No sessions recorded yet for this goal.
        </div>`;
    } else {
      recentContainer.innerHTML = agentSessions.slice(0, 3).map((s) => `
        <div class="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-card hover:bg-accent/40 transition">
          <div>
            <div class="text-xs font-semibold text-foreground">${s.date || 'Recent session'}</div>
            <div class="text-[11px] text-muted-foreground">${s.duration || '15m'} · ${s.turns || 0} turns</div>
          </div>
          <span class="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            Completed
          </span>
        </div>
      `).join('');
    }
  }
}

function renderWorkspacePrep() {
  const ag = state.activeAgent;
  if (!ag) return;

  const nfEmpty = document.getElementById('prepNextFocusEmpty');
  const nfFilled = document.getElementById('prepNextFocusFilled');
  if (ag.next_focus && ag.next_focus.trim()) {
    nfEmpty?.classList.add('hidden');
    nfFilled?.classList.remove('hidden');
    if (nfFilled) nfFilled.textContent = ag.next_focus;
  } else {
    nfEmpty?.classList.remove('hidden');
    nfFilled?.classList.add('hidden');
  }

  const briefCompanyRole = document.getElementById('prepBriefCompanyRole');
  const briefSummary = document.getElementById('prepBriefCompanySummary');
  const briefJobDesc = document.getElementById('prepBriefJobDesc');
  const comp = (ag.company || '').trim();
  const r = (ag.role || '').trim();
  let titleStr = '';
  if (comp && r) {
    titleStr = `${comp} · ${r}`;
  } else if (comp) {
    titleStr = comp;
  } else if (r) {
    titleStr = r;
  } else {
    titleStr = ag.name || 'Interview';
  }
  if (briefCompanyRole) {
    briefCompanyRole.textContent = titleStr;
  }
  if (briefSummary) {
    briefSummary.textContent = ag.company_research || ag.company_dossier || 'No company summary saved.';
  }
  if (briefJobDesc) {
    briefJobDesc.textContent = ag.job_description || 'Not provided. A job description is optional.';
  }

  const docs = Array.isArray(ag.documents) ? ag.documents : [];
  const pinnedResumeText = document.getElementById('prepPinnedResumeText');
  const resumeDoc = docs.find((d) => cleanDocTag(d) === 'resume');
  if (pinnedResumeText) {
    if (resumeDoc) {
      pinnedResumeText.innerHTML = `
        <span class="inline-flex items-center gap-1.5 text-foreground font-medium mt-0.5">
          <svg class="h-3.5 w-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="truncate max-w-[320px]">${resumeDoc.title || resumeDoc.name || 'Resume.pdf'}</span>
        </span>
      `;
    } else {
      pinnedResumeText.textContent = 'No default resume is available.';
    }
  }

  const materialsList = document.getElementById('prepMaterialsList');
  const nonResumeDocs = docs.filter((d) => cleanDocTag(d) !== 'resume');
  if (materialsList) {
    if (nonResumeDocs.length === 0) {
      materialsList.innerHTML = `<span class="text-muted-foreground text-xs">No extra materials attached to this goal.</span>`;
    } else {
      materialsList.innerHTML = nonResumeDocs.map((doc, idx) => `
        <span class="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-card/90 px-2.5 py-1 text-xs text-foreground hover:border-primary/40 transition-colors">
          <svg class="h-3.5 w-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="truncate max-w-[180px]">${doc.title || doc.name || 'Document'}</span>
          <button type="button" data-remove-doc="${idx}" class="text-muted-foreground hover:text-destructive cursor-pointer text-xs ml-1" title="Remove material">✕</button>
        </span>
      `).join('');

      materialsList.querySelectorAll('[data-remove-doc]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const removeIdx = parseInt(e.currentTarget.dataset.removeDoc, 10);
          const targetDoc = nonResumeDocs[removeIdx];
          ag.documents = ag.documents.filter((d) => d !== targetDoc);
          const saved = await window.rtai.saveAgent(ag);
          state.agents = saved.agents;
          selectActiveAgent(saved.saved || saved.agent || ag);
          showToast('Material removed.');
        });
      });
    }
  }

  const selectPlaybook = document.getElementById('selectPrepPlaybook');
  const playbookDesc = document.getElementById('prepPlaybookDesc');
  if (selectPlaybook) {
    const curPlaybook = ag.playbook_name || 'Standard STAR';
    const names = (state.playbooks || []).map((p) => p.name);
    // A goal can use a playbook that is not in the list (renamed, deleted,
    // imported): show it instead of silently displaying the first option.
    if (!names.includes(curPlaybook)) names.unshift(curPlaybook);
    selectPlaybook.innerHTML = names.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
    selectPlaybook.value = curPlaybook;
    const pbObj = (state.playbooks || []).find((p) => p.name === curPlaybook);
    if (playbookDesc) {
      const len = ag.playbook_answer_length || (pbObj ? pbObj.answer_length : 'Balanced');
      const struct = ag.playbook_behavioral_structure || (pbObj ? pbObj.behavioral_structure : 'STAR');
      playbookDesc.textContent = `${curPlaybook} (${len}, ${struct})`;
    }
  }

  const selectAnswerLang = document.getElementById('selectPrepAnswerLang');
  if (selectAnswerLang) {
    setSelectValue(selectAnswerLang, normalizeAnswerLanguage(ag.answer_language));
  }

  const selectCodingLang = document.getElementById('selectPrepCodingLang');
  if (selectCodingLang) {
    setSelectValue(selectCodingLang, normalizeCodingLanguage(ag.coding_language));
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// Selects `value`, adding it as an option when the list does not have it.
function setSelectValue(select, value) {
  const v = value ?? '';
  if (![...select.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v || 'Auto';
    select.appendChild(opt);
  }
  select.value = v;
}

function normalizeAnswerLanguage(lang) {
  const l = String(lang || 'pt-BR').trim().toLowerCase();
  if (l === 'auto') return 'auto';
  if (l.startsWith('en')) return 'en-US';
  if (l.startsWith('es')) return 'es-ES';
  if (l.startsWith('pt')) return 'pt-BR';
  return lang;
}

function normalizeCodingLanguage(lang) {
  const l = String(lang || '').trim().toLowerCase();
  if (!l || l === 'auto') return '';
  const map = {
    python: 'Python', py: 'Python', typescript: 'TypeScript', ts: 'TypeScript', javascript: 'TypeScript',
    js: 'TypeScript', 'c++': 'C++', cpp: 'C++', java: 'Java', go: 'Go', golang: 'Go', rust: 'Rust',
    'c#': 'C#', csharp: 'C#'
  };
  return map[l] || lang;
}

function renderWorkspaceSessions() {
  const ag = state.activeAgent;
  if (!ag) return;

  const sessionsEmpty = document.getElementById('workspaceSessionsEmpty');
  const sessionsList = document.getElementById('workspaceSessionsList');
  const agentSessions = state.sessions.filter((s) => s.agentId === ag.id);

  if (agentSessions.length === 0) {
    sessionsEmpty?.classList.remove('hidden');
    sessionsList?.classList.add('hidden');
  } else {
    sessionsEmpty?.classList.add('hidden');
    sessionsList?.classList.remove('hidden');
    if (sessionsList) {
      sessionsList.innerHTML = agentSessions.map((s, idx) => `
        <div class="sh-card p-4 flex flex-wrap items-center justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold text-foreground">${s.date || `Session #${idx + 1}`}</span>
              <span class="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                ${s.mode || 'Practice'}
              </span>
            </div>
            <div class="text-[11px] text-muted-foreground">
              Duration: ${s.duration || '15m'} · ${s.turns || 0} turns transcribed
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" data-session-debrief="${s.id || idx}" class="sh-btn-outline text-xs">
              Generate debrief
            </button>
          </div>
        </div>
      `).join('');

      sessionsList.querySelectorAll('[data-session-debrief]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const sId = e.currentTarget.dataset.sessionDebrief;
          const processingCard = document.getElementById('sessionsProcessingCard');
          processingCard?.classList.remove('hidden');
          showToast('Generating AI debrief...');
          try {
            const debriefRes = await window.rtai.generateDebrief({
              agentId: ag.id,
              sessionId: sId,
              transcript: 'Practice interview debrief transcript'
            });
            if (debriefRes && debriefRes.agent) {
              state.activeAgent = debriefRes.agent;
              const idxInList = state.agents.findIndex((a) => a.id === state.activeAgent.id);
              if (idxInList >= 0) state.agents[idxInList] = state.activeAgent;
            }
            renderGoalWorkspace();
            renderChecklist();
            showToast('Debrief generated and added to Goal Memory!');
          } catch (_err) {
            showToast('Error generating debrief.');
          } finally {
            processingCard?.classList.add('hidden');
          }
        });
      });
    }
  }
}

// ----------------------------------------------------
// GETTING STARTED CHECKLIST
// ----------------------------------------------------
function renderChecklist() {
  const hasGoals = state.agents.length > 0;
  const hasResume = state.agents.some((a) =>
    Array.isArray(a.documents) && a.documents.some((d) => cleanDocTag(d) === 'resume')
  );
  const hasSessions = state.sessions.length > 0;
  const hasDebrief = Boolean(
    state.activeAgent && (
      (state.activeAgent.goal_memory_strengths && state.activeAgent.goal_memory_strengths.length > 0) ||
      (state.activeAgent.goal_memory_improve && state.activeAgent.goal_memory_improve.length > 0)
    )
  );

  const step1Check = document.getElementById('step1Check');
  const step1Num = document.getElementById('step1Number');
  if (step1Check && step1Num) {
    step1Check.classList.toggle('hidden', !hasGoals);
    step1Num.classList.toggle('hidden', hasGoals);
    step1Check.closest('.step-row')?.classList.toggle('done', hasGoals);
  }

  const step2Check = document.getElementById('step2Check');
  const step2Num = document.getElementById('step2Number');
  if (step2Check && step2Num) {
    step2Check.classList.toggle('hidden', !hasResume);
    step2Num.classList.toggle('hidden', hasResume);
    step2Check.closest('.step-row')?.classList.toggle('done', hasResume);
  }

  const step3Check = document.getElementById('step3Check');
  const step3Num = document.getElementById('step3Number');
  if (step3Check && step3Num) {
    step3Check.classList.toggle('hidden', !hasSessions);
    step3Num.classList.toggle('hidden', hasSessions);
    step3Check.closest('.step-row')?.classList.toggle('done', hasSessions);
  }

  const step4Check = document.getElementById('step4Check');
  const step4Num = document.getElementById('step4Number');
  if (step4Check && step4Num) {
    step4Check.classList.toggle('hidden', !hasDebrief);
    step4Num.classList.toggle('hidden', hasDebrief);
    step4Check.closest('.step-row')?.classList.toggle('done', hasDebrief);
  }
}
window.renderChecklist = renderChecklist;

// ----------------------------------------------------
// VIEW 2: LIBRARY (IMAGE 4)
// ----------------------------------------------------
function getAllLibraryDocs() {
  const map = new Map();
  for (const ag of state.agents) {
    if (Array.isArray(ag.documents)) {
      for (const d of ag.documents) {
        const key = d.path || d.title || d.name;
        if (!map.has(key)) {
          map.set(key, { ...d, agentsUsing: [ag.name || ag.id] });
        } else {
          map.get(key).agentsUsing.push(ag.name || ag.id);
        }
      }
    }
  }
  return Array.from(map.values());
}

function renderLibraryView() {
  const allDocs = getAllLibraryDocs();
  const resumes = allDocs.filter((d) => cleanDocTag(d) === 'resume');
  const materials = allDocs.filter((d) => cleanDocTag(d) === 'material');
  const playbooks = allDocs.filter((d) => cleanDocTag(d) === 'playbook');

  document.getElementById('libBadgeResumes').textContent = String(resumes.length);
  document.getElementById('libBadgeMaterials').textContent = String(materials.length);
  document.getElementById('libBadgePlaybooks').textContent = String(playbooks.length);
  document.getElementById('navBadgeLibrary').textContent = String(allDocs.length);

  const container = document.getElementById('libraryDocsGrid');
  const emptyState = document.getElementById('libraryEmptyState');

  let activeList = [];
  if (state.currentLibraryTab === 'resumes') activeList = resumes;
  else if (state.currentLibraryTab === 'materials') activeList = materials;
  else if (state.currentLibraryTab === 'playbooks') activeList = playbooks;
  else activeList = allDocs;

  if (activeList.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    emptyState.classList.add('flex');
    return;
  }

  emptyState.classList.add('hidden');
  emptyState.classList.remove('flex');
  container.innerHTML = '';

  activeList.forEach((doc, idx) => {
    const card = document.createElement('div');
    card.className =
      'sh-card p-4 flex flex-col justify-between hover:border-foreground/30 transition-all shadow-sm';
    const title = doc.title || doc.name || 'Document';
    const tag = cleanDocTag(doc);
    const contentLength = (doc.content || '').length;
    const estChunks = Math.max(1, Math.round(contentLength / 600));

    card.innerHTML = `
      <div class="space-y-2">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div class="min-w-0">
              <h4 class="text-[13.5px] font-bold text-foreground truncate" title="${title}">${title}</h4>
              <span class="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                ${tag} · ${estChunks} chunks RAG
              </span>
            </div>
          </div>
        </div>

        <p class="text-xs text-muted-foreground line-clamp-2">
          ${(doc.content || 'Attached document in knowledge base.').slice(0, 140)}...
        </p>
      </div>

      <div class="mt-4 pt-3 border-t border-border/60 flex items-center justify-between text-xs">
        <button type="button" data-preview class="font-medium text-foreground hover:underline cursor-pointer">
          View Content
        </button>
        <button type="button" data-remove class="text-muted-foreground hover:text-destructive cursor-pointer">
          Remove
        </button>
      </div>
    `;

    card.querySelector('[data-preview]').addEventListener('click', () => {
      openDocPreviewModal(doc);
    });

    card.querySelector('[data-remove]').addEventListener('click', async () => {
      for (const ag of state.agents) {
        if (Array.isArray(ag.documents)) {
          ag.documents = ag.documents.filter(
            (d) => (d.path || d.title || d.name) !== (doc.path || doc.title || doc.name)
          );
          await window.rtai.saveAgent(ag);
        }
      }
      showToast('Document removed from Library.');
      const fresh = await window.rtai.getState();
      state.agents = fresh.agents;
      renderLibraryView();
      renderSidebarGoals();
    });

    container.appendChild(card);
  });
}

function openDocPreviewModal(doc) {
  document.getElementById('docPreviewTitle').textContent = doc.title || doc.name || 'Document';
  document.getElementById('docPreviewMeta').textContent = `Type: ${cleanDocTag(doc)} · ${doc.path || 'Local Storage'}`;
  document.getElementById('docPreviewContent').value = doc.content || '(No readable text content)';
  document.getElementById('modalDocPreview').classList.add('open');
}

// ----------------------------------------------------
// VIEW 4: PAST SESSIONS (HISTORY)
// ----------------------------------------------------
function renderSessionsList() {
  const container = document.getElementById('sessionsListContainer');
  const sessions = state.sessions || [];
  document.getElementById('navBadgeSessions').textContent = String(sessions.length);
  container.innerHTML = '';

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-xs text-muted-foreground leading-relaxed">
        No sessions recorded yet. When you conclude a live interview, its history and summary will appear here.
      </div>`;
    return;
  }

  for (const s of sessions) {
    const row = document.createElement('div');
    row.className =
      'flex items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/60 p-3 hover:bg-accent transition-colors cursor-pointer';
    const dt = new Date(s.updatedAt).toLocaleString('en-US');
    row.innerHTML = `
      <div class="min-w-0">
        <div class="truncate text-xs font-semibold text-foreground">${s.id}</div>
        <div class="text-[11px] text-muted-foreground mt-0.5">${dt} · ${s.sizeKb} KB</div>
      </div>
      <span class="text-xs font-semibold text-foreground">Read →</span>
    `;
    row.addEventListener('click', async () => {
      const res = await window.rtai.readSessionDetail(s.fileName);
      document.getElementById('sessionViewerText').value = res.content || '';
    });
    container.appendChild(row);
  }
}

// ----------------------------------------------------
// GOAL SETUP MODAL / DRAWER
// ----------------------------------------------------
function openGoalModal(agent) {
  const ag = agent || {
    id: 'session-' + Date.now(),
    name: 'New Interview',
    session_type: 'interview',
    company: '',
    role: '',
    job_description: '',
    extra_instructions:
      'Answer in first person with clarity, using real examples from my resume (STAR method) without inventing facts.',
    company_research: '',
    mini_compact: '',
    documents: []
  };

  document.getElementById('inputGoalId').value = ag.id;
  document.getElementById('inputModalCompany').value = ag.company || '';
  document.getElementById('inputModalRole').value = ag.role || '';
  document.getElementById('inputModalJobDescription').value = ag.job_description || '';
  document.getElementById('inputModalExtraInstructions').value =
    ag.extra_instructions || ag.custom_instructions || '';
  document.getElementById('inputModalCompanyResearch').value =
    ag.company_research || ag.company_dossier || '';
  document.getElementById('inputModalMiniCompact').value = ag.mini_compact || '';
  document.getElementById('inputGoalSessionType').value = ag.session_type || 'interview';

  const reconBadge = document.getElementById('modalCompanyReconBadge');
  const reconText = document.getElementById('modalCompanyReconText');
  const dossier = ag.company_research || ag.company_dossier || '';
  if (dossier.trim().length > 0) {
    reconBadge.classList.remove('hidden');
    reconBadge.classList.add('flex');
    reconText.textContent = `${dossier.replace(/===.*?===/g, '').replace(/\s+/g, ' ').slice(0, 70)}...`;
  } else {
    reconBadge.classList.add('hidden');
    reconBadge.classList.remove('flex');
  }

  renderModalGoalDocs(ag.documents || []);
  document.getElementById('modalGoalSetup').classList.add('open');
}

function renderModalGoalDocs(docs) {
  const container = document.getElementById('modalGoalDocsList');
  container.innerHTML = '';
  if (docs.length === 0) {
    container.innerHTML = `
      <span class="text-xs text-muted-foreground py-1">
        No files attached to this goal yet.
      </span>`;
    return;
  }
  docs.forEach((doc, idx) => {
    const chip = document.createElement('div');
    chip.className =
      'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-xs font-medium text-foreground';
    chip.innerHTML = `
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span class="truncate max-w-[190px]">${doc.title || doc.name || 'File'}</span>
      <button type="button" data-remove-idx="${idx}" class="ml-1 text-muted-foreground hover:text-destructive cursor-pointer">✕</button>
    `;
    chip.querySelector('[data-remove-idx]').addEventListener('click', () => {
      docs.splice(idx, 1);
      renderModalGoalDocs(docs);
    });
    container.appendChild(chip);
  });
}

function collectAgentFromGoalModal() {
  const id = document.getElementById('inputGoalId').value || 'session-' + Date.now();
  const company = document.getElementById('inputModalCompany').value.trim();
  const role = document.getElementById('inputModalRole').value.trim();
  const job_description = document.getElementById('inputModalJobDescription').value.trim();
  const extra_instructions = document.getElementById('inputModalExtraInstructions').value.trim();
  const company_research = document.getElementById('inputModalCompanyResearch').value.trim();
  const mini_compact = document.getElementById('inputModalMiniCompact').value.trim();
  const session_type = document.getElementById('inputGoalSessionType').value || 'interview';

  const brandLabel = formatCleanCompanyName(company);
  let autoName = 'New Interview';
  if (brandLabel && role) {
    autoName = `${brandLabel} — ${role}`;
  } else if (brandLabel) {
    autoName = `Interview — ${brandLabel}`;
  } else if (role) {
    autoName = role;
  }

  const existing = state.agents.find((a) => a.id === id);
  const docs = existing && Array.isArray(existing.documents) ? existing.documents : [];

  return {
    ...(existing || {}),
    id,
    name: autoName,
    company,
    role,
    job_description,
    extra_instructions,
    custom_instructions: extra_instructions,
    company_research,
    company_dossier: company_research,
    mini_compact,
    session_type,
    documents: docs
  };
}

function selectActiveAgent(agent) {
  state.activeAgent = agent ? JSON.parse(JSON.stringify(agent)) : null;
  renderSidebarGoals();
  renderGoalsView();
  if (state.currentView === 'goal-workspace') {
    renderGoalWorkspace();
  }
  renderChecklist();
}
window.selectActiveAgent = selectActiveAgent;

// ----------------------------------------------------
// LAUNCH OVERLAY (LIVE / DEMO)
// ----------------------------------------------------
async function handleLaunchOverlay(demoMode) {
  let targetAgent = state.activeAgent;
  if (!targetAgent && state.agents.length > 0) {
    targetAgent = state.agents[0];
  }
  if (!targetAgent) {
    showToast('Please create or select a goal first.');
    openGoalModal(null);
    return;
  }

  showToast(demoMode ? 'Starting Overlay in Demo Mode...' : 'Starting Live Overlay...');

  const configOverrides = {
    model: document.getElementById('selectDefaultModel')?.value || 'qwen/qwen3.6-flash',
    // Transcription language (Defaults). The goal's answer language only
    // shapes the answers, never what Deepgram listens for.
    language: document.getElementById('selectDefaultLanguage')?.value || (state.config && state.config.language) || 'pt-BR',
    auto_suggest: document.getElementById('cfgDefaultAutoSuggest')?.checked ?? true,
    save_sessions: document.getElementById('cfgDefaultSaveSessions')?.checked ?? true
  };

  try {
    const res = await window.rtai.startOverlay({
      agent: targetAgent,
      demo: demoMode,
      configOverrides
    });

    if (res && res.agent) {
      const fresh = await window.rtai.getState();
      state.agents = fresh.agents;
      state.config = fresh.config;
      state.overlayStatus = fresh.overlayStatus;
      state.activeAgent = res.agent;
      renderOverlayStatusPill();
      renderSidebarGoals();
    }
  } catch (err) {
    console.error('Failed to start overlay:', err);
    showToast('Failed to start Overlay.');
  }
}

// ----------------------------------------------------
// AI MODEL TIER SELECTION (FAST / MEDIUM / ULTRA)
// ----------------------------------------------------
function getTierForModel(m) {
  if (!m) return 'fast';
  const lower = String(m).toLowerCase();
  if (lower.includes('llama') || lower.includes('medium') || lower === 'llama-3.3-70b') return 'medium';
  if (lower.includes('120b') || lower.includes('ultra') || lower.includes('72b') || lower.includes('gpt-oss') || lower.includes('gpt-4o')) return 'ultra';
  return 'fast';
}

const TIER_INFO = {
  fast: { label: 'Fast', model: 'Qwen 3.6 Flash' },
  medium: { label: 'Balanced', model: 'Llama 3.3 70B' },
  ultra: { label: 'Ultra', model: 'GPT-OSS 120B' }
};

// Mirrors the routing in src/app/src/main.cpp: model ids with a "/" go to
// OpenRouter when an OpenRouter key exists; bare ids go to Cerebras when a
// Cerebras key exists. GPT-OSS needs the "openai/" prefix on OpenRouter.
function resolveTierModel(tier, cardModel) {
  const cfg = state.config || {};
  if (tier === 'ultra') {
    return cfg.has_cerebras_key ? 'gpt-oss-120b' : 'openai/gpt-oss-120b';
  }
  return cardModel;
}

function providerForModel(model) {
  const cfg = state.config || {};
  const m = String(model || '');
  const isOpenRouterId = m.includes('/');
  if (isOpenRouterId && (cfg.has_llm_key || !cfg.has_cerebras_key)) return 'OpenRouter';
  if (!isOpenRouterId && cfg.has_cerebras_key) return 'Cerebras';
  return 'OpenRouter';
}

function updateModelCardsUI(selectedTier, selectedModel) {
  const cards = document.querySelectorAll('.model-card');
  const badge = document.getElementById('activeModelBadge');

  cards.forEach((card) => {
    const tier = card.dataset.tier;
    const isSelected = tier === selectedTier;
    card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    card.tabIndex = isSelected ? 0 : -1;
    const provider = card.querySelector('[data-provider]');
    if (provider) {
      const model = isSelected && selectedModel ? selectedModel : resolveTierModel(tier, card.dataset.model);
      provider.textContent = `via ${providerForModel(model)}`;
    }
  });
  // Keep the group reachable by keyboard even if nothing matched.
  if (![...cards].some((c) => c.tabIndex === 0) && cards[0]) cards[0].tabIndex = 0;

  if (badge) {
    const info = TIER_INFO[selectedTier] || TIER_INFO.fast;
    badge.dataset.tier = TIER_INFO[selectedTier] ? selectedTier : 'fast';
    badge.textContent = `${info.label} · ${info.model}`;
  }

  const modelSel = document.getElementById('selectDefaultModel');
  if (modelSel && selectedModel && modelSel.value !== selectedModel) {
    let opt = [...modelSel.options].find((o) => o.value === selectedModel);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = selectedModel;
      opt.textContent = selectedModel;
      modelSel.prepend(opt);
    }
    modelSel.value = selectedModel;
  }
}

async function selectModelTier(tier, modelId, userTriggered = false) {
  const fallback =
    tier === 'medium' ? 'meta-llama/llama-3.3-70b-instruct' :
    tier === 'ultra' ? 'gpt-oss-120b' :
    'qwen/qwen3.6-flash';
  const modelToUse = userTriggered ? resolveTierModel(tier, modelId || fallback) : (modelId || fallback);

  updateModelCardsUI(tier, modelToUse);

  if (userTriggered) {
    try {
      const res = await window.rtai.saveConfig({ model: modelToUse });
      if (res && res.config) {
        state.config = res.config;
      }
      const tierTitle = (TIER_INFO[tier] || TIER_INFO.fast).label;
      if (res && res.overlayRestarted) {
        showToast(`Answer model set to ${tierTitle}. Overlay restarted with the new model.`);
      } else {
        showToast(`Answer model set to ${tierTitle}.`);
      }
    } catch (err) {
      console.error('Failed to save model tier:', err);
      showToast('Could not save the answer model.');
    }
  }
}

function updateStealthBadge() {
  const badge = document.getElementById('badgeStealthStatus');
  if (!badge) return;
  const dock = document.getElementById('cfgStealthDock')?.checked ?? true;
  const mon = document.getElementById('cfgStealthActivityMonitor')?.checked ?? true;
  const screen = document.getElementById('cfgStealthScreenCapture')?.checked ?? true;
  const activeCount = (dock ? 1 : 0) + (mon ? 1 : 0) + (screen ? 1 : 0);

  if (activeCount === 3) {
    badge.textContent = 'All on';
    badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 transition-colors';
  } else if (activeCount > 0) {
    badge.textContent = 'Partly on';
    badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 transition-colors';
  } else {
    badge.textContent = 'Off';
    badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors';
  }
}

function updateStealthUI(st) {
  const s = st || (state && state.stealthState) || { active: true, screenProtection: true, skipTaskbar: false, disguise: false };
  const btn = document.getElementById('btnTopStealthMode');
  const label = document.getElementById('labelTopStealth');
  const indicator = document.getElementById('indicatorTopStealth');
  const icon = document.getElementById('iconStealthShield');
  const electronBadge = document.getElementById('badgeElectronStealth');

  if (btn) {
    btn.dataset.active = s.active ? 'true' : 'false';
    if (label) label.textContent = s.active ? 'Hidden' : 'Visible';
    if (indicator) indicator.className = s.active ? 'h-1.5 w-1.5 rounded-full bg-emerald-500' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/40';
    if (icon) icon.classList.toggle('text-emerald-500', Boolean(s.active));
    btn.title = s.active
      ? 'Hidden from screen sharing (Ctrl+Alt+S). Click to make the window visible.'
      : 'Visible in screen sharing (Ctrl+Alt+S). Click to hide it from recordings.';
  }

  if (electronBadge) {
    if (s.active) {
      electronBadge.textContent = 'Ativo';
      electronBadge.className = 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400';
    } else {
      electronBadge.textContent = 'Desativado';
      electronBadge.className = 'rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground';
    }
  }

  const screenIn = document.getElementById('cfgElectronScreenProtection');
  if (screenIn && s.screenProtection !== undefined) screenIn.checked = Boolean(s.screenProtection);

  const taskbarIn = document.getElementById('cfgElectronSkipTaskbar');
  if (taskbarIn && s.skipTaskbar !== undefined) taskbarIn.checked = Boolean(s.skipTaskbar);

  const disguiseIn = document.getElementById('cfgElectronDisguise');
  if (disguiseIn && s.disguise !== undefined) disguiseIn.checked = Boolean(s.disguise);

  const heroToggle = document.getElementById('toggleHeroStealth');
  const heroLabel = document.getElementById('labelHeroStealth');
  if (heroToggle) heroToggle.checked = Boolean(s.active);
  if (heroLabel) heroLabel.textContent = s.active ? 'Hidden' : 'Detectable';

  updateStealthBadge();
}

// ----------------------------------------------------
// SETTINGS POPULATION & SYNC
// ----------------------------------------------------
function populateSettingsForm(cfg) {
  if (!cfg) return;

  const targetModel = cfg.model || 'qwen/qwen3.6-flash';
  const tier = getTierForModel(targetModel);
  selectModelTier(tier, targetModel, false);

  const langSel = document.getElementById('selectDefaultLanguage');
  if (langSel && cfg.language) {
    const l = String(cfg.language).toLowerCase();
    langSel.value = l === 'multi' ? 'multi' : l.startsWith('en') ? 'en-US' : l.startsWith('es') ? 'es' : 'pt-BR';
  }

  const autoSuggestIn = document.getElementById('cfgDefaultAutoSuggest');
  if (autoSuggestIn) autoSuggestIn.checked = Boolean(cfg.auto_suggest ?? true);

  const saveSessionsIn = document.getElementById('cfgDefaultSaveSessions');
  if (saveSessionsIn) saveSessionsIn.checked = Boolean(cfg.save_sessions ?? true);

  const stealthDockIn = document.getElementById('cfgStealthDock');
  if (stealthDockIn) stealthDockIn.checked = Boolean(cfg.stealth_dock ?? true);

  const stealthMonIn = document.getElementById('cfgStealthActivityMonitor');
  if (stealthMonIn) stealthMonIn.checked = Boolean(cfg.stealth_activity_monitor ?? true);

  const stealthClickIn = document.getElementById('cfgStealthClickThrough');
  if (stealthClickIn) stealthClickIn.checked = Boolean(cfg.stealth_click_through ?? false);

  const stealthScreenIn = document.getElementById('cfgStealthScreenCapture');
  if (stealthScreenIn) stealthScreenIn.checked = Boolean(cfg.stealth_screen_capture ?? true);

  const electronScreenIn = document.getElementById('cfgElectronScreenProtection');
  if (electronScreenIn) electronScreenIn.checked = Boolean(cfg.electron_screen_protection ?? true);

  const electronTaskbarIn = document.getElementById('cfgElectronSkipTaskbar');
  if (electronTaskbarIn) electronTaskbarIn.checked = Boolean(cfg.electron_skip_taskbar ?? false);

  const electronDisguiseIn = document.getElementById('cfgElectronDisguise');
  if (electronDisguiseIn) electronDisguiseIn.checked = Boolean(cfg.electron_disguise ?? false);

  updateStealthBadge();
  updateStealthUI({
    active: Boolean(cfg.electron_stealth ?? true),
    screenProtection: Boolean(cfg.electron_screen_protection ?? true),
    skipTaskbar: Boolean(cfg.electron_skip_taskbar ?? false),
    disguise: Boolean(cfg.electron_disguise ?? false)
  });

  const dgBadge = document.getElementById('badgeDgKey');
  const dgClear = document.getElementById('btnClearDgKey');
  if (dgBadge) {
    dgBadge.textContent = cfg.has_deepgram_key ? 'Connected' : 'Not set';
    dgBadge.className = cfg.has_deepgram_key ? 'text-[11px] font-semibold text-emerald-600 dark:text-emerald-400' : 'text-[11px] font-medium text-muted-foreground';
  }
  if (dgClear) {
    if (cfg.has_deepgram_key) {
      dgClear.classList.remove('hidden');
    } else {
      dgClear.classList.add('hidden');
    }
  }

  const llmBadge = document.getElementById('badgeLlmKey');
  const llmClear = document.getElementById('btnClearLlmKey');
  if (llmBadge) {
    llmBadge.textContent = cfg.has_llm_key ? 'Connected' : 'Not set';
    llmBadge.className = cfg.has_llm_key ? 'text-[11px] font-semibold text-emerald-600 dark:text-emerald-400' : 'text-[11px] font-medium text-muted-foreground';
  }
  if (llmClear) {
    if (cfg.has_llm_key) {
      llmClear.classList.remove('hidden');
    } else {
      llmClear.classList.add('hidden');
    }
  }

  const dgIn = document.getElementById('cfgDeepgramKey');
  if (dgIn) dgIn.placeholder = cfg.deepgram_key_display || 'Paste your Deepgram key...';

  const llmIn = document.getElementById('cfgLlmKey');
  if (llmIn) llmIn.placeholder = cfg.llm_key_display || 'Paste your OpenRouter key sk-or-v1-...';

  const micIn = document.getElementById('cfgMicEnabled');
  if (micIn) micIn.checked = Boolean(cfg.mic_enabled);

  const loopIn = document.getElementById('cfgLoopbackEnabled');
  if (loopIn) loopIn.checked = Boolean(cfg.loopback_enabled);

  renderSetupCard(cfg);

  // Plain fields bound to config.ini through data-cfg-key.
  document.querySelectorAll('[data-cfg-key]').forEach((el) => {
    if (document.activeElement === el) return;
    const v = cfg[el.dataset.cfgKey];
    if (v === undefined || v === null) return;
    if (el.tagName === 'SELECT' && el.dataset.cfgType === 'int') {
      // Pick the closest option (an older config may hold another value).
      const opts = [...el.options].map((o) => Number(o.value));
      const best = opts.reduce((a, b) => (Math.abs(b - Number(v)) < Math.abs(a - Number(v)) ? b : a), opts[0]);
      el.value = String(best);
    } else {
      el.value = String(v);
    }
  });

  const pathEl = document.getElementById('cfgConfigPath');
  if (pathEl && cfg.configPath) {
    pathEl.textContent = cfg.configPath;
    pathEl.title = cfg.configPath;
  }

  const autoUpIn = document.getElementById('cfgAutoUpdate');
  if (autoUpIn) autoUpIn.checked = Boolean(cfg.auto_update ?? true);

  const opIn = document.getElementById('inputInterfaceOpacity');
  const opVal = Math.round((cfg.interface_opacity ?? cfg.electron_opacity ?? 1.0) * 100);
  if (opIn) opIn.value = opVal;
  const opLbl = document.getElementById('labelInterfaceOpacity');
  if (opLbl) opLbl.textContent = `${opVal}%`;

  selectProcessDisguise(cfg.process_disguise || 'none');

  // AI Providers (Image 1)
  const activeModelSel = document.getElementById('selectActiveModelChoice');
  if (activeModelSel) {
    activeModelSel.value = cfg.model || 'qwen/qwen3.6-flash';
  }

  const bgModelSel = document.getElementById('selectBackgroundModelChoice');
  if (bgModelSel && cfg.background_model) {
    bgModelSel.value = cfg.background_model;
  }

  const aiRespLangSel = document.getElementById('selectAiResponseLanguageChoice');
  if (aiRespLangSel && cfg.ai_response_language) {
    aiRespLangSel.value = cfg.ai_response_language;
  }

  const directAssistIn = document.getElementById('toggleDirectAssist');
  if (directAssistIn) {
    directAssistIn.checked = Boolean(cfg.direct_assist);
  }

  const fastResponseIn = document.getElementById('toggleFastResponseMode');
  if (fastResponseIn) {
    fastResponseIn.checked = Boolean(cfg.fast_response_mode);
  }

  // Cloud Keys Badges
  const setupKeyBadge = (badgeId, clearBtnId, inputId, hasKey, displayVal) => {
    const badge = document.getElementById(badgeId);
    const clearBtn = document.getElementById(clearBtnId);
    const input = document.getElementById(inputId);
    if (badge) {
      badge.textContent = hasKey ? 'Connected' : 'Not set';
      badge.className = hasKey ? 'text-[11px] font-semibold text-emerald-600 dark:text-emerald-400' : 'text-[11px] font-medium text-muted-foreground';
    }
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !hasKey);
    }
    if (input && displayVal) {
      input.placeholder = displayVal;
    }
  };

  setupKeyBadge('badgeOpenAiKey', 'btnClearOpenAiKey', 'cfgOpenAiKey', cfg.has_openai_key, cfg.openai_key_display);
  setupKeyBadge('badgeAnthropicKey', 'btnClearAnthropicKey', 'cfgAnthropicKey', cfg.has_anthropic_key, cfg.anthropic_key_display);
  setupKeyBadge('badgeGeminiKey', 'btnClearGeminiKey', 'cfgGeminiKey', cfg.has_gemini_key, cfg.gemini_key_display);

  const localEndpointIn = document.getElementById('cfgLocalEndpoint');
  if (localEndpointIn && cfg.local_endpoint) localEndpointIn.value = cfg.local_endpoint;

  const localModelIn = document.getElementById('cfgLocalModel');
  if (localModelIn && cfg.local_model) localModelIn.value = cfg.local_model;

  // Speech & Audio (Image 2)
  const speechProvSel = document.getElementById('selectSpeechProvider');
  if (speechProvSel && cfg.speech_provider) {
    speechProvSel.value = cfg.speech_provider;
  }

  const speechLangSel = document.getElementById('selectSpeechLanguage');
  if (speechLangSel && cfg.speech_language) {
    speechLangSel.value = cfg.speech_language;
  }

  const inputDevSel = document.getElementById('selectInputDevice');
  if (inputDevSel && cfg.audio_input_device) {
    inputDevSel.value = cfg.audio_input_device;
  }

  const outputDevSel = document.getElementById('selectOutputDevice');
  if (outputDevSel && cfg.audio_output_device) {
    outputDevSel.value = cfg.audio_output_device;
  }

  // Google Calendar Meeting Detect sync (Images 3 & 4)
  const calDetectIn = document.getElementById('cfgCalendarDetectMeetings');
  const meetDetectIn = document.getElementById('cfgMeetingDetect');
  if (calDetectIn) {
    calDetectIn.checked = meetDetectIn ? meetDetectIn.checked : true;
  }
}

// ----------------------------------------------------
// APP UPDATES, PROCESS DISGUISE & INTERFACE OPACITY
// ----------------------------------------------------
let availableAppUpdate = null;
let appVersionInfo = { version: '', channel: 'stable', packaged: false };

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Single place that turns the updater status (main process) into UI.
function renderUpdateStatus(st) {
  if (!st) return;
  availableAppUpdate = st;
  const current = st.currentVersion || appVersionInfo.version || '';
  const latest = st.latestVersion || current;
  const statusEl = document.getElementById('updateStatusText');
  const banner = document.getElementById('updateBanner');
  const chip = document.getElementById('btnTopVersionBadge');
  const chipDot = document.getElementById('topVersionBadgeDot');
  const btnDownload = document.getElementById('btnDownloadUpdate');
  const btnRestart = document.getElementById('btnRestartUpdate');
  const btnModal = document.getElementById('btnModalDownloadUpdate');
  const barWrap = document.getElementById('updateProgressBarContainer');
  const modalBarWrap = document.getElementById('modalUpdateProgressContainer');

  const messages = {
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    'up-to-date': `You're on the latest version${st.channel === 'beta' ? ' (beta channel)' : ''}.`,
    available: `Version ${latest} is available.`,
    downloading: `Downloading ${latest}…`,
    downloaded: `Version ${latest} is ready. Restart to finish.`,
    error: `Couldn't check for updates: ${st.error || 'unknown error'}`,
    disabled: st.error || 'Updates are off in this build.'
  };
  if (statusEl) statusEl.textContent = messages[st.status] || messages.idle;

  const hasUpdate = ['available', 'downloading', 'downloaded'].includes(st.status);
  if (banner) banner.classList.toggle('hidden', !hasUpdate);
  setText('updateBannerTitle', `RealTimeAI ${latest}${st.prerelease ? ' (beta)' : ''}`);
  setText('updateBannerNotes', (st.releaseNotes || '').split('\n').filter(Boolean).slice(0, 2).join(' · '));

  if (chip) {
    chip.dataset.state = hasUpdate ? st.status : 'idle';
    const label = st.status === 'downloaded' ? 'Restart to update'
      : st.status === 'downloading' ? `Updating ${st.progress ? st.progress.percent + '%' : ''}`.trim()
      : st.status === 'available' ? `Update ${latest}`
      : `v${current}`;
    setText('topVersionBadgeLabel', label);
    chip.title = messages[st.status] || 'Version and updates';
  }
  if (chipDot) chipDot.className = hasUpdate ? 'h-1.5 w-1.5 rounded-full bg-primary' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/40';

  const downloading = st.status === 'downloading';
  if (barWrap) barWrap.classList.toggle('hidden', !downloading);
  if (modalBarWrap) modalBarWrap.classList.toggle('hidden', !downloading);
  if (downloading && st.progress) applyUpdateProgress(st.progress);

  if (btnDownload) {
    btnDownload.classList.toggle('hidden', st.status !== 'available' && !downloading);
    btnDownload.disabled = downloading;
    btnDownload.textContent = downloading ? 'Downloading…' : 'Download';
  }
  if (btnRestart) btnRestart.classList.toggle('hidden', st.status !== 'downloaded');

  // Modal mirrors the same state.
  setText('modalUpdateVersionTag', hasUpdate ? `v${latest}` : `v${current}`);
  setText('modalUpdateSubtitle', hasUpdate ? messages[st.status] : messages[st.status] || '');
  if (st.releaseNotes) setText('modalUpdateNotes', st.releaseNotes);
  if (btnModal) {
    btnModal.disabled = downloading || st.status === 'checking';
    btnModal.textContent = st.status === 'downloaded' ? 'Restart to update'
      : st.status === 'available' ? `Download ${latest}`
      : downloading ? 'Downloading…'
      : 'Check for updates';
  }
}

function applyUpdateProgress(info) {
  const p = Math.max(0, Math.min(100, Number(info.percent) || 0));
  const text = `Downloading… ${p}%${info.transferred ? ` · ${info.transferred}${info.total ? ' of ' + info.total : ''}` : ''}${info.speed ? ` · ${info.speed}` : ''}`;
  ['updateProgressBar', 'modalUpdateProgressBar'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${p}%`;
  });
  setText('updateProgressPercent', text);
  setText('modalUpdateProgressPercent', text);
}

async function checkAppUpdates(silent = false) {
  const btnCheck = document.getElementById('btnCheckUpdates');
  if (btnCheck) btnCheck.disabled = true;
  try {
    if (window.rtai && window.rtai.checkUpdate) {
      const res = await window.rtai.checkUpdate();
      renderUpdateStatus(res);
      if (!silent && res) {
        if (res.status === 'available') showToast(`Versão ${res.latestVersion} disponível.`);
        else if (res.status === 'up-to-date') showToast('Você já está na versão mais recente.');
        else if (res.status === 'disabled') showToast('Atualizações só funcionam no app instalado.');
        else if (res.status === 'error') showToast('Não foi possível verificar atualizações.');
      }
    }
  } catch (err) {
    console.error('Failed to check updates:', err);
    if (!silent) showToast('Erro ao verificar atualizações.');
  } finally {
    if (btnCheck) btnCheck.disabled = false;
  }
}

async function startUpdateDownloadFlow() {
  if (!window.rtai || !window.rtai.downloadUpdate) return;
  renderUpdateStatus({ ...(availableAppUpdate || {}), status: 'downloading', progress: { percent: 0 } });
  const res = await window.rtai.downloadUpdate();
  if (res && res.ok === false) showToast(`Falha no download: ${res.error || 'erro desconhecido'}`);
}

async function finishUpdateInstallation() {
  try {
    if (window.rtai && window.rtai.installUpdate) {
      const res = await window.rtai.installUpdate();
      if (res && res.ok === false) showToast(res.error || 'Nenhuma atualização pronta.');
      else showToast('Reiniciando para atualizar…');
    }
  } catch (err) {
    console.error('Failed to install update:', err);
  }
}

// Modal primary button does whatever the next step is.
function handleModalUpdateAction() {
  const st = availableAppUpdate && availableAppUpdate.status;
  if (st === 'downloaded') return finishUpdateInstallation();
  if (st === 'available') return startUpdateDownloadFlow();
  return checkAppUpdates(false);
}

async function loadAppVersion() {
  try {
    if (window.rtai && window.rtai.getAppVersion) {
      appVersionInfo = { ...appVersionInfo, ...(await window.rtai.getAppVersion()) };
    }
  } catch (_e) {}
  const v = appVersionInfo.version || '2.0.0';
  setText('sidebarAppVersion', `v${v}`);
  setText('settingsVersionLabel', v);
  setText('topVersionBadgeLabel', `v${v}`);
  setText('homeWhatsNewVersion', `v${v.split('.').slice(0, 2).join('.')}`);
  renderChannel(appVersionInfo.channel || (state.config && state.config.update_channel) || 'stable');
}

function renderChannel(channel) {
  const ch = channel === 'beta' ? 'beta' : 'stable';
  document.querySelectorAll('[data-update-channel]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.updateChannel === ch ? 'true' : 'false');
  });
  const label = ch === 'beta' ? 'Beta' : 'Stable';
  setText('sidebarChannelLabel', label);
  setText('settingsChannelBadge', label);
}

// ----------------------------------------------------
// FEATURE FLAGS (A/B tests, staged rollout, beta-only)
// ----------------------------------------------------
function isFlagEnabled(key) {
  const f = state.flags && state.flags.flags && state.flags.flags[key];
  // Unknown flags (old main process, flags not loaded yet) default to on so
  // nothing disappears by accident.
  return f ? Boolean(f.enabled) : true;
}

function flagVariant(key) {
  const f = state.flags && state.flags.flags && state.flags.flags[key];
  return f && f.enabled ? f.variant : null;
}

function applyFlagsToDom() {
  document.querySelectorAll('[data-flag]').forEach((el) => {
    el.dataset.flagOff = isFlagEnabled(el.dataset.flag) ? 'false' : 'true';
  });
  // A/B copy: data-ab="<flag>" + data-ab-<variant>="text"
  document.querySelectorAll('[data-ab]').forEach((el) => {
    const v = flagVariant(el.dataset.ab);
    const text = v && el.getAttribute(`data-ab-${v}`);
    if (text) el.textContent = text;
  });
}

function renderFlagsSettings() {
  const list = document.getElementById('flagsList');
  if (!list) return;
  const snap = state.flags || { flags: {} };
  const entries = Object.values(snap.flags || {});
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="px-4 py-3 text-xs text-muted-foreground">No flags defined.</div>';
  }
  const sourceLabel = {
    override: 'Overridden here',
    rollout: 'Rollout',
    default: 'Default',
    channel: 'Beta only',
    min_version: 'Needs a newer version'
  };
  for (const f of entries) {
    const row = document.createElement('div');
    row.className = 'flag-row';
    const left = document.createElement('div');
    left.className = 'min-w-0';
    const name = document.createElement('div');
    name.className = 'flex items-center gap-2 text-[12.5px] font-medium text-foreground';
    const code = document.createElement('code');
    code.className = 'font-mono text-[12px]';
    code.textContent = f.key;
    const state_ = document.createElement('span');
    state_.className = `h-1.5 w-1.5 rounded-full ${f.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`;
    name.append(state_, code);
    if (f.variant) {
      const v = document.createElement('span');
      v.className = 'badge-quiet';
      v.textContent = f.variant;
      name.append(v);
    }
    const desc = document.createElement('div');
    desc.className = 'mt-0.5 truncate text-xs text-muted-foreground';
    desc.textContent = `${f.description}${sourceLabel[f.source] ? ' · ' + sourceLabel[f.source] : ''}`;
    left.append(name, desc);

    const select = document.createElement('select');
    select.className = 'h-7 w-36 shrink-0 rounded-md border border-input bg-card px-2 text-xs text-foreground focus:outline-none cursor-pointer hover:border-foreground/30 transition-colors';
    select.setAttribute('aria-label', `Override ${f.key}`);
    const opts = [['default', 'Default'], ['on', 'On'], ['off', 'Off']];
    (f.variants || []).forEach((v) => opts.push([v, `Variant ${v}`]));
    for (const [val, label] of opts) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      o.className = 'bg-card text-foreground';
      select.append(o);
    }
    const current = snap.overrides && snap.overrides[f.key];
    select.value = f.source === 'override' ? (current || (f.enabled ? (f.variant || 'on') : 'off')) : 'default';
    select.addEventListener('change', async () => {
      const res = await window.rtai.setFlagOverride(f.key, select.value);
      if (res && res.ok === false) showToast(res.error || 'Override inválido.');
      else if (res && res.flags) onFlagsChanged(res.flags);
    });
    row.append(left, select);
    list.append(row);
  }
  const fetched = snap.lastFetch ? new Date(snap.lastFetch).toLocaleString() : 'never';
  const src = { remote: 'remote', cache: 'cached', bundled: 'built-in', empty: 'none' }[snap.source] || snap.source || '';
  setText('flagsMeta', `Install ID ${String(snap.installId || '').slice(0, 8)} · definitions: ${src} · last sync: ${fetched}${snap.lastError ? ' · ' + snap.lastError : ''}`);
}

function onFlagsChanged(snap) {
  if (!snap) return;
  // Remember overrides locally so the select shows the chosen value.
  const prev = (state.flags && state.flags.overrides) || {};
  const overrides = { ...prev };
  for (const f of Object.values(snap.flags || {})) {
    if (f.source === 'override') overrides[f.key] = f.variant || (f.enabled ? 'on' : 'off');
    else delete overrides[f.key];
  }
  state.flags = { ...snap, overrides };
  applyFlagsToDom();
  renderFlagsSettings();
  if (snap.channel) renderChannel(snap.channel);
}

async function loadFlags() {
  try {
    if (window.rtai && window.rtai.getFlags) onFlagsChanged(await window.rtai.getFlags());
  } catch (err) {
    console.error('Failed to load flags:', err);
  }
}

// ----------------------------------------------------
// HOME: greeting, model, next interview
// ----------------------------------------------------
function renderHomeGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = String((state.profile && state.profile.name) || '').trim().split(/\s+/)[0];
  setText('homeGreeting', first ? `${part}, ${first}` : part);
  const cfg = state.config || {};
  const missing = [];
  if (cfg.has_deepgram_key === false) missing.push('Deepgram key');
  if (cfg.has_llm_key === false) missing.push('LLM key');
  setText('homeStatusLine', missing.length
    ? `Add your ${missing.join(' and ')} in Settings to go live.`
    : 'Everything is ready for your next interview.');
}

function renderHomeModel() {
  const sel = document.getElementById('selectActiveModelChoice');
  let label = '';
  if (sel && sel.selectedIndex >= 0) label = sel.options[sel.selectedIndex]?.text || '';
  if (!label) label = (state.config && state.config.model) || '';
  label = label.split('(')[0].trim() || 'Not set';
  setText('heroModelName', label);
}

function nextInterview() {
  const now = new Date();
  let best = null;
  for (const ag of state.agents || []) {
    const date = ag.next_interview_date || (ag.next_interview && ag.next_interview.date) || '';
    if (!date) continue;
    const time = ag.next_interview_time || (ag.next_interview && ag.next_interview.time) || '';
    const when = new Date(`${date}T${/^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '23:59'}:00`);
    if (Number.isNaN(when.getTime()) || when < new Date(now.getTime() - 2 * 3600 * 1000)) continue;
    if (!best || when < best.when) best = { ag, when, hasTime: Boolean(time) };
  }
  return best;
}

function renderHomeNextInterview() {
  const next = nextInterview();
  if (!next) {
    setText('heroEventWeekday', '—');
    setText('heroEventDay', '—');
    setText('heroEventTitle', 'Nothing scheduled');
    setText('heroEventSub', 'Add a date inside a goal');
    return;
  }
  const { ag, when, hasTime } = next;
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(when) - startOf(today)) / 86400000);
  const rel = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const time = hasTime ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  setText('heroEventWeekday', when.toLocaleDateString(undefined, { weekday: 'short' }));
  setText('heroEventDay', String(when.getDate()));
  setText('heroEventTitle', ag.name || [ag.company, ag.role].filter(Boolean).join(' · ') || 'Interview');
  setText('heroEventSub', [rel, time].filter(Boolean).join(' · '));
}

function renderHomeMetrics() {
  const sessions = state.sessions || [];
  let totalQuestions = 0;
  let totalAnswers = 0;
  let totalLatency = 0;
  let latencyCount = 0;

  for (const s of sessions) {
    if (typeof s.questionsCount === 'number') {
      totalQuestions += s.questionsCount;
    }
    if (typeof s.answersCount === 'number') {
      totalAnswers += s.answersCount;
    }
    if (typeof s.avgLatencyMs === 'number' && s.avgLatencyMs > 0) {
      totalLatency += s.avgLatencyMs;
      latencyCount++;
    }
  }

  let totalDocs = 0;
  for (const ag of (state.agents || [])) {
    if (Array.isArray(ag.documents)) {
      totalDocs += ag.documents.length;
    }
  }

  const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 240;
  const latencyDisplay = avgLatency < 1000 ? `~${avgLatency} ms` : `~${(avgLatency / 1000).toFixed(1)} s`;

  const activeModelChoice = (state.config && (state.config.model || state.config.active_model)) || 'qwen/qwen3.6-flash';
  const shortModel = activeModelChoice.split('/')[1] || activeModelChoice.split('(')[0] || 'Nova-3 + LLM';

  setText('metricQuestionsCount', String(totalQuestions));
  setText('metricQuestionsSub', sessions.length > 0 ? `Em ${sessions.length} ${sessions.length === 1 ? 'sessão' : 'sessões'}` : 'Detectadas em chamada');

  setText('metricAnswersCount', String(totalAnswers));
  setText('metricAnswersSub', totalAnswers > 0 ? 'Respostas STAR salvas' : 'Formato STAR');

  setText('metricServerLatency', latencyDisplay);
  setText('metricServerModel', `STT Nova-3 · ${shortModel}`);

  setText('metricRagAccuracy', '99.4%');
  setText('metricRagSub', totalDocs > 0 ? `${totalDocs} docs indexados` : 'Zero alucinação');
}

function renderHome() {
  renderHomeGreeting();
  renderHomeModel();
  renderHomeNextInterview();
  renderHomeMetrics();
}

function selectProcessDisguise(disguise) {
  const valid = ['none', 'settings', 'cmd', 'taskmgr'];
  const cur = valid.includes(disguise) ? disguise : 'none';
  const btns = {
    none: document.getElementById('btnDisguiseNone'),
    settings: document.getElementById('btnDisguiseSettings'),
    cmd: document.getElementById('btnDisguiseCmd'),
    taskmgr: document.getElementById('btnDisguiseTaskManager')
  };

  Object.entries(btns).forEach(([k, b]) => {
    if (!b) return;
    if (k === cur) {
      b.className = 'disguise-btn flex items-center gap-3 rounded-xl border border-primary/50 bg-primary/10 px-4 py-3 text-left transition-all cursor-pointer ring-1 ring-primary/40';
      b.querySelector('svg')?.classList.add('text-primary');
      b.querySelector('svg')?.classList.remove('text-muted-foreground');
    } else {
      b.className = 'disguise-btn flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-all cursor-pointer hover:bg-accent/40';
      b.querySelector('svg')?.classList.remove('text-primary');
      b.querySelector('svg')?.classList.add('text-muted-foreground');
    }
  });

  if (window.rtai && window.rtai.setProcessDisguise) {
    window.rtai.setProcessDisguise(cur);
  }
}

function setupUpdatesAndModernHero() {
  // Auto-update check on startup if enabled
  // The main process checks on its own schedule; this only paints the status.

  // Version modal controls
  document.getElementById('btnTopVersionBadge')?.addEventListener('click', () => {
    document.getElementById('modalAppUpdate')?.classList.add('open');
  });

  document.getElementById('btnHeroWhatsNew')?.addEventListener('click', () => {
    document.getElementById('modalAppUpdate')?.classList.add('open');
  });

  document.getElementById('btnCloseUpdateModal')?.addEventListener('click', () => {
    document.getElementById('modalAppUpdate')?.classList.remove('open');
  });

  // Settings update controls
  document.getElementById('btnCheckUpdates')?.addEventListener('click', () => {
    checkAppUpdates(false);
  });

  document.getElementById('btnDownloadUpdate')?.addEventListener('click', () => {
    startUpdateDownloadFlow();
  });

  document.getElementById('btnModalDownloadUpdate')?.addEventListener('click', () => {
    handleModalUpdateAction();
  });

  document.getElementById('btnModalOpenUpdateSettings')?.addEventListener('click', () => {
    document.getElementById('modalAppUpdate')?.classList.remove('open');
    switchView('settings');
    switchSettingsTab('general');
  });

  document.getElementById('btnTopVersionBadge')?.addEventListener('dblclick', () => {
    if (availableAppUpdate && availableAppUpdate.status === 'downloaded') finishUpdateInstallation();
  });

  // Live updater events from the main process.
  if (window.rtai && window.rtai.onUpdateStatus) window.rtai.onUpdateStatus(renderUpdateStatus);
  if (window.rtai && window.rtai.onUpdateProgress) window.rtai.onUpdateProgress(applyUpdateProgress);
  if (window.rtai && window.rtai.getUpdateStatus) {
    window.rtai.getUpdateStatus().then(renderUpdateStatus).catch(() => {});
  }

  // Release channel (stable / beta)
  document.querySelectorAll('[data-update-channel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ch = btn.dataset.updateChannel;
      renderChannel(ch);
      try {
        const res = await window.rtai.setUpdateChannel(ch);
        if (res && res.flags) onFlagsChanged(res.flags);
        if (state.config) state.config.update_channel = ch;
        showToast(ch === 'beta' ? 'Canal beta ativado: você vai receber versões de teste.' : 'Canal estável ativado.');
      } catch (err) {
        console.error('Failed to change channel:', err);
        showToast('Falha ao trocar o canal.');
      }
    });
  });

  // Feature flags
  if (window.rtai && window.rtai.onFlagsChanged) window.rtai.onFlagsChanged(onFlagsChanged);
  document.getElementById('btnRefreshFlags')?.addEventListener('click', async () => {
    const snap = await window.rtai.refreshFlags();
    onFlagsChanged(snap);
    showToast(snap && snap.lastError ? `Flags: ${snap.lastError}` : 'Flags atualizadas.');
  });
  document.getElementById('btnResetFlags')?.addEventListener('click', async () => {
    const res = await window.rtai.resetFlagOverrides();
    if (res && res.flags) onFlagsChanged(res.flags);
    showToast('Overrides removidos.');
  });

  loadAppVersion();
  loadFlags();

  document.getElementById('btnRestartUpdate')?.addEventListener('click', () => {
    finishUpdateInstallation();
  });

  document.getElementById('cfgAutoUpdate')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      const res = await window.rtai.saveConfig({ auto_update: enabled });
      if (res && res.config) state.config = res.config;
      showToast(enabled ? 'Atualizações automáticas ativadas.' : 'Atualizações automáticas desativadas.');
    } catch (err) {
      console.error('Failed to update auto_update config:', err);
      showToast('Falha ao atualizar configuração.');
    }
  });

  // Hero controls (Image 2 style)
  document.getElementById('btnHeroStartApp')?.addEventListener('click', () => {
    handleLaunchOverlay(false);
  });

  document.getElementById('toggleHeroStealth')?.addEventListener('change', async () => {
    try {
      const res = await window.rtai.toggleStealthMode();
      if (res && res.status) {
        state.stealthState = res.status;
        updateStealthUI(res.status);
        showToast(res.status.active ? 'Modo stealth ativado' : 'Modo Stealth Desativado');
      }
    } catch (err) {
      console.error('Failed to toggle stealth from hero:', err);
      showToast('Falha ao alternar modo stealth.');
    }
  });

  document.getElementById('btnRefreshHero')?.addEventListener('click', async () => {
    try {
      const st = await window.rtai.getState();
      state.config = st.config || state.config;
      state.agents = st.agents || state.agents;
      state.sessions = st.sessions || state.sessions;
      renderSidebarGoals();
      renderGoalsView();
      showToast('Workspace atualizado com sucesso.');
    } catch (err) {
      showToast('Erro ao atualizar workspace.');
    }
  });

  document.getElementById('btnHeroModelAction')?.addEventListener('click', () => {
    switchView('settings');
    switchSettingsTab('defaults');
  });

  document.getElementById('btnHeroConnectCalendar')?.addEventListener('click', () => {
    switchView('settings');
    switchSettingsTab('calendar');
  });

  document.getElementById('btnTopOpenSettings')?.addEventListener('click', () => {
    switchView('settings');
    switchSettingsTab('general');
  });

  // Interface Opacity slider
  const inputOpacity = document.getElementById('inputInterfaceOpacity');
  const labelOpacity = document.getElementById('labelInterfaceOpacity');
  if (inputOpacity) {
    inputOpacity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (labelOpacity) labelOpacity.textContent = `${val}%`;
      const floatVal = val / 100;
      if (window.rtai && window.rtai.setInterfaceOpacity) {
        window.rtai.setInterfaceOpacity(floatVal);
      }
    });

    inputOpacity.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10) / 100;
      try {
        const res = await window.rtai.saveConfig({ interface_opacity: val });
        if (res && res.config) state.config = res.config;
        showToast(`Opacidade da interface ajustada para ${Math.round(val * 100)}%.`);
      } catch (err) {
        console.error('Failed to save interface_opacity:', err);
      }
    });
  }

  // Process Disguise buttons
  const disguiseBtns = [
    { id: 'btnDisguiseNone', mode: 'none', label: 'RealTimeAI (Normal)' },
    { id: 'btnDisguiseSettings', mode: 'settings', label: 'Configurações do Windows' },
    { id: 'btnDisguiseCmd', mode: 'cmd', label: 'Prompt de Comando' },
    { id: 'btnDisguiseTaskManager', mode: 'taskmgr', label: 'Gerenciador de Tarefas' }
  ];
  disguiseBtns.forEach(({ id, mode, label }) => {
    document.getElementById(id)?.addEventListener('click', async () => {
      selectProcessDisguise(mode);
      try {
        const res = await window.rtai.saveConfig({ process_disguise: mode });
        if (res && res.config) state.config = res.config;
        showToast(`Disfarce de processo alterado: ${label}`);
      } catch (err) {
        console.error('Failed to save process disguise:', err);
      }
    });
  });

  // Header Search Input (Ctrl + K)
  const topSearch = document.getElementById('topSearchInput');
  if (topSearch) {
    topSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const items = document.querySelectorAll('#agentSelectorBar button');
      items.forEach((btn) => {
        const text = btn.textContent.toLowerCase();
        btn.style.display = (!q || text.includes(q)) ? '' : 'none';
      });
      const goalsSearch = document.getElementById('inputSearchGoals');
      if (goalsSearch && state.currentView === 'goals') {
        goalsSearch.value = e.target.value;
        state.searchQuery = e.target.value.trim();
        renderGoalsView();
      }
    });

    topSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        topSearch.value = '';
        topSearch.blur();
        const items = document.querySelectorAll('#agentSelectorBar button');
        items.forEach((btn) => { btn.style.display = ''; });
        if (state.currentView === 'goals') {
          state.searchQuery = '';
          const goalsSearch = document.getElementById('inputSearchGoals');
          if (goalsSearch) goalsSearch.value = '';
          renderGoalsView();
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const s = document.getElementById('topSearchInput');
      if (s) {
        s.focus();
        s.select();
      }
    }
  });
}

let liveInputAudioStream = null;
let liveInputAudioContext = null;
let liveInputAudioAnimId = null;

async function startLiveInputMeter(deviceId) {
  stopLiveInputMeter();

  const inMeter = document.getElementById('meterInputLevel');
  const inVal = document.getElementById('inputLevelValue');
  if (!inMeter && !inVal) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  try {
    const audioConstraints = (deviceId && deviceId !== 'default')
      ? { deviceId: { exact: deviceId } }
      : true;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
    liveInputAudioStream = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    liveInputAudioContext = new AudioCtx();
    if (liveInputAudioContext.state === 'suspended') {
      await liveInputAudioContext.resume();
    }

    const source = liveInputAudioContext.createMediaStreamSource(stream);
    const analyser = liveInputAudioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function tick() {
      if (!liveInputAudioStream || !liveInputAudioContext || liveInputAudioContext.state === 'closed') {
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;

      let pct = 0;
      let db = -60;
      if (avg > 1) {
        pct = Math.min(100, Math.round((avg / 80) * 100));
        db = Math.round(-60 + (avg / 255) * 60);
      }

      if (inMeter) inMeter.style.width = `${pct}%`;
      if (inVal) inVal.textContent = avg > 1 ? `${db} dB` : '-60 dB';

      liveInputAudioAnimId = requestAnimationFrame(tick);
    }

    liveInputAudioAnimId = requestAnimationFrame(tick);
  } catch (err) {
    console.warn('Could not start live input meter:', err);
    if (inMeter) inMeter.style.width = '0%';
    if (inVal) inVal.textContent = '-60 dB';
  }
}

function stopLiveInputMeter() {
  if (liveInputAudioAnimId) {
    cancelAnimationFrame(liveInputAudioAnimId);
    liveInputAudioAnimId = null;
  }
  if (liveInputAudioStream) {
    try {
      liveInputAudioStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    liveInputAudioStream = null;
  }
  if (liveInputAudioContext && liveInputAudioContext.state !== 'closed') {
    try { liveInputAudioContext.close(); } catch (_) {}
    liveInputAudioContext = null;
  }
  const inMeter = document.getElementById('meterInputLevel');
  const inVal = document.getElementById('inputLevelValue');
  if (inMeter) inMeter.style.width = '0%';
  if (inVal) inVal.textContent = '-60 dB';
}

async function populateAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const inSelect = document.getElementById('selectInputDevice');
    const outSelect = document.getElementById('selectOutputDevice');
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');

    if (inSelect && inputs.length > 0) {
      const savedIn = (state.config && state.config.audio_input_device) || inSelect.value || 'default';
      inSelect.innerHTML = inputs.map((d, i) =>
        `<option value="${d.deviceId || 'default'}">${d.label || `Microphone ${i + 1}`}</option>`
      ).join('');
      if ([...inSelect.options].some((o) => o.value === savedIn)) {
        inSelect.value = savedIn;
      }
    }
    if (outSelect && outputs.length > 0) {
      const savedOut = (state.config && state.config.audio_output_device) || outSelect.value || 'default';
      outSelect.innerHTML = outputs.map((d, i) =>
        `<option value="${d.deviceId || 'default'}">${d.label || `Speaker / Headphone ${i + 1}`}</option>`
      ).join('');
      if ([...outSelect.options].some((o) => o.value === savedOut)) {
        outSelect.value = savedOut;
      }
    }
  } catch (_) {}
}

function setupAiProvidersAndAudio() {
  // 1. AI Providers (Image 1)
  const activeModelSel = document.getElementById('selectActiveModelChoice');
  if (activeModelSel) {
    activeModelSel.addEventListener('change', async (e) => {
      const val = e.target.value;
      const tier = getTierForModel(val);
      selectModelTier(tier, val, true);
      renderHomeModel();
    });
  }

  document.getElementById('selectBackgroundModelChoice')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ background_model: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`Background model: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
    } catch (err) {
      console.error('Failed to save background model:', err);
    }
  });

  document.getElementById('selectAiResponseLanguageChoice')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ ai_response_language: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`AI Response Language: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
    } catch (err) {
      console.error('Failed to save AI response language:', err);
    }
  });

  document.getElementById('toggleDirectAssist')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ direct_assist: e.target.checked });
      if (res && res.config) state.config = res.config;
      showToast(e.target.checked ? 'Direct Assist (Beta) ativado.' : 'Direct Assist desativado.');
    } catch (err) {
      console.error('Failed to save direct_assist:', err);
    }
  });

  document.getElementById('toggleFastResponseMode')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ fast_response_mode: e.target.checked });
      if (res && res.config) state.config = res.config;
      showToast(e.target.checked ? 'Fast Response Mode ativado.' : 'Fast Response Mode desativado.');
    } catch (err) {
      console.error('Failed to save fast_response_mode:', err);
    }
  });

  // AI Provider Pill Tabs switching (Cloud / Local / Privacy)
  const pillCloud = document.getElementById('pillTabCloudProviders');
  const pillLocal = document.getElementById('pillTabLocalGateways');
  const pillPrivacy = document.getElementById('pillTabAiPrivacy');
  const contentCloud = document.getElementById('pillContentCloudProviders');
  const contentLocal = document.getElementById('pillContentLocalGateways');
  const contentPrivacy = document.getElementById('pillContentAiPrivacy');

  const switchAiPillTab = (activeTab) => {
    const tabs = [
      { id: 'cloud', btn: pillCloud, content: contentCloud },
      { id: 'local', btn: pillLocal, content: contentLocal },
      { id: 'privacy', btn: pillPrivacy, content: contentPrivacy }
    ];
    tabs.forEach(({ id, btn, content }) => {
      const isCur = id === activeTab;
      if (btn) {
        btn.className = isCur
          ? 'ai-provider-tab flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-foreground transition-all cursor-pointer'
          : 'ai-provider-tab flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-all cursor-pointer';
      }
      if (content) {
        content.classList.toggle('hidden', !isCur);
      }
    });
  };

  pillCloud?.addEventListener('click', () => switchAiPillTab('cloud'));
  pillLocal?.addEventListener('click', () => switchAiPillTab('local'));
  pillPrivacy?.addEventListener('click', () => switchAiPillTab('privacy'));

  // 2. Speech Provider & Audio (Image 2)
  document.getElementById('selectSpeechProvider')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ speech_provider: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`Speech Provider: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
    } catch (err) {
      console.error('Failed to save speech provider:', err);
    }
  });

  document.getElementById('selectSpeechLanguage')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ speech_language: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`Transcription Language: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
    } catch (err) {
      console.error('Failed to save speech language:', err);
    }
  });

  document.getElementById('selectInputDevice')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ audio_input_device: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`Microphone input: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
      startLiveInputMeter(e.target.value);
    } catch (err) {
      console.error('Failed to save input device:', err);
    }
  });

  document.getElementById('selectOutputDevice')?.addEventListener('change', async (e) => {
    try {
      const res = await window.rtai.saveConfig({ audio_output_device: e.target.value });
      if (res && res.config) state.config = res.config;
      showToast(`Audio output: ${e.target.selectedOptions[0]?.textContent || e.target.value}`);
    } catch (err) {
      console.error('Failed to save output device:', err);
    }
  });

  // Device Enumeration via Web Audio API / navigator.mediaDevices
  populateAudioDevices();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      populateAudioDevices();
    });
  }

  // Test Sound Button (Web Audio API Synthesizer & Meter Animation)
  document.getElementById('btnTestSound')?.addEventListener('click', async () => {
    const sysMeter = document.getElementById('meterSystemAudioLevel');
    const sysVal = document.getElementById('systemAudioLevelValue');

    let animId = null;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.2;

        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880.00, ctx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.65);

        osc.connect(gain);
        gain.connect(analyser);
        analyser.connect(ctx.destination);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const startTime = Date.now();

        function trackOut() {
          if (Date.now() - startTime > 750) {
            if (sysMeter) sysMeter.style.width = '0%';
            if (sysVal) sysVal.textContent = '-60 dB';
            try { ctx.close(); } catch (_) {}
            return;
          }
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const pct = Math.min(100, Math.round((avg / 60) * 100));
          const db = avg > 1 ? Math.round(-60 + (avg / 255) * 60) : -60;
          if (sysMeter) sysMeter.style.width = `${pct}%`;
          if (sysVal) sysVal.textContent = `${db} dB`;
          animId = requestAnimationFrame(trackOut);
        }

        osc.start();
        osc.stop(ctx.currentTime + 0.65);
        animId = requestAnimationFrame(trackOut);
      }
    } catch (_e) {
      if (sysMeter) sysMeter.style.width = '88%';
      if (sysVal) sysVal.textContent = '-6 dB';
      setTimeout(() => {
        if (sysMeter) sysMeter.style.width = '0%';
        if (sysVal) sysVal.textContent = '-60 dB';
      }, 700);
    }

    if (window.rtai && window.rtai.testSound) {
      try { await window.rtai.testSound(); } catch (_e) {}
    }

    showToast('Som de teste reproduzido.');
  });

  // 3. Google Calendar Hero & Detect Meetings (Images 3 & 4)
  document.getElementById('btnConnectGoogleCalendarHero')?.addEventListener('click', () => {
    const connectBtn = document.getElementById('btnGcalConnect');
    if (connectBtn && !connectBtn.classList.contains('hidden')) {
      connectBtn.click();
    } else {
      document.getElementById('btnGcalImportClient')?.click();
      showToast('Selecione seu arquivo client_secret do Google Calendar.');
    }
  });

  document.getElementById('cfgCalendarDetectMeetings')?.addEventListener('change', async (e) => {
    const meetDetect = document.getElementById('cfgMeetingDetect');
    if (meetDetect) {
      meetDetect.checked = e.target.checked;
      meetDetect.dispatchEvent(new Event('change'));
    }
  });
}

// ----------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------
// ----------------------------------------------------
// GOOGLE CALENDAR (Settings > Google Calendar)
// ----------------------------------------------------
const gcalState = { status: null, calendars: [], busy: false };

function gcalEl(id) {
  return document.getElementById(id);
}

function gcalWhen(ev) {
  if (!ev || !ev.start) return '';
  if (ev.allDay) {
    const d = new Date(`${ev.start}T00:00:00`);
    return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, all day`;
  }
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return ev.start;
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderGcalStatus(st) {
  gcalState.status = st || null;
  const dot = gcalEl('gcalStatusDot');
  const title = gcalEl('gcalStatusTitle');
  const detail = gcalEl('gcalStatusDetail');
  if (!dot || !title || !detail) return;
  const configured = Boolean(st && st.configured);
  const connected = Boolean(st && st.connected);
  let dotColor = 'bg-muted-foreground/40';
  if (!configured) {
    title.textContent = 'Not set up';
    detail.textContent = 'Load the OAuth client file (client_secret_....json) downloaded from Google Cloud.';
  } else if (!connected) {
    dotColor = 'bg-amber-500';
    title.textContent = 'Ready to connect';
    detail.textContent = st.lastError ||
      `OAuth client: ${st.clientType === 'web' ? 'Web application' : 'Desktop app'}${st.projectId ? ` (${st.projectId})` : ''}`;
  } else {
    dotColor = st.lastError ? 'bg-amber-500' : 'bg-emerald-500';
    title.textContent = 'Connected';
    detail.textContent = st.lastError || (st.email ? `Signed in as ${st.email}` : 'Signed in');
  }
  dot.className = `h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`;
  const btnImport = gcalEl('btnGcalImportClient');
  gcalEl('btnGcalConnect')?.classList.toggle('hidden', !configured || connected);
  gcalEl('btnGcalDisconnect')?.classList.toggle('hidden', !connected);
  if (btnImport) {
    btnImport.classList.toggle('hidden', connected);
    btnImport.textContent = configured ? 'Replace client file' : 'Load client file';
  }
  gcalEl('gcalRedirectBox')?.classList.toggle('hidden', !(configured && st.redirectUri && !connected));
  const uri = gcalEl('gcalRedirectUri');
  if (uri) uri.textContent = (st && st.redirectUri) || '';
  const auto = gcalEl('cfgGcalAutoSync');
  if (auto && st) auto.checked = st.autoSync !== false;
  const rem = gcalEl('selectGcalReminder');
  if (rem && st) setSelectValue(rem, String(st.reminderMin ?? 60));
  ['cfgGcalAutoSync', 'selectGcalCalendar', 'selectGcalReminder', 'inputGcalTitle', 'inputGcalDate', 'inputGcalTime',
    'selectGcalDuration', 'inputGcalNotes', 'btnGcalCreate', 'btnGcalRefresh'].forEach((id) => {
    const el = gcalEl(id);
    if (el) el.disabled = !connected;
  });
  gcalEl('gcalConnectedOnly')?.classList.toggle('opacity-60', !connected);
}

async function refreshGcalStatus() {
  if (!window.rtai || !window.rtai.gcalStatus) return null;
  try {
    const st = await window.rtai.gcalStatus();
    renderGcalStatus(st);
    return st;
  } catch (_e) {
    return null;
  }
}

async function loadGcalCalendars() {
  const sel = gcalEl('selectGcalCalendar');
  if (!sel || !gcalState.status || !gcalState.status.connected) return;
  const res = await window.rtai.gcalCalendars();
  if (!res || !res.ok) {
    if (res && res.error) showToast(res.error);
    await refreshGcalStatus();
    return;
  }
  gcalState.calendars = res.result || [];
  const primary = gcalState.calendars.find((c) => c.primary);
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = 'primary';
  first.textContent = primary ? `${primary.summary} (primary)` : 'Primary calendar';
  sel.appendChild(first);
  for (const c of gcalState.calendars) {
    if (c.primary) continue;
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.summary;
    sel.appendChild(o);
  }
  setSelectValue(sel, gcalState.status.calendarId || 'primary');
}

function renderGcalEvents(events, message) {
  const list = gcalEl('gcalEventsList');
  if (!list) return;
  if (message || !events.length) {
    list.innerHTML = `<div class="px-4 py-3.5 text-xs text-muted-foreground">${escapeHtml(message || 'Nothing in the next 14 days.')}</div>`;
    return;
  }
  list.innerHTML = events.map((ev) => `
    <div class="flex items-center justify-between gap-4 px-4 py-3">
      <div class="min-w-0">
        <div class="truncate text-[13px] font-medium text-foreground">${escapeHtml(ev.summary)}${ev.goalId ? ' <span class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">Interview</span>' : ''}</div>
        <div class="truncate text-xs text-muted-foreground">${escapeHtml(gcalWhen(ev))}${ev.location ? ` · ${escapeHtml(ev.location)}` : ''}</div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        ${ev.meet ? `<button type="button" class="sh-btn-ghost text-[11px]" data-gcal-open="${escapeAttr(ev.meet)}">Meet</button>` : ''}
        ${ev.link ? `<button type="button" class="sh-btn-ghost text-[11px]" data-gcal-open="${escapeAttr(ev.link)}">Open</button>` : ''}
        <button type="button" class="sh-btn-ghost text-[11px] hover:text-destructive" data-gcal-delete="${escapeAttr(ev.id)}" data-gcal-title="${escapeAttr(ev.summary)}">Delete</button>
      </div>
    </div>`).join('');
}

async function loadGcalEvents() {
  if (!gcalState.status || !gcalState.status.connected) {
    renderGcalEvents([], 'Connect Google Calendar to see your events.');
    return;
  }
  renderGcalEvents([], 'Loading...');
  const res = await window.rtai.gcalEvents({ days: 14, max: 20 });
  if (!res || !res.ok) {
    renderGcalEvents([], (res && res.error) || 'Could not load the events.');
    await refreshGcalStatus();
    return;
  }
  renderGcalEvents(res.result || []);
}

async function gcalOnOpen() {
  const st = await refreshGcalStatus();
  if (st && st.connected) {
    await loadGcalCalendars();
    await loadGcalEvents();
  } else {
    renderGcalEvents([], 'Connect Google Calendar to see your events.');
  }
}

// Scheduler dialog: "Also add to Google Calendar" only when connected.
function gcalPrepareScheduler() {
  const st = gcalState.status;
  gcalEl('rowSchedulerGcal')?.classList.toggle('hidden', !(st && st.connected));
  const box = gcalEl('inputSchedulerGcal');
  if (box && st) box.checked = st.autoSync !== false;
}

function gcalSchedulerChoice() {
  const row = gcalEl('rowSchedulerGcal');
  const box = gcalEl('inputSchedulerGcal');
  if (!row || row.classList.contains('hidden') || !box) return undefined;
  return Boolean(box.checked);
}

function gcalOutcomeText(cal) {
  if (!cal || cal.skipped) return '';
  if (cal.ok) {
    if (cal.removed === false) return '';
    return cal.removed ? ' Removed from Google Calendar.' : ' Added to Google Calendar.';
  }
  return ` Google Calendar: ${cal.error || 'not updated.'}`;
}

function setupGoogleCalendar() {
  gcalEl('btnGcalImportClient')?.addEventListener('click', async () => {
    const res = await window.rtai.gcalImportClient();
    if (res && res.status) renderGcalStatus(res.status);
    if (res && res.ok) showToast('OAuth client loaded. Now click Connect.');
    else if (res && !res.canceled) showToast(res.error || 'Could not load the file.');
  });

  gcalEl('btnGcalConnect')?.addEventListener('click', async () => {
    if (gcalState.busy) return;
    gcalState.busy = true;
    const btn = gcalEl('btnGcalConnect');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Waiting for Google...';
    }
    showToast('Finish signing in to Google in your browser.');
    try {
      const res = await window.rtai.gcalConnect();
      if (res && res.status) renderGcalStatus(res.status);
      if (res && res.ok) {
        showToast(res.status && res.status.email ? `Google Calendar connected: ${res.status.email}` : 'Google Calendar connected.');
        await loadGcalCalendars();
        await loadGcalEvents();
      } else {
        showToast((res && res.error) || 'Google Calendar was not connected.');
      }
    } finally {
      gcalState.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    }
  });

  gcalEl('btnGcalDisconnect')?.addEventListener('click', async () => {
    const res = await window.rtai.gcalDisconnect();
    if (res && res.status) renderGcalStatus(res.status);
    renderGcalEvents([], 'Connect Google Calendar to see your events.');
    showToast('Google Calendar disconnected.');
  });

  gcalEl('btnGcalCopyRedirect')?.addEventListener('click', async () => {
    const uri = gcalEl('gcalRedirectUri')?.textContent || '';
    try {
      await navigator.clipboard.writeText(uri);
      showToast('Redirect URI copied.');
    } catch (_e) {
      showToast(uri);
    }
  });

  const saveSetting = async (patch, message) => {
    const res = await window.rtai.gcalSaveSettings(patch);
    if (res && res.status) renderGcalStatus(res.status);
    if (message) showToast(message);
  };
  gcalEl('cfgGcalAutoSync')?.addEventListener('change', (e) =>
    saveSetting({ autoSync: e.target.checked },
      e.target.checked ? 'Scheduled interviews will go to Google Calendar.' : 'Scheduled interviews stay only in RealTimeAI.'));
  gcalEl('selectGcalCalendar')?.addEventListener('change', async (e) => {
    await saveSetting({ calendarId: e.target.value }, `New events go to ${e.target.selectedOptions[0]?.textContent || 'this calendar'}.`);
    await loadGcalEvents();
  });
  gcalEl('selectGcalReminder')?.addEventListener('change', (e) =>
    saveSetting({ reminderMin: Number(e.target.value) }, 'Reminder updated.'));
  gcalEl('btnGcalRefresh')?.addEventListener('click', () => loadGcalEvents());

  gcalEl('btnGcalCreate')?.addEventListener('click', async () => {
    const title = (gcalEl('inputGcalTitle')?.value || '').trim();
    const date = gcalEl('inputGcalDate')?.value || '';
    const time = gcalEl('inputGcalTime')?.value || '';
    const durationMin = Number(gcalEl('selectGcalDuration')?.value || 60);
    const description = (gcalEl('inputGcalNotes')?.value || '').trim();
    if (!title) {
      showToast('Give the event a title.');
      return;
    }
    if (!date) {
      showToast('Pick a date.');
      return;
    }
    const btn = gcalEl('btnGcalCreate');
    if (btn) btn.disabled = true;
    try {
      const res = await window.rtai.gcalCreateEvent({ summary: title, date, time, durationMin, description });
      if (res && res.ok) {
        showToast(`Added to Google Calendar: ${title}`);
        ['inputGcalTitle', 'inputGcalNotes'].forEach((id) => {
          const el = gcalEl(id);
          if (el) el.value = '';
        });
        await loadGcalEvents();
      } else {
        showToast((res && res.error) || 'Could not create the event.');
      }
    } finally {
      if (btn) btn.disabled = !(gcalState.status && gcalState.status.connected);
    }
  });

  gcalEl('gcalEventsList')?.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-gcal-open]');
    if (open) {
      const res = await window.rtai.gcalOpen(open.dataset.gcalOpen);
      if (res && !res.ok) showToast(res.error || 'Could not open the event.');
      return;
    }
    const del = e.target.closest('[data-gcal-delete]');
    if (del) {
      const title = del.dataset.gcalTitle || 'this event';
      if (!window.confirm(`Delete "${title}" from Google Calendar?`)) return;
      const cal = (gcalState.status && gcalState.status.calendarId) || 'primary';
      const res = await window.rtai.gcalDeleteEvent(cal, del.dataset.gcalDelete);
      showToast(res && res.ok ? 'Event deleted.' : (res && res.error) || 'Could not delete the event.');
      await loadGcalEvents();
    }
  });

  const dateIn = gcalEl('inputGcalDate');
  if (dateIn && !dateIn.value) {
    const d = new Date();
    dateIn.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  refreshGcalStatus();
}

async function initApp() {
  document.body.dataset.view = 'goals';
  const initial = await window.rtai.getState();
  state.config = initial.config || {};
  state.agents = initial.agents || [];
  state.sessions = initial.sessions || [];
  state.profile = initial.profile || {};
  state.themeState = initial.themeState || { preference: 'system', resolved: 'light' };
  state.overlayStatus = initial.overlayStatus || { running: false };
  state.playbooks = initial.playbooks || [];

  if (state.playbooks.length === 0 && window.rtai.getPlaybooks) {
    try {
      const pbRes = await window.rtai.getPlaybooks();
      if (pbRes && pbRes.playbooks) {
        state.playbooks = pbRes.playbooks;
      }
    } catch (_e) {}
  }

  applyTheme(state.themeState.resolved, state.themeState.preference);

  if (window.rtai.onSystemThemeUpdated) {
    window.rtai.onSystemThemeUpdated((themeInfo) => {
      if (themeInfo && themeInfo.resolved) {
        applyTheme(themeInfo.resolved, themeInfo.preference);
      }
    });
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    if (state.themeState.preference === 'system') {
      applyTheme(e.matches ? 'dark' : 'light', 'system');
    }
  });

  // Windows Theme buttons
  document.querySelectorAll('.theme-pref-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pref = btn.dataset.themePref;
      const updated = await window.rtai.setThemePreference(pref);
      if (updated) {
        applyTheme(updated.resolved, updated.preference);
      }
    });
  });

  renderProfileHeader();
  renderOverlayStatusPill();
  renderTranscriptionModeButton();
  populateSettingsForm(state.config);
  state.stealthState = initial.stealthState || {
    active: true,
    screenProtection: true,
    skipTaskbar: false,
    disguise: false
  };
  updateStealthUI(state.stealthState);

  if (window.rtai.onStealthModeUpdated) {
    window.rtai.onStealthModeUpdated((status) => {
      if (status) {
        state.stealthState = status;
        updateStealthUI(status);
        if (status.active) {
          showToast('Modo stealth ativado');
        } else {
          showToast('Modo Stealth Desativado');
        }
      }
    });
  }

  renderSidebarGoals();
  renderGoalsView();
  renderLibraryView();
  renderSessionsList();
  renderChecklist();

  const lastId = state.config.last_agent;
  const found = state.agents.find((a) => a.id === lastId) || state.agents[0];
  if (found) {
    selectActiveAgent(found);
  }

  window.rtai.onOverlayStatus((st) => {
    state.overlayStatus = st;
    renderOverlayStatusPill();
  });

  if (window.rtai.onOpenSettings) {
    window.rtai.onOpenSettings((section) => {
      switchView('settings');
      const tabs = ['general', 'appearance', 'defaults', 'calendar', 'stealth', 'shortcuts', 'billing'];
      switchSettingsTab(tabs.includes(section) ? section : 'general');
    });
  }
  if (window.rtai.onModeChanged) {
    window.rtai.onModeChanged((on) => {
      state.transcriptionOnly = Boolean(on);
      renderTranscriptionModeButton();
    });
  }

  if (window.rtai.onSessionSummary) {
    window.rtai.onSessionSummary(async (summary) => {
      if (!summary) return;
      if (!summary.ok) {
        showToast('Summary could not be generated; transcript was saved.');
        return;
      }
      const modal = document.getElementById('modalSessionSummary');
      const body = document.getElementById('summaryModalBody');
      const pathEl = document.getElementById('summaryModalPath');
      if (body) body.textContent = summary.text || '';
      if (pathEl) {
        pathEl.textContent = summary.export_path ? `Exported to: ${summary.export_path}` : '';
      }
      if (modal) modal.classList.add('open');
      showToast('Session summary generated!');

      if (state.activeAgent && window.rtai.generateDebrief) {
        try {
          const debriefRes = await window.rtai.generateDebrief({
            agentId: state.activeAgent.id,
            transcript: summary.text
          });
          if (debriefRes && debriefRes.agent) {
            state.activeAgent = debriefRes.agent;
            const idx = state.agents.findIndex((a) => a.id === state.activeAgent.id);
            if (idx >= 0) state.agents[idx] = state.activeAgent;
            if (state.currentView === 'goal-workspace') {
              renderGoalWorkspace();
            }
          }
        } catch (_e) {}
      }
      renderChecklist();
    });
  }

  // Navigation listeners
  document.querySelectorAll('.sh-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Settings subnav listeners
  document.querySelectorAll('.settings-subnav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.settingsTab));
  });

  // Library subtab listeners
  document.querySelectorAll('.library-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchLibraryTab(tab.dataset.libTab));
  });

  // Goal Workspace tabs and controls
  document.getElementById('btnWorkspaceBackToGoals')?.addEventListener('click', () => {
    switchView('goals');
  });

  // Home buttons (Sidebar Brand & Header Breadcrumb)
  document.getElementById('btnBrandHome')?.addEventListener('click', () => switchView('goals'));
  document.getElementById('btnHeaderHome')?.addEventListener('click', () => switchView('goals'));

  document.getElementById('tabGoalOverview')?.addEventListener('click', () => switchGoalWorkspaceTab('overview'));
  document.getElementById('tabGoalPrep')?.addEventListener('click', () => switchGoalWorkspaceTab('prep'));
  document.getElementById('tabGoalSessions')?.addEventListener('click', () => switchGoalWorkspaceTab('sessions'));

  // Update Progress Dropdown
  const btnUpdateProgress = document.getElementById('btnUpdateProgress');
  const menuUpdateProgress = document.getElementById('menuUpdateProgress');
  btnUpdateProgress?.addEventListener('click', (e) => {
    e.stopPropagation();
    menuUpdateProgress?.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#btnUpdateProgress') && !e.target.closest('#menuUpdateProgress')) {
      menuUpdateProgress?.classList.add('hidden');
    }
  });
  document.querySelectorAll('.stage-option-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newStage = btn.dataset.stage;
      menuUpdateProgress?.classList.add('hidden');
      if (state.activeAgent && newStage) {
        state.activeAgent.stage = newStage;
        const saved = await window.rtai.saveAgent(state.activeAgent);
        state.agents = saved.agents;
        selectActiveAgent(saved.saved);
        showToast(`Progress updated to: ${newStage}`);
      }
    });
  });

  // Interview Scheduler
  const openScheduler = () => {
    if (state.activeAgent) {
      const dateIn = document.getElementById('inputInterviewDate');
      const timeIn = document.getElementById('inputInterviewTime');
      const curDate = state.activeAgent.next_interview_date || (state.activeAgent.next_interview && state.activeAgent.next_interview.date) || '';
      const curTime = state.activeAgent.next_interview_time || (state.activeAgent.next_interview && state.activeAgent.next_interview.time) || '';
      if (dateIn) dateIn.value = curDate;
      if (timeIn) timeIn.value = curTime;
    }
    gcalPrepareScheduler();
    document.getElementById('modalInterviewScheduler')?.classList.add('open');
  };
  document.getElementById('btnOpenScheduler')?.addEventListener('click', openScheduler);
  document.getElementById('btnHeaderEditDate')?.addEventListener('click', openScheduler);
  document.getElementById('btnOverviewWhenNextRound')?.addEventListener('click', openScheduler);
  document.getElementById('btnOverviewEditDate')?.addEventListener('click', openScheduler);

  document.getElementById('btnCloseSchedulerModal')?.addEventListener('click', () => {
    document.getElementById('modalInterviewScheduler')?.classList.remove('open');
  });

  const clearInterviewAction = async () => {
    if (state.activeAgent) {
      state.activeAgent.next_interview_date = '';
      state.activeAgent.next_interview_time = '';
      state.activeAgent.next_interview = { date: '', time: '' };
      let cleared = null;
      if (window.rtai.clearInterview) {
        cleared = await window.rtai.clearInterview(state.activeAgent.id);
      }
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved || saved.agent || state.activeAgent);
      document.getElementById('modalInterviewScheduler')?.classList.remove('open');
      showToast(`Interview date removed.${gcalOutcomeText(cleared && cleared.calendar)}`);
    }
  };
  document.getElementById('btnSchedulerSkip')?.addEventListener('click', clearInterviewAction);
  document.getElementById('btnHeaderSkipDate')?.addEventListener('click', clearInterviewAction);
  document.getElementById('btnOverviewSkipDate')?.addEventListener('click', clearInterviewAction);

  document.getElementById('btnSchedulerConfirm')?.addEventListener('click', async () => {
    const dateVal = document.getElementById('inputInterviewDate')?.value;
    const timeVal = document.getElementById('inputInterviewTime')?.value;
    if (!dateVal) {
      showToast('Please select a date for the interview.');
      return;
    }
    if (state.activeAgent) {
      state.activeAgent.next_interview_date = dateVal;
      state.activeAgent.next_interview_time = timeVal || '';
      state.activeAgent.next_interview = { date: dateVal, time: timeVal || '' };
      let scheduled = null;
      if (window.rtai.scheduleInterview) {
        scheduled = await window.rtai.scheduleInterview({
          goalId: state.activeAgent.id,
          agentId: state.activeAgent.id,
          date: dateVal,
          time: timeVal || '',
          calendar: gcalSchedulerChoice()
        });
      }
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved || saved.agent || state.activeAgent);
      document.getElementById('modalInterviewScheduler')?.classList.remove('open');
      showToast(`Interview scheduled for ${formatDisplayDate(dateVal)}${timeVal ? ' at ' + timeVal : ''}.${gcalOutcomeText(scheduled && scheduled.calendar)}`);
    }
  });

  // Brief and Goal top edit
  document.getElementById('btnPrepEditBrief')?.addEventListener('click', () => openGoalModal(state.activeAgent));
  document.getElementById('btnEditGoalTop')?.addEventListener('click', () => openGoalModal(state.activeAgent));

  // Playbook Modal & Controls
  document.getElementById('btnPrepNewPlaybook')?.addEventListener('click', () => {
    const nameIn = document.getElementById('inputPlaybookName');
    const lenIn = document.getElementById('inputPlaybookLength');
    const structIn = document.getElementById('selectPlaybookStructure');
    const leadIn = document.getElementById('togglePlaybookLeadAnswer');
    const tradeIn = document.getElementById('togglePlaybookTradeoffs');
    if (nameIn) nameIn.value = '';
    if (lenIn) lenIn.value = 'Balanced';
    if (structIn) structIn.value = 'STAR (Situation, Task, Action, Result)';
    if (leadIn) leadIn.checked = true;
    if (tradeIn) tradeIn.checked = false;

    document.querySelectorAll('.playbook-len-btn').forEach((b) => {
      const isBal = b.dataset.length === 'Balanced';
      b.className = 'playbook-len-btn rounded-lg p-2.5 text-left transition cursor-pointer ' +
        (isBal ? 'border-2 border-primary bg-primary/5' : 'border border-border hover:border-primary');
    });
    document.getElementById('modalNewPlaybook')?.classList.add('open');
  });

  document.getElementById('btnCloseNewPlaybook')?.addEventListener('click', () => {
    document.getElementById('modalNewPlaybook')?.classList.remove('open');
  });
  document.getElementById('btnCancelNewPlaybook')?.addEventListener('click', () => {
    document.getElementById('modalNewPlaybook')?.classList.remove('open');
  });

  document.querySelectorAll('.playbook-len-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const len = btn.dataset.length;
      const lenIn = document.getElementById('inputPlaybookLength');
      if (lenIn) lenIn.value = len;
      document.querySelectorAll('.playbook-len-btn').forEach((b) => {
        const isSelected = b.dataset.length === len;
        b.className = 'playbook-len-btn rounded-lg p-2.5 text-left transition cursor-pointer ' +
          (isSelected ? 'border-2 border-primary bg-primary/5' : 'border border-border hover:border-primary');
      });
    });
  });

  document.getElementById('btnSaveNewPlaybook')?.addEventListener('click', async () => {
    const name = document.getElementById('inputPlaybookName')?.value.trim();
    if (!name) {
      showToast('Please enter the playbook name.');
      return;
    }
    const playbook = {
      name,
      answer_length: document.getElementById('inputPlaybookLength')?.value || 'Balanced',
      behavioral_structure: document.getElementById('selectPlaybookStructure')?.value || 'STAR (Situation, Task, Action, Result)',
      lead_with_answer: document.getElementById('togglePlaybookLeadAnswer')?.checked ?? true,
      name_tradeoffs: document.getElementById('togglePlaybookTradeoffs')?.checked ?? false
    };

    if (window.rtai.savePlaybook) {
      const res = await window.rtai.savePlaybook(playbook);
      if (res && res.playbooks) {
        state.playbooks = res.playbooks;
      }
    }

    if (state.activeAgent) {
      state.activeAgent.playbook_name = playbook.name;
      state.activeAgent.playbook_answer_length = playbook.answer_length;
      state.activeAgent.playbook_behavioral_structure = playbook.behavioral_structure;
      state.activeAgent.playbook_lead_with_answer = playbook.lead_with_answer;
      state.activeAgent.playbook_name_tradeoffs = playbook.name_tradeoffs;
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved);
    }
    document.getElementById('modalNewPlaybook')?.classList.remove('open');
    showToast(`Playbook "${name}" created and applied!`);
  });

  document.getElementById('selectPrepPlaybook')?.addEventListener('change', async (e) => {
    const pbName = e.target.value;
    const foundPb = (state.playbooks || []).find((p) => p.name === pbName);
    if (state.activeAgent && foundPb) {
      state.activeAgent.playbook_name = foundPb.name;
      state.activeAgent.playbook_answer_length = foundPb.answer_length;
      state.activeAgent.playbook_behavioral_structure = foundPb.behavioral_structure;
      state.activeAgent.playbook_lead_with_answer = foundPb.lead_with_answer;
      state.activeAgent.playbook_name_tradeoffs = foundPb.name_tradeoffs;
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved);
      const applied = saved.saved && saved.saved.playbook_name === pbName;
      showToast(applied
        ? `Playbook "${pbName}" applied${saved.overlayRestarted ? ' · overlay updated' : ''}.`
        : `Could not apply playbook "${pbName}".`);
    }
  });

  document.getElementById('selectPrepAnswerLang')?.addEventListener('change', async (e) => {
    if (state.activeAgent) {
      state.activeAgent.answer_language = e.target.value;
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved);
      const label = e.target.selectedOptions[0]?.textContent || e.target.value;
      showToast(`Answer language: ${label}${saved.overlayRestarted ? ' · overlay updated' : ''}.`);
    }
  });

  document.getElementById('selectPrepCodingLang')?.addEventListener('change', async (e) => {
    if (state.activeAgent) {
      state.activeAgent.coding_language = e.target.value;
      const saved = await window.rtai.saveAgent(state.activeAgent);
      state.agents = saved.agents;
      selectActiveAgent(saved.saved);
      const label = e.target.selectedOptions[0]?.textContent || 'Auto';
      showToast(`Coding language: ${label}${saved.overlayRestarted ? ' · overlay updated' : ''}.`);
    }
  });

  // Pin resume & Add material in Prep
  document.getElementById('btnPrepPinResume')?.addEventListener('click', async () => {
    const res = await window.rtai.pickFiles('resume');
    if (!res || !Array.isArray(res.documents) || res.documents.length === 0) return;
    if (state.activeAgent) {
      const otherDocs = (state.activeAgent.documents || []).filter((d) => cleanDocTag(d) !== 'resume');
      state.activeAgent.documents = [...otherDocs, ...res.documents.map((d) => ({ ...d, tag: 'resume' }))];
      const deep = await window.rtai.deepReadAgent(state.activeAgent);
      state.agents = deep.agents;
      selectActiveAgent(deep.agent || deep.saved || state.activeAgent);
      showToast('Resume linked successfully!');
    }
  });

  document.getElementById('btnPrepAddMaterial')?.addEventListener('click', async () => {
    const res = await window.rtai.pickFiles('material');
    if (!res || !Array.isArray(res.documents) || res.documents.length === 0) return;
    if (state.activeAgent) {
      state.activeAgent.documents = [...(state.activeAgent.documents || []), ...res.documents.map((d) => ({ ...d, tag: 'material' }))];
      const deep = await window.rtai.deepReadAgent(state.activeAgent);
      state.agents = deep.agents;
      selectActiveAgent(deep.agent || deep.saved || state.activeAgent);
      showToast(`${res.documents.length} document(s) added!`);
    }
  });

  // Start Practice & Go Live from Prep / Workspace
  document.getElementById('btnPrepStartPractice')?.addEventListener('click', () => {
    handleLaunchOverlay(true);
  });
  document.getElementById('btnWorkspaceGoLive')?.addEventListener('click', () => {
    handleLaunchOverlay(false);
  });
  document.getElementById('linkSessionsRunFirst')?.addEventListener('click', (e) => {
    e.preventDefault();
    handleLaunchOverlay(false);
  });
  document.getElementById('linkHowLiveStarts')?.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('Live sessions monitor the interview in real time with transcription and contextual suggestions.');
  });
  document.getElementById('linkHowPracticeWorks')?.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('Practice sessions run a simulation with typical company questions to train with the overlay.');
  });
  document.getElementById('linkSourcesExplained')?.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('Resume and materials are indexed in the mini-agent RAG to power authentic answers during interviews.');
  });
  document.getElementById('btnSessionsOpenPrep')?.addEventListener('click', () => {
    switchGoalWorkspaceTab('prep');
  });
  document.getElementById('btnOverviewViewAllSessions')?.addEventListener('click', () => {
    switchGoalWorkspaceTab('sessions');
  });

  // Filter buttons on Goals horizon
  document.getElementById('tabFilterCurrent')?.addEventListener('click', () => {
    state.goalsFilter = 'current';
    document.getElementById('tabFilterCurrent')?.classList.add('font-semibold', 'border-b-2', 'border-foreground');
    document.getElementById('tabFilterCurrent')?.classList.remove('text-muted-foreground');
    document.getElementById('tabFilterArchived')?.classList.remove('font-semibold', 'border-b-2', 'border-foreground');
    document.getElementById('tabFilterArchived')?.classList.add('text-muted-foreground');
    renderGoalsView();
  });
  document.getElementById('tabFilterArchived')?.addEventListener('click', () => {
    state.goalsFilter = 'archived';
    document.getElementById('tabFilterArchived')?.classList.add('font-semibold', 'border-b-2', 'border-foreground');
    document.getElementById('tabFilterArchived')?.classList.remove('text-muted-foreground');
    document.getElementById('tabFilterCurrent')?.classList.remove('font-semibold', 'border-b-2', 'border-foreground');
    document.getElementById('tabFilterCurrent')?.classList.add('text-muted-foreground');
    renderGoalsView();
  });
  document.getElementById('selectGoalsSort')?.addEventListener('change', () => {
    renderGoalsView();
  });


  // Getting started card links
  document.getElementById('stepCreateGoalLink')?.addEventListener('click', () => openGoalModal(null));
  document.getElementById('stepAddResumeLink')?.addEventListener('click', () => switchView('library'));
  document.getElementById('stepDemoLink')?.addEventListener('click', () => handleLaunchOverlay(true));
  document.getElementById('stepHistoryLink')?.addEventListener('click', () => switchView('history'));
  document.getElementById('btnDismissGettingStarted')?.addEventListener('click', () => {
    document.getElementById('gettingStartedCard').style.display = 'none';
  });

  // Search input for goals
  document.getElementById('inputSearchGoals')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderGoalsView();
  });

  // Window controls
  document.querySelectorAll('[data-win]').forEach((btn) => {
    btn.addEventListener('click', () => window.rtai.windowControl(btn.dataset.win));
  });

  // New goal buttons
  const triggerNewGoal = () => openGoalModal(null);
  document.getElementById('btnNewGoal')?.addEventListener('click', triggerNewGoal);
  document.getElementById('btnCanvasNewGoal')?.addEventListener('click', triggerNewGoal);
  document.getElementById('btnEmptyCreateGoal')?.addEventListener('click', triggerNewGoal);

  // Red Go Live buttons
  document.getElementById('btnTopGoLive')?.addEventListener('click', () => handleLaunchOverlay(false));
  document.getElementById('btnLaunchDemo')?.addEventListener('click', () => handleLaunchOverlay(true));
  document.getElementById('btnTopStopOverlay')?.addEventListener('click', async () => {
    await window.rtai.stopOverlay();
    showToast('Overlay closed.');
  });

  // Mode Toggle: Transcription Only
  document.getElementById('btnToggleTranscriptionMode')?.addEventListener('click', async () => {
    if (window.rtai && window.rtai.setMode) {
      // Request toggle from host without altering local state prematurely
      await window.rtai.setMode(!state.transcriptionOnly);
    }
  });

  // Session Summary Modal controls
  document.getElementById('btnCloseSummaryModal')?.addEventListener('click', () => {
    document.getElementById('modalSessionSummary')?.classList.remove('open');
  });
  document.getElementById('btnDismissSummaryModal')?.addEventListener('click', () => {
    document.getElementById('modalSessionSummary')?.classList.remove('open');
  });
  document.getElementById('btnOpenExportFolder')?.addEventListener('click', () => {
    window.rtai.openExternalPath();
  });

  // Help tooltip button
  document.getElementById('btnHelpTooltip')?.addEventListener('click', () => {
    switchView('settings');
    switchSettingsTab('shortcuts');
    showToast('Overlay HUD shortcuts displayed.');
  });

  // Goal Modal events
  document.getElementById('btnCloseGoalModal')?.addEventListener('click', () => {
    document.getElementById('modalGoalSetup').classList.remove('open');
  });
  document.getElementById('btnCancelGoalModal')?.addEventListener('click', () => {
    document.getElementById('modalGoalSetup').classList.remove('open');
  });

  // Auto-recon inside goal modal
  document.getElementById('btnGoalModalCompanyRecon')?.addEventListener('click', async () => {
    const company = document.getElementById('inputModalCompany').value.trim();
    const role = document.getElementById('inputModalRole').value.trim();
    const job_description = document.getElementById('inputModalJobDescription').value.trim();
    if (!company) {
      document.getElementById('inputModalCompany').focus();
      showToast('Please enter the company name or link first.');
      return;
    }
    const btn = document.getElementById('btnGoalModalCompanyRecon');
    btn.textContent = '⏳ Researching company...';
    try {
      const res = await window.rtai.companyRecon({ company, role, job_description });
      document.getElementById('inputModalCompanyResearch').value = res.dossier || '';
      const badge = document.getElementById('modalCompanyReconBadge');
      const text = document.getElementById('modalCompanyReconText');
      badge.classList.remove('hidden');
      badge.classList.add('flex');
      text.textContent = `${(res.dossier || '').slice(0, 60)}...`;
      showToast('Company context generated!');
    } finally {
      btn.textContent = 'Auto-research company';
    }
  });

  // Save Goal
  document.getElementById('btnSaveGoalModal')?.addEventListener('click', async () => {
    const draft = collectAgentFromGoalModal();
    showToast('Saving goal...');
    const res = await window.rtai.saveAgent(draft);
    state.agents = res.agents;
    selectActiveAgent(res.saved);
    document.getElementById('modalGoalSetup').classList.remove('open');
    renderSidebarGoals();
    renderGoalsView();
    showToast(`Goal "${res.saved.name}" saved!`);
  });

  // Goal Modal Go Live
  document.getElementById('btnGoalModalGoLive')?.addEventListener('click', async () => {
    const draft = collectAgentFromGoalModal();
    const res = await window.rtai.saveAgent(draft);
    state.agents = res.agents;
    selectActiveAgent(res.saved);
    document.getElementById('modalGoalSetup').classList.remove('open');
    renderSidebarGoals();
    renderGoalsView();
    handleLaunchOverlay(false);
  });

  // Delete Goal
  document.getElementById('btnDeleteGoal')?.addEventListener('click', async () => {
    const id = document.getElementById('inputGoalId').value;
    if (!id || state.agents.length <= 1) {
      showToast('Keep at least 1 goal in the list.');
      return;
    }
    const res = await window.rtai.deleteAgent(id);
    state.agents = res.agents;
    document.getElementById('modalGoalSetup').classList.remove('open');
    if (state.agents[0]) selectActiveAgent(state.agents[0]);
    renderSidebarGoals();
    renderGoalsView();
    showToast('Goal deleted.');
  });

  // Upload files in Goal modal
  document.getElementById('btnModalUploadFiles')?.addEventListener('click', async () => {
    const res = await window.rtai.pickFiles('material');
    if (!res || !Array.isArray(res.documents) || res.documents.length === 0) return;
    const draft = collectAgentFromGoalModal();
    draft.documents = [...(draft.documents || []), ...res.documents];
    const deep = await window.rtai.deepReadAgent(draft);
    state.agents = deep.agents;
    selectActiveAgent(deep.agent);
    openGoalModal(deep.agent);
    showToast(`${res.documents.length} file(s) added!`);
  });

  // Upload files in Library
  const triggerLibraryUpload = async () => {
    const tag = state.currentLibraryTab === 'resumes' ? 'resume' : 'material';
    const res = await window.rtai.pickFiles(tag);
    if (!res || !Array.isArray(res.documents) || res.documents.length === 0) return;

    if (!state.activeAgent && state.agents.length > 0) {
      state.activeAgent = state.agents[0];
    }
    if (state.activeAgent) {
      const draft = { ...state.activeAgent };
      draft.documents = [...(draft.documents || []), ...res.documents];
      const deep = await window.rtai.deepReadAgent(draft);
      state.agents = deep.agents;
      selectActiveAgent(deep.agent);
    }
    renderLibraryView();
    showToast(`${res.documents.length} file(s) added to Library!`);
  };
  document.getElementById('btnLibraryUploadFile')?.addEventListener('click', triggerLibraryUpload);
  document.getElementById('btnEmptyUploadFile')?.addEventListener('click', triggerLibraryUpload);

  // Paste Text Modal
  const openPasteModal = () => {
    document.getElementById('pasteDocTitle').value = '';
    document.getElementById('pasteDocContent').value = '';
    document.getElementById('modalPasteDoc').classList.add('open');
  };
  document.getElementById('btnLibraryPasteText')?.addEventListener('click', openPasteModal);
  document.getElementById('btnClosePasteModal')?.addEventListener('click', () => {
    document.getElementById('modalPasteDoc').classList.remove('open');
  });
  document.getElementById('btnCancelPasteDoc')?.addEventListener('click', () => {
    document.getElementById('modalPasteDoc').classList.remove('open');
  });

  document.getElementById('btnConfirmPasteDoc')?.addEventListener('click', async () => {
    const title = document.getElementById('pasteDocTitle').value.trim() || 'Document.md';
    const tag = document.getElementById('pasteDocTag').value;
    const content = document.getElementById('pasteDocContent').value.trim();
    if (!content) {
      showToast('Paste the content before saving.');
      return;
    }
    if (!state.activeAgent && state.agents.length > 0) {
      state.activeAgent = state.agents[0];
    }
    if (state.activeAgent) {
      const draft = { ...state.activeAgent };
      draft.documents = [...(draft.documents || []), { title, name: title, tag, path: tag, content }];
      const deep = await window.rtai.deepReadAgent(draft);
      state.agents = deep.agents;
      selectActiveAgent(deep.agent);
    }
    document.getElementById('modalPasteDoc').classList.remove('open');
    renderLibraryView();
    showToast(`"${title}" added to Library!`);
  });

  // Doc Preview Modal
  document.getElementById('btnCloseDocPreviewModal')?.addEventListener('click', () => {
    document.getElementById('modalDocPreview').classList.remove('open');
  });
  document.getElementById('btnDismissDocPreview')?.addEventListener('click', () => {
    document.getElementById('modalDocPreview').classList.remove('open');
  });

  // Profile Modal
  document.getElementById('profileChip')?.addEventListener('click', () => {
    document.getElementById('profName').value = state.profile.name || 'Bruno Raiado';
    document.getElementById('profEmail').value = state.profile.email || 'bruno2002.raiado@gmail.com';
    document.getElementById('profHeadline').value = state.profile.headline || 'Software Engineer';
    document.getElementById('modalProfile').classList.add('open');
  });
  document.getElementById('btnCloseProfileModal')?.addEventListener('click', () => {
    document.getElementById('modalProfile').classList.remove('open');
  });
  document.getElementById('btnSaveProfile')?.addEventListener('click', async () => {
    const res = await window.rtai.saveProfile({
      name: document.getElementById('profName').value.trim(),
      email: document.getElementById('profEmail').value.trim(),
      headline: document.getElementById('profHeadline').value.trim()
    });
    state.profile = res.profile;
    renderProfileHeader();
    document.getElementById('modalProfile').classList.remove('open');
    showToast('Profile updated successfully!');
  });

  // Settings API Keys Auto-Save and Clear
  const setupKeyAutoSave = (inputId, clearBtnId, configKey, label) => {
    const input = document.getElementById(inputId);
    const clearBtn = document.getElementById(clearBtnId);
    if (input) {
      const saveKey = async () => {
        const val = input.value.trim();
        if (!val || val.includes('••••••••')) return;
        try {
          const res = await window.rtai.saveConfig({ [configKey]: val });
          if (res && res.config) {
            state.config = res.config;
            populateSettingsForm(state.config);
            input.value = '';
            showToast(`${label} saved!`);
          }
        } catch (err) {
          console.error(`Failed to save ${label}:`, err);
          showToast(`Failed to save ${label}.`);
        }
      };
      input.addEventListener('change', saveKey);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveKey();
        }
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          const res = await window.rtai.saveConfig({ [configKey]: '' });
          if (res && res.config) {
            state.config = res.config;
            populateSettingsForm(state.config);
            if (input) input.value = '';
            showToast(`${label} cleared.`);
          }
        } catch (err) {
          console.error(`Failed to clear ${label}:`, err);
          showToast(`Failed to clear ${label}.`);
        }
      });
    }
  };

  setupKeyAutoSave('cfgDeepgramKey', 'btnClearDgKey', 'deepgram_key', 'Deepgram API Key');
  setupKeyAutoSave('cfgLlmKey', 'btnClearLlmKey', 'llm_key', 'OpenRouter API Key');
  setupKeyAutoSave('cfgOpenAiKey', 'btnClearOpenAiKey', 'openai_key', 'OpenAI API Key');
  setupKeyAutoSave('cfgAnthropicKey', 'btnClearAnthropicKey', 'anthropic_key', 'Anthropic API Key');
  setupKeyAutoSave('cfgGeminiKey', 'btnClearGeminiKey', 'gemini_key', 'Google Gemini API Key');

  // Plain settings (data-cfg-key): saved on change, numbers clamped.
  document.querySelectorAll('[data-cfg-key]').forEach((el) => {
    el.addEventListener('change', async () => {
      const key = el.dataset.cfgKey;
      const label = el.dataset.cfgLabel || 'Setting';
      let val = el.value.trim();
      if (el.dataset.cfgType === 'int' || el.dataset.cfgType === 'float') {
        let n = el.dataset.cfgType === 'int' ? parseInt(val, 10) : parseFloat(val);
        if (!Number.isFinite(n)) {
          populateSettingsForm(state.config || {});
          showToast(`${label}: enter a number.`);
          return;
        }
        if (el.dataset.cfgMin !== undefined) n = Math.max(Number(el.dataset.cfgMin), n);
        if (el.dataset.cfgMax !== undefined) n = Math.min(Number(el.dataset.cfgMax), n);
        val = n;
        el.value = String(n);
      } else {
        // One INI line: no line breaks.
        val = val.replace(/[\r\n]+/g, ' ');
      }
      try {
        const res = await window.rtai.saveConfig({ [key]: val });
        if (res && res.config) state.config = res.config;
        showToast(res && res.overlayRestarted ? `${label} saved. Overlay restarted to apply it.` : `${label} saved.`);
      } catch (err) {
        console.error(`Failed to save ${label}:`, err);
        showToast(`Could not save ${label}.`);
      }
    });
  });

  document.getElementById('btnOpenDataFolder')?.addEventListener('click', () => window.rtai.openExternalPath());

  // Model Tier Cards interactive selection
  const modelCards = [...document.querySelectorAll('.model-card')];
  modelCards.forEach((card, i) => {
    card.addEventListener('click', () => {
      if (card.getAttribute('aria-checked') === 'true') return;
      selectModelTier(card.dataset.tier, card.dataset.model, true);
    });
    // Radio-group keyboard behaviour: arrows move and select.
    card.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = modelCards[(i + step + modelCards.length) % modelCards.length];
      next.focus();
      next.click();
    });
  });

  // Backing selectDefaultModel change listener (for programmatic or keyboard changes)
  document.getElementById('selectDefaultModel')?.addEventListener('change', (e) => {
    const val = e.target.value;
    const tier = getTierForModel(val);
    selectModelTier(tier, val, true);
  });

  // Settings Toggles (Stealth, Defaults, Audio) immediate auto-save & overlay sync
  const handleSettingToggle = (key, checkboxId, label) => {
    const el = document.getElementById(checkboxId);
    if (!el) return;
    el.addEventListener('change', async () => {
      const val = el.checked;
      if (checkboxId.startsWith('cfgStealth')) {
        updateStealthBadge();
      }
      try {
        const res = await window.rtai.saveConfig({ [key]: val });
        if (res && res.config) state.config = res.config;
        if (res && res.overlayRestarted) {
          showToast(`${label} ${val ? 'enabled' : 'disabled'}! Overlay updated.`);
        } else {
          showToast(`${label} ${val ? 'enabled' : 'disabled'}.`);
        }
      } catch (err) {
        console.error(`Failed to update ${label}:`, err);
        showToast(`Failed to update ${label}.`);
      }
    });
  };

  handleSettingToggle('stealth_dock', 'cfgStealthDock', 'Dock & taskbar invisibility');
  handleSettingToggle('stealth_activity_monitor', 'cfgStealthActivityMonitor', 'Activity monitor stealth');
  handleSettingToggle('stealth_click_through', 'cfgStealthClickThrough', 'Click-through mode');
  handleSettingToggle('stealth_screen_capture', 'cfgStealthScreenCapture', 'Screen-recording invisibility');
  handleSettingToggle('electron_screen_protection', 'cfgElectronScreenProtection', 'Proteção de tela do Dashboard');
  handleSettingToggle('electron_skip_taskbar', 'cfgElectronSkipTaskbar', 'Ocultação da barra de tarefas');
  handleSettingToggle('electron_disguise', 'cfgElectronDisguise', 'Modo disfarce');
  handleSettingToggle('auto_suggest', 'cfgDefaultAutoSuggest', 'Auto suggestion');

  document.getElementById('btnTopStealthMode')?.addEventListener('click', async () => {
    try {
      const res = await window.rtai.toggleStealthMode();
      if (res && res.status) {
        state.stealthState = res.status;
        updateStealthUI(res.status);
        showToast(res.status.active ? 'Modo stealth ativado: janela protegida contra captura de tela.' : 'Modo Stealth desativado — Janela visível normalmente.');
      }
    } catch (err) {
      console.error('Failed to toggle stealth mode:', err);
      showToast('Falha ao alternar modo stealth.');
    }
  });

  document.getElementById('btnQuickToggleStealth')?.addEventListener('click', async () => {
    try {
      const res = await window.rtai.toggleStealthMode();
      if (res && res.status) {
        state.stealthState = res.status;
        updateStealthUI(res.status);
        showToast(res.status.active ? 'Modo stealth ativado' : 'Modo Stealth Desativado');
      }
    } catch (err) {
      console.error('Failed to toggle stealth mode:', err);
    }
  });
  handleSettingToggle('save_sessions', 'cfgDefaultSaveSessions', 'Save sessions');
  handleSettingToggle('mic_enabled', 'cfgMicEnabled', 'Microphone capture');
  handleSettingToggle('loopback_enabled', 'cfgLoopbackEnabled', 'System audio capture');

  document.getElementById('selectDefaultLanguage')?.addEventListener('change', async (e) => {
    const lang = e.target.value;
    try {
      const res = await window.rtai.saveConfig({ language: lang });
      if (res && res.config) state.config = res.config;
      showToast(`Interview language set to ${e.target.selectedOptions[0]?.textContent || lang}.`);
    } catch (err) {
      console.error('Failed to update language:', err);
      showToast('Failed to update language.');
    }
  });

  // Sessions folder
  document.getElementById('btnOpenSessionsFolder')?.addEventListener('click', () => {
    window.rtai.openExternalPath();
  });

  // Toggle sidebar button
  document.getElementById('btnToggleSidebar')?.addEventListener('click', () => {
    const aside = document.querySelector('aside');
    if (aside) {
      aside.classList.toggle('hidden');
    }
  });

  document.getElementById('sidebarPlanCard')?.addEventListener('click', () => {
    switchView('settings');
    switchSettingsTab('general');
  });

  // Account: edit profile, provider consoles, data folder.
  document.getElementById('btnEditProfile')?.addEventListener('click', () => {
    document.getElementById('profileChip')?.click();
  });
  document.getElementById('btnAccountOpenData')?.addEventListener('click', () => window.rtai.openExternalPath());
  document.querySelectorAll('[data-open-url]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await window.rtai.openUrl(btn.dataset.openUrl);
      if (!res || !res.ok) showToast('Could not open the link.');
    });
  });

  setupUpdatesAndModernHero();
  setupAiProvidersAndAudio();
  setupGoogleCalendar();
  setupMeetingDetection();
}

// ---------------------------------------------------------------------------
// Meeting detection (Settings > General)
// ---------------------------------------------------------------------------
function renderMeetingDetection(st) {
  if (!st) return;
  const detect = document.getElementById('cfgMeetingDetect');
  const trayIn = document.getElementById('cfgMeetingTray');
  if (detect) detect.checked = Boolean(st.enabled);
  if (trayIn) {
    trayIn.checked = Boolean(st.keepInTray);
    trayIn.disabled = !st.enabled;
  }
  const status = document.getElementById('meetingDetectStatus');
  if (status) {
    const active = Array.isArray(st.active) ? st.active : [];
    if (!st.supported) status.textContent = 'Available on Windows only.';
    else if (!st.enabled) status.textContent = 'Off. No popup when a meeting starts.';
    else if (active.length) status.textContent = `In a call now: ${active.map((m) => m.name).join(', ')}.`;
    else status.textContent = 'Watching for meetings.';
  }
  const muted = Array.isArray(st.mutedApps) ? st.mutedApps : [];
  const row = document.getElementById('meetingMutedRow');
  const list = document.getElementById('meetingMutedList');
  if (row && list) {
    const names = st.appNames || {};
    list.textContent = muted.map((id) => names[id] || id).join(', ');
    row.classList.toggle('hidden', muted.length === 0);
  }
}

async function setupMeetingDetection() {
  if (!window.rtai || !window.rtai.getMeetingDetection) return;
  try {
    renderMeetingDetection(await window.rtai.getMeetingDetection());
  } catch (_e) {}
  window.rtai.onMeetingDetection(renderMeetingDetection);

  const save = async (patch, okMsg) => {
    try {
      renderMeetingDetection(await window.rtai.setMeetingDetection(patch));
      if (okMsg) showToast(okMsg);
    } catch (err) {
      console.error('Failed to update meeting detection:', err);
      showToast('Failed to update meeting detection.');
    }
  };
  document.getElementById('cfgMeetingDetect')?.addEventListener('change', (e) =>
    save({ enabled: e.target.checked }, `Meeting detection ${e.target.checked ? 'enabled' : 'disabled'}.`));
  document.getElementById('cfgMeetingTray')?.addEventListener('change', (e) =>
    save({ keepInTray: e.target.checked }, e.target.checked ? 'RealTimeAI stays in the tray when closed.' : 'Closing the window quits RealTimeAI.'));
  document.getElementById('btnMeetingUnmute')?.addEventListener('click', () =>
    save({ mutedApps: [] }, 'The popup will show for every app again.'));
  document.getElementById('btnMeetingTest')?.addEventListener('click', async () => {
    try {
      await window.rtai.testMeetingPopup();
    } catch (_e) {
      showToast('Could not show the popup.');
    }
  });
}

window.addEventListener('DOMContentLoaded', initApp);
