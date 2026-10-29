const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rtai', {
  getState: () => ipcRenderer.invoke('rtai:get-state'),
  saveAgent: (agent) => ipcRenderer.invoke('rtai:save-agent', agent),
  deleteAgent: (agentId) => ipcRenderer.invoke('rtai:delete-agent', agentId),
  pickFiles: (defaultTag) => ipcRenderer.invoke('rtai:pick-files', defaultTag),
  deepReadAgent: (agent) => ipcRenderer.invoke('rtai:deep-read', agent),
  companyRecon: (payload) => ipcRenderer.invoke('rtai:company-recon', payload),
  syncCalendar: (icsUrl) => ipcRenderer.invoke('rtai:calendar-sync', icsUrl),
  saveConfig: (config) => ipcRenderer.invoke('rtai:save-config', config),
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
  setProcessDisguise: (disguise) => ipcRenderer.invoke('rtai:set-process-disguise', disguise),
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
