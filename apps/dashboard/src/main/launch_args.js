'use strict';
// Command-line requests to the dashboard. The native engine, when started on
// its own, passes --open-settings[=section] to bring up the Settings page.

// The Settings section asked for on this command line, or '' when none was.
function settingsSectionFromArgv(argv) {
  for (const arg of argv || []) {
    const match = /^--open-settings(?:=([\w-]+))?$/.exec(String(arg));
    if (match) return match[1] || 'general';
  }
  return '';
}

module.exports = { settingsSectionFromArgv };
