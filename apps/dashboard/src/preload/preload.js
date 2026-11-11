const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rtai', {
  getState: () => ipcRenderer.invoke('rtai:get-state'),
  // Live view: engine events in, whitelisted commands out (answer, chat, pause...).
  onLiveEvent: (cb) => {
    const handler = (_event, msg) => cb(msg);
    ipcRenderer.on('rtai:live-event', handler);
    return () => ipcRenderer.removeListener('rtai:live-event', handler);
  },
  overlayCommand: (command) => ipcRenderer.invoke('rtai:overlay-command', command),
  // Drag & drop: File objects carry no path in the renderer since Electron 32.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (_e) {
      return '';
    }
  },
  importFiles: (paths, tag) => ipcRenderer.invoke('rtai:import-files', { paths, tag }),
  // JEV: per-question rubric for a saved session (cached as <id>.jev.json).
  evaluateSession: (sessionId, agentId, force) => ipcRenderer.invoke('rtai:evaluate-session', { sessionId, agentId, force: Boolean(force) }),
  rebuildQuestionBank: () => ipcRenderer.invoke('rtai:rebuild-question-bank'),
  saveAgent: (agent) => ipcRenderer.invoke('rtai:save-agent', agent),
  deleteAgent: (agentId) => ipcRenderer.invoke('rtai:delete-agent', agentId),
  pickFiles: (defaultTag) => ipcRenderer.invoke('rtai:pick-files', defaultTag),
  deepReadAgent: (agent) => ipcRenderer.invoke('rtai:deep-read', agent),
  companyRecon: (payload) => ipcRenderer.invoke('rtai:company-recon', payload),
  syncCalendar: (icsUrl) => ipcRenderer.invoke('rtai:calendar-sync', icsUrl),
  saveConfig: (config) => ipcRenderer.invoke('rtai:save-config', config),
  // lipcue.com cloud account: device sign-in, status, sign-out.
  cloudStatus: (force) => ipcRenderer.invoke('rtai:cloud-status', Boolean(force)),
  cloudPasswordLogin: (creds) => ipcRenderer.invoke('rtai:cloud-password-login', creds),
  cloudSignup: (data) => ipcRenderer.invoke('rtai:cloud-signup', data),
  cloudReferral: () => ipcRenderer.invoke('rtai:cloud-referral'),
  pairCatalog: () => ipcRenderer.invoke('rtai:pair-catalog'),
  pairRun: (p) => ipcRenderer.invoke('rtai:pair-run', p),
  pairChat: (p) => ipcRenderer.invoke('rtai:pair-chat', p),
  pairFinish: (p) => ipcRenderer.invoke('rtai:pair-finish', p),
  pairHistory: () => ipcRenderer.invoke('rtai:pair-history'),
  jevHistory: () => ipcRenderer.invoke('rtai:jev-history'),
  cloudResetPassword: (email) => ipcRenderer.invoke('rtai:cloud-reset-password', email),
  cloudDeleteAccount: (password) => ipcRenderer.invoke('rtai:cloud-delete-account', password),
  cloudSync: () => ipcRenderer.invoke('rtai:cloud-sync'),
  onCloudSynced: (cb) => {
    const handler = (_ev, payload) => cb(payload);
    ipcRenderer.on('rtai:cloud-synced', handler);
    return () => ipcRenderer.removeListener('rtai:cloud-synced', handler);
  },
  cloudFiles: () => ipcRenderer.invoke('rtai:cloud-files'),
  cloudFileDelete: (id) => ipcRenderer.invoke('rtai:cloud-file-delete', id),
  cloudFilesBackup: () => ipcRenderer.invoke('rtai:cloud-files-backup'),
  mockStart: (agentId, lang, mode, settings) => ipcRenderer.invoke('rtai:mock-start', agentId, lang, mode, settings),
  mockAnalyze: (image, previousImage) => ipcRenderer.invoke('rtai:mock-analyze', image, previousImage),
  mockTurn: (text, action, holdMs) => ipcRenderer.invoke('rtai:mock-turn', text, action, holdMs),
  mockCancelTurn: () => ipcRenderer.invoke('rtai:mock-cancel-turn'),
  mockSpeak: (text) => ipcRenderer.invoke('rtai:mock-speak', text),
  mockEnd: () => ipcRenderer.invoke('rtai:mock-end'),
  mockPrep: (agentId) => ipcRenderer.invoke('rtai:mock-prep', agentId),
  mockCoach: (id, question) => ipcRenderer.invoke('rtai:mock-coach', id, question),
  mockList: () => ipcRenderer.invoke('rtai:mock-list'),
  mockSttToken: () => ipcRenderer.invoke('rtai:mock-stt-token'),
  onMockEvent: (cb) => {
    const handler = (_event, msg) => cb(msg);
    ipcRenderer.on('rtai:mock-event', handler);
    return () => ipcRenderer.removeListener('rtai:mock-event', handler);
  },
  cloudBilling: (kind, pack) => ipcRenderer.invoke('rtai:cloud-billing', kind, pack),
  cloudLogout: () => ipcRenderer.invoke('rtai:cloud-logout'),
  feedbackSubmit: (p) => ipcRenderer.invoke('rtai:feedback-submit', p),
  feedbackShouldAskMock: (p) => ipcRenderer.invoke('rtai:feedback-should-ask-mock', p),
  feedbackSetPrompt: (v) => ipcRenderer.invoke('rtai:feedback-set-prompt', v),
  feedbackSavePrompt: (v) => ipcRenderer.invoke('rtai:feedback-save-prompt', v),
  feedbackGetPrompt: () => ipcRenderer.invoke('rtai:feedback-get-prompt'),
  onFeedbackPrompt: (cb) => {
    const handler = (_ev, p) => cb(p);
    ipcRenderer.on('rtai:feedback-prompt', handler);
    return () => ipcRenderer.removeListener('rtai:feedback-prompt', handler);
  },
  onFeedbackClose: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('rtai:feedback-close', handler);
    return () => ipcRenderer.removeListener('rtai:feedback-close', handler);
  },
  onCloudEvent: (cb) => {
    const handler = (_event, msg) => cb(msg);
    ipcRenderer.on('rtai:cloud-event', handler);
    return () => ipcRenderer.removeListener('rtai:cloud-event', handler);
  },
  saveProfile: (profile) => ipcRenderer.invoke('rtai:save-profile', profile),
  startOverlay: (options) => ipcRenderer.invoke('rtai:start-overlay', options),
  stopOverlay: () => ipcRenderer.invoke('rtai:stop-overlay'),
  readSessionDetail: (sessionFile) => ipcRenderer.invoke('rtai:read-session', sessionFile),
  openExternalPath: (targetPath) => ipcRenderer.invoke('rtai:open-path', targetPath),
  windowControl: (action) => ipcRenderer.invoke('rtai:window-control', action),
  setThemePreference: (pref) => ipcRenderer.invoke('rtai:set-theme-preference', pref),
  setMode: (on) => ipcRenderer.invoke('rtai:set-mode', on),
  getPlaybooks: () => ipcRenderer.invoke('rtai:get-playbooks'),
  savePlaybook: (pb) => ipcRenderer.invoke('rtai:save-playbook', pb),
  scheduleInterview: (goalIdOrObj, date, time) => {
    let goalId = goalIdOrObj;
    let d = date;
    let t = time;
    let calendar;
    if (typeof goalIdOrObj === 'object' && goalIdOrObj !== null) {
      goalId = goalIdOrObj.goalId || goalIdOrObj.agentId || goalIdOrObj.id;
      d = goalIdOrObj.date;
      t = goalIdOrObj.time;
      calendar = goalIdOrObj.calendar;
    }
    return ipcRenderer.invoke('rtai:schedule-interview', { goalId, date: d, time: t, calendar });
  },
  clearInterview: (goalIdOrObj) => {
    let goalId = goalIdOrObj;
    if (typeof goalIdOrObj === 'object' && goalIdOrObj !== null) {
      goalId = goalIdOrObj.goalId || goalIdOrObj.agentId || goalIdOrObj.id;
    }
    return ipcRenderer.invoke('rtai:clear-interview', goalId);
  },
  generateDebrief: (payload) => ipcRenderer.invoke('rtai:generate-debrief', payload),
  // Google Calendar
  gcalStatus: () => ipcRenderer.invoke('rtai:gcal-status'),
  gcalImportClient: () => ipcRenderer.invoke('rtai:gcal-import-client'),
  gcalConnect: () => ipcRenderer.invoke('rtai:gcal-connect'),
  gcalDisconnect: () => ipcRenderer.invoke('rtai:gcal-disconnect'),
  gcalSaveSettings: (patch) => ipcRenderer.invoke('rtai:gcal-save-settings', patch),
  gcalCalendars: () => ipcRenderer.invoke('rtai:gcal-calendars'),
  gcalEvents: (opts) => ipcRenderer.invoke('rtai:gcal-events', opts),
  gcalCreateEvent: (ev) => ipcRenderer.invoke('rtai:gcal-create-event', ev),
  gcalUpdateEvent: (calendarId, eventId, ev) => ipcRenderer.invoke('rtai:gcal-update-event', { calendarId, eventId, event: ev }),
  gcalDeleteEvent: (calendarId, eventId) => ipcRenderer.invoke('rtai:gcal-delete-event', { calendarId, eventId }),
  gcalOpen: (url) => ipcRenderer.invoke('rtai:gcal-open', url),
  saveChecklist: (goalId, state) => ipcRenderer.invoke('rtai:save-checklist', { goalId, state }),
  onOverlayStatus: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('rtai:overlay-status', handler);
    return () => ipcRenderer.removeListener('rtai:overlay-status', handler);
  },
  onModeChanged: (cb) => {
    const handler = (_event, on) => cb(on);
    ipcRenderer.on('rtai:mode', handler);
    return () => ipcRenderer.removeListener('rtai:mode', handler);
  },
  openUrl: (url) => ipcRenderer.invoke('rtai:open-url', url),
  // Meeting detection popup
  getMeetingDetection: () => ipcRenderer.invoke('rtai:meeting-detection-get'),
  setMeetingDetection: (patch) => ipcRenderer.invoke('rtai:meeting-detection-set', patch),
  testMeetingPopup: () => ipcRenderer.invoke('rtai:meeting-popup-test'),
  onMeetingDetection: (cb) => {
    const handler = (_event, st) => cb(st);
    ipcRenderer.on('rtai:meeting-detection', handler);
    return () => ipcRenderer.removeListener('rtai:meeting-detection', handler);
  },
  onOpenSettings: (cb) => {
    const handler = (_event, section) => cb(section);
    ipcRenderer.on('rtai:open-settings', handler);
    return () => ipcRenderer.removeListener('rtai:open-settings', handler);
  },
  onSessionSummary: (cb) => {
    const handler = (_event, summary) => cb(summary);
    ipcRenderer.on('rtai:summary', handler);
    return () => ipcRenderer.removeListener('rtai:summary', handler);
  },
  onSystemThemeUpdated: (cb) => {
    const handler = (_event, themeInfo) => cb(themeInfo);
    ipcRenderer.on('rtai:system-theme-updated', handler);
    return () => ipcRenderer.removeListener('rtai:system-theme-updated', handler);
  },
  // Stealth Mode for Electron App
  getStealthState: () => ipcRenderer.invoke('rtai:get-stealth-state'),
  toggleStealthMode: () => ipcRenderer.invoke('rtai:toggle-stealth-mode'),
  setStealthMode: (patch) => ipcRenderer.invoke('rtai:set-stealth-mode', patch),
  onStealthModeUpdated: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on('rtai:stealth-mode-updated', handler);
    return () => ipcRenderer.removeListener('rtai:stealth-mode-updated', handler);
  },
  // App Version & Updates
  getAppVersion: () => ipcRenderer.invoke('rtai:get-app-version'),
  checkUpdate: () => ipcRenderer.invoke('rtai:check-update'),
  downloadUpdate: () => ipcRenderer.invoke('rtai:download-update'),
  installUpdate: () => ipcRenderer.invoke('rtai:install-update'),
  setInterfaceOpacity: (opacity) => ipcRenderer.invoke('rtai:set-interface-opacity', opacity),
  testSound: () => ipcRenderer.invoke('rtai:test-sound'),
  onUpdateProgress: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on('rtai:update-progress', handler);
    return () => ipcRenderer.removeListener('rtai:update-progress', handler);
  },
  onUpdateDownloaded: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on('rtai:update-downloaded', handler);
    return () => ipcRenderer.removeListener('rtai:update-downloaded', handler);
  },
  getUpdateStatus: () => ipcRenderer.invoke('rtai:update-status'),
  setUpdateChannel: (channel) => ipcRenderer.invoke('rtai:set-update-channel', channel),
  onUpdateStatus: (cb) => {
    const handler = (_event, st) => cb(st);
    ipcRenderer.on('rtai:update-status', handler);
    return () => ipcRenderer.removeListener('rtai:update-status', handler);
  },
  // Feature flags (A/B tests, staged rollout, beta-only features)
  getFlags: () => ipcRenderer.invoke('rtai:flags-get'),
  refreshFlags: () => ipcRenderer.invoke('rtai:flags-refresh'),
  setFlagOverride: (key, value) => ipcRenderer.invoke('rtai:flags-set-override', { key, value }),
  resetFlagOverrides: () => ipcRenderer.invoke('rtai:flags-reset-overrides'),
  onFlagsChanged: (cb) => {
    const handler = (_event, snap) => cb(snap);
    ipcRenderer.on('rtai:flags-changed', handler);
    return () => ipcRenderer.removeListener('rtai:flags-changed', handler);
  },
  // Question Bank & JEV Community Analysis
  getQuestionBank: () => ipcRenderer.invoke('rtai:get-question-bank'),
  getCompanyQuestions: (companyId) => ipcRenderer.invoke('rtai:get-company-questions', companyId),
  unlockCompanyQuestions: (companyId, previewOnly) => ipcRenderer.invoke('rtai:unlock-company-questions', { companyId, previewOnly }),
  setQuestionSharing: (enabled) => ipcRenderer.invoke('rtai:set-question-sharing', enabled),
  triggerJevAnalysis: (payload) => ipcRenderer.invoke('rtai:trigger-jev-analysis', payload),
  detectCompany: (transcript, fallbackName) => ipcRenderer.invoke('rtai:detect-company', { transcript, fallbackName }),
  fetchCompanyLogo: (companyName, domain) => ipcRenderer.invoke('rtai:fetch-company-logo', { companyName, domain }),
  onQuestionBankUpdated: (cb) => {
    const handler = (_event, res) => cb(res);
    ipcRenderer.on('rtai:question-bank-updated', handler);
    return () => ipcRenderer.removeListener('rtai:question-bank-updated', handler);
  }
});
