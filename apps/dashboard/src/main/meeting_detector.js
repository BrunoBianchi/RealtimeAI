'use strict';
// Meeting detection (Windows).
//
// Two signals, read by one long-lived PowerShell process that prints a JSON
// line per scan (no process spawn per tick):
//   1. Which apps are using the microphone right now. Windows records this in
//      HKCU\...\CapabilityAccessManager\ConsentStore\microphone: an entry whose
//      LastUsedTimeStop is 0 is holding the mic at this moment. Packaged apps
//      (new Teams, Skype, WhatsApp) show up by package name, desktop apps under
//      NonPackaged by exe path ("C:#Program Files#...#Zoom.exe").
//   2. Titles of visible top-level windows with their process name, so a
//      browser holding the mic can be told apart: a Meet tab vs. a voice note.
//
// classifySnapshot() turns one scan into the calls in progress (pure, tested).
// MeetingDetector adds debouncing: a call must be seen in 2 scans in a row to
// start, and missing from 3 in a row to end, so a mic test or a tab switch
// does not flash a popup.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Desktop apps. `exes` are lower-case process image names, `packages` match
// packaged-app keys in the consent store, `titles` (optional) are window
// titles that mean "in a call" even before the mic opens.
const DESKTOP_APPS = [
  { id: 'zoom', name: 'Zoom', exes: ['zoom.exe', 'zoomworkplace.exe'], packages: [],
    titles: [/^zoom meeting\b/i, /^zoom webinar\b/i, /^reuni[aã]o zoom\b/i, /\bzoom meeting$/i] },
  { id: 'teams', name: 'Microsoft Teams', exes: ['ms-teams.exe', 'teams.exe'], packages: [/^msteams_/i, /^microsoftteams_/i] },
  { id: 'skype', name: 'Skype', exes: ['skype.exe'], packages: [/^microsoft\.skypeapp_/i] },
  { id: 'discord', name: 'Discord', exes: ['discord.exe', 'discordptb.exe', 'discordcanary.exe'], packages: [] },
  { id: 'slack', name: 'Slack huddle', exes: ['slack.exe'], packages: [/slack/i] },
  { id: 'webex', name: 'Webex', exes: ['webex.exe', 'ciscocollabhost.exe', 'webexmta.exe', 'atmgr.exe', 'ciscowebexstart.exe'], packages: [/webex/i] },
  { id: 'whatsapp', name: 'WhatsApp call', exes: ['whatsapp.exe'], packages: [/whatsappdesktop/i] },
  { id: 'telegram', name: 'Telegram call', exes: ['telegram.exe'], packages: [/telegram/i] },
  { id: 'signal', name: 'Signal call', exes: ['signal.exe'], packages: [] },
  { id: 'goto', name: 'GoTo Meeting', exes: ['g2mcomm.exe', 'g2mstart.exe', 'gotomeeting.exe', 'goto.exe'], packages: [] },
  { id: 'ringcentral', name: 'RingCentral', exes: ['ringcentral.exe', 'ringcentralmeetings.exe'], packages: [] },
  { id: 'bluejeans', name: 'BlueJeans', exes: ['bluejeans.exe', 'bluejeans.v2.exe'], packages: [] },
  { id: 'chime', name: 'Amazon Chime', exes: ['chime.exe'], packages: [] },
  { id: 'jitsi', name: 'Jitsi Meet', exes: ['jitsi meet.exe', 'jitsi-meet.exe'], packages: [] },
  { id: 'viber', name: 'Viber call', exes: ['viber.exe'], packages: [] }
];

// Web meetings: matched on the title of a browser window. A browser counts
// only while it holds the mic, except for `strong` titles (a Meet room code)
// that only exist inside a call or its lobby.
const WEB_APPS = [
  { id: 'meet', name: 'Google Meet', strong: [/\bmeet\s*[-–—:|]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i, /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\s*[-–—|]\s*google meet\b/i],
    titles: [/^meet\s*[-–—:]/i, /google meet/i] },
  { id: 'teams', name: 'Microsoft Teams', strong: [], titles: [/microsoft teams/i, /\bteams\.(microsoft|live)\.com/i] },
  { id: 'zoom', name: 'Zoom', strong: [], titles: [/\bzoom\b/i] },
  { id: 'webex', name: 'Webex', strong: [], titles: [/webex/i] },
  { id: 'jitsi', name: 'Jitsi Meet', strong: [], titles: [/jitsi/i, /8x8/i] },
  { id: 'whereby', name: 'Whereby', strong: [], titles: [/whereby/i] },
  { id: 'discord', name: 'Discord', strong: [], titles: [/discord/i] },
  { id: 'skype', name: 'Skype', strong: [], titles: [/skype/i] },
  { id: 'slack', name: 'Slack huddle', strong: [], titles: [/huddle/i] },
  { id: 'whatsapp', name: 'WhatsApp call', strong: [], titles: [/whatsapp/i] },
  { id: 'gather', name: 'Gather', strong: [], titles: [/gather/i] },
  { id: 'around', name: 'Around', strong: [], titles: [/\baround\b/i] },
  { id: 'livestorm', name: 'Livestorm', strong: [], titles: [/livestorm/i] },
  { id: 'bbb', name: 'BigBlueButton', strong: [], titles: [/bigbluebutton/i] },
  { id: 'riverside', name: 'Riverside', strong: [], titles: [/riverside/i] },
  { id: 'streamyard', name: 'StreamYard', strong: [], titles: [/streamyard/i] }
];

