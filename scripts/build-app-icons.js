const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tileBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#141d16"/>
      <stop offset="50%" stop-color="#0c120e"/>
      <stop offset="100%" stop-color="#060907"/>
    </linearGradient>
    <radialGradient id="ambientGlow" cx="50%" cy="46%" r="50%">
      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="#22c55e" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#22c55e" stop-opacity="0.18"/>
    </linearGradient>
  </defs>

  <rect x="28" y="28" width="456" height="456" rx="104" ry="104" fill="url(#tileBg)"/>
  <rect x="28" y="28" width="456" height="456" rx="104" ry="104" fill="url(#ambientGlow)"/>
  <rect x="28" y="28" width="456" height="456" rx="104" ry="104" fill="none" stroke="url(#topHighlight)" stroke-width="2"/>
  <rect x="28" y="28" width="456" height="456" rx="104" ry="104" fill="none" stroke="url(#borderGrad)" stroke-width="4.5"/>

  <g transform="translate(60, 64) scale(2.72)">
    <path
      d="M22 34C22 22.954 30.954 14 42 14H101C112.046 14 121 22.954 121 34V78C121 89.046 112.046 98 101 98H65L40 120V98H42C30.954 98 22 89.046 22 78V34Z"
      stroke="#22c55e"
      stroke-width="7.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
    />
    <path d="M49 53V65" stroke="#ffffff" stroke-width="8.5" stroke-linecap="round"/>
    <path d="M69 42V76" stroke="#ffffff" stroke-width="8.5" stroke-linecap="round"/>
    <path d="M89 49V69" stroke="#22c55e" stroke-width="8.5" stroke-linecap="round"/>
    <path d="M109 37V81" stroke="#22c55e" stroke-width="8.5" stroke-linecap="round"/>
  </g>
</svg>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 250));

  const image = await win.capturePage();
  const out512 = path.join(__dirname, 'icon-512.png');
  fs.writeFileSync(out512, image.toPNG());
  console.log('RENDER_DONE_512:', out512);

  // Now render tray icon (pure crisp outline symbol on transparent background)
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 144 144">
    <path
      d="M22 34C22 22.954 30.954 14 42 14H101C112.046 14 121 22.954 121 34V78C121 89.046 112.046 98 101 98H65L40 120V98H42C30.954 98 22 89.046 22 78V34Z"
      stroke="#22c55e"
      stroke-width="11"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
    />
    <path d="M49 53V65" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>
    <path d="M69 42V76" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>
    <path d="M89 49V69" stroke="#22c55e" stroke-width="12" stroke-linecap="round"/>
    <path d="M109 37V81" stroke="#22c55e" stroke-width="12" stroke-linecap="round"/>
  </svg>`;

  await win.setSize(32, 32);
  const trayHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden">${traySvg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayHtml));
  await new Promise(r => setTimeout(r, 200));

  const tray32 = await win.capturePage();
  const outTray32 = path.join(__dirname, 'tray-32.png');
  fs.writeFileSync(outTray32, tray32.toPNG());

  await win.setSize(16, 16);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayHtml));
  await new Promise(r => setTimeout(r, 200));

  const tray16 = await win.capturePage();
  const outTray16 = path.join(__dirname, 'tray-16.png');
  fs.writeFileSync(outTray16, tray16.toPNG());

  console.log('TRAY_ICONS_DONE');
  app.quit();
});