const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe',
  'arc.exe', 'chromium.exe', 'iexplore.exe', 'zen.exe', 'librewolf.exe', 'waterfox.exe', 'thorium.exe'];

// Never a meeting: RealTimeAI itself holds the mic while the copilot runs.
const SELF_EXES = ['rtai_app.exe', 'rtai_overlay.exe', 'electron.exe', 'realtimeai.exe'];

const APP_NAMES = Object.fromEntries([...DESKTOP_APPS, ...WEB_APPS].map((a) => [a.id, a.name]));

function exeOf(processName) {
  const n = String(processName || '').trim().toLowerCase();
  if (!n) return '';
  return n.endsWith('.exe') ? n : `${n}.exe`;
}

// Consent-store key -> { exe } for desktop apps ("C:#...#Zoom.exe") or
// { pkg } for packaged ones ("MSTeams_8wekyb3d8bbwe").
function parseMicEntry(key) {
  const k = String(key || '');
  if (k.includes('#') || /\.exe$/i.test(k)) {
    const parts = k.split('#');
    return { exe: parts[parts.length - 1].toLowerCase() };
  }
  return { pkg: k };
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// A browser tab title often ends with " - Google Chrome", " — Mozilla Firefox".
function stripBrowserSuffix(title) {
  return cleanTitle(title).replace(/\s*[-–—]\s*(google chrome|microsoft\u200b?\s?edge|mozilla firefox|brave|opera|vivaldi|arc|chromium)$/i, '')
    .replace(/\s*e mais \d+ p[aá]ginas?.*$/i, '')
    .replace(/\s*and \d+ more pages?.*$/i, '');
}

function matchAny(regexes, text) {
  return (regexes || []).some((r) => r.test(text));
}

/**
 * One scan -> calls in progress.
 * @param {{mic?: string[], win?: {p: string, t: string}[]}} snap
 * @returns {{id: string, name: string, title: string, via: 'mic'|'window'|'browser'}[]}
 */
function classifySnapshot(snap) {
  const micKeys = Array.isArray(snap && snap.mic) ? snap.mic : [];
  const windows = (Array.isArray(snap && snap.win) ? snap.win : [])
    .map((w) => ({ exe: exeOf(w && w.p), title: cleanTitle(w && w.t) }))
    .filter((w) => w.exe && w.title && !SELF_EXES.includes(w.exe));

  const micExes = new Set();
  const micPkgs = [];
  for (const key of micKeys) {
    const e = parseMicEntry(key);
    if (e.exe) {
      if (!SELF_EXES.includes(e.exe)) micExes.add(e.exe);
    } else if (e.pkg) {
      micPkgs.push(e.pkg);
    }
  }

  const found = new Map();
  const add = (id, name, title, via) => {
    if (!found.has(id)) found.set(id, { id, name, title: cleanTitle(title), via });
  };

  // 1. Desktop apps: holding the mic, or a window title only a call has.
  for (const app of DESKTOP_APPS) {
    const ownWindows = windows.filter((w) => app.exes.includes(w.exe));
    const usesMic = app.exes.some((x) => micExes.has(x)) || micPkgs.some((p) => matchAny(app.packages, p));
    const callWindow = app.titles ? ownWindows.find((w) => matchAny(app.titles, w.title)) : null;
    if (usesMic || callWindow) {
      const title = (callWindow || ownWindows.find((w) => w.title.toLowerCase() !== app.name.toLowerCase()) || ownWindows[0] || {}).title || '';
      add(app.id, app.name, title, usesMic ? 'mic' : 'window');
    }
  }

  // 2. Web meetings in a browser.
  const browserWindows = windows.filter((w) => BROWSERS.includes(w.exe));
  for (const web of WEB_APPS) {
    if (found.has(web.id)) continue;
    const strong = browserWindows.find((w) => matchAny(web.strong, w.title));
    if (strong) {
      add(web.id, web.name, stripBrowserSuffix(strong.title), 'browser');
      continue;
    }
    const hit = browserWindows.find((w) => micExes.has(w.exe) && matchAny(web.titles, w.title));
    if (hit) add(web.id, web.name, stripBrowserSuffix(hit.title), 'browser');
  }

  return [...found.values()];
}

// PowerShell scanner. Prints {"mic":[...],"win":[{"p":..,"t":..}]} per scan
// and exits by itself when the dashboard process is gone.
function scannerScript(intervalMs, parentPid) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class RtaiWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> List() {
    var r = new List<string>();
    EnumProc cb = (h, p) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      r.Add(wpid.ToString() + "\\t" + sb.ToString());
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    return r;
  }
}
"@
$base = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
function Get-MicApps {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($k in (Get-ChildItem -Path $base)) {
    if ($k.PSChildName -eq 'NonPackaged') {
      foreach ($s in (Get-ChildItem -Path $k.PSPath)) {
        $v = (Get-ItemProperty -Path $s.PSPath).LastUsedTimeStop
        if ($v -ne $null -and $v -eq 0) { $out.Add($s.PSChildName) }
      }
    } else {
      $v = (Get-ItemProperty -Path $k.PSPath).LastUsedTimeStop
      if ($v -ne $null -and $v -eq 0) { $out.Add($k.PSChildName) }
    }
  }
  return ,$out.ToArray()
}
while ($true) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
  $names = @{}
  foreach ($p in (Get-Process)) { $names[[uint32]$p.Id] = $p.ProcessName }
  $wins = New-Object System.Collections.Generic.List[object]
  foreach ($line in [RtaiWin]::List()) {
    $i = $line.IndexOf([char]9)
    if ($i -lt 1) { continue }
    $wid = [uint32]$line.Substring(0, $i)
    $wins.Add(@{ p = [string]$names[$wid]; t = $line.Substring($i + 1) })
  }
  $o = @{ mic = (Get-MicApps); win = $wins.ToArray() }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(1000, Number(intervalMs) || 3000)}
}
`;
}

class MeetingDetector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.intervalMs = opts.intervalMs || 3000;
    this.startScans = opts.startScans || 2; // seen this many scans in a row -> started
    this.endScans = opts.endScans || 3; // missing this many in a row -> ended
    this._spawn = opts.spawn || spawn;
    this._proc = null;
    this._buf = '';
    this._seen = new Map(); // id -> consecutive scans seen
    this._missing = new Map(); // id -> consecutive scans missing
    this._active = new Map(); // id -> meeting
    this._restartTimer = null;
    this._running = false;
    this._failures = 0;
  }

  get active() {
    return [...this._active.values()];
  }

  start() {
    if (this._running) return;
    this._running = true;
    if (process.platform !== 'win32' && !this._spawnOverridden()) return; // Windows only
    this._launch();
  }

  stop() {
    this._running = false;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = null;
    if (this._proc) {
      try { this._proc.kill(); } catch (_e) {}
    }
    this._proc = null;
    for (const m of this._active.values()) this.emit('meeting-ended', m);
    this._active.clear();
    this._seen.clear();
    this._missing.clear();
  }

  _spawnOverridden() {
    return this._spawn !== spawn;
  }

  _launch() {
    const script = scannerScript(this.intervalMs, process.pid);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let proc;
    try {
      proc = this._spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.emit('error', err);
      this._scheduleRestart();
      return;
    }
    this._proc = proc;
    this._buf = '';
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    if (proc.stderr) proc.stderr.on('data', () => {});
    proc.on('error', (err) => this.emit('error', err));
    proc.on('exit', () => {
      if (this._proc === proc) this._proc = null;
      if (this._running) this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (!this._running || this._restartTimer) return;
    this._failures += 1;
    const delay = Math.min(60000, 2000 * this._failures);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._running) this._launch();
    }, delay);
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    const lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        this.feed(JSON.parse(s));
        this._failures = 0;
      } catch (_e) {}
    }
  }

  /** Feed one scan (exposed for tests). */
  feed(snapshot) {
    const now = classifySnapshot(snapshot);
    const nowIds = new Set(now.map((m) => m.id));
    for (const m of now) {
      this._missing.delete(m.id);
      const n = (this._seen.get(m.id) || 0) + 1;
      this._seen.set(m.id, n);
      if (this._active.has(m.id)) {
        // Keep the freshest title (Meet puts the room name in it once joined).
        const cur = this._active.get(m.id);
        if (m.title && m.title !== cur.title) {
          cur.title = m.title;
          this.emit('meeting-updated', cur);
        }
      } else if (n >= this.startScans) {
        const meeting = { ...m, startedAt: Date.now() };
        this._active.set(m.id, meeting);
        this.emit('meeting-started', meeting);
      }
    }
    for (const id of [...this._seen.keys()]) {
      if (nowIds.has(id)) continue;
      const miss = (this._missing.get(id) || 0) + 1;
      this._missing.set(id, miss);
      if (miss >= this.endScans) {
        this._seen.delete(id);
        this._missing.delete(id);
        const ended = this._active.get(id);
        if (ended) {
          this._active.delete(id);
          this.emit('meeting-ended', ended);
        }
      } else if (!this._active.has(id)) {
        this._seen.delete(id); // a blip that never became a meeting
        this._missing.delete(id);
      }
    }
    return now;
  }
}

module.exports = {
  MeetingDetector,
  classifySnapshot,
  parseMicEntry,
  stripBrowserSuffix,
  scannerScript,
  DESKTOP_APPS,
  WEB_APPS,
  APP_NAMES
};
