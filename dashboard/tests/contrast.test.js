const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Helper to parse CSS custom properties from :root or .dark block
function parseTokens(css, selector) {
  const regex = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(regex);
  if (!match) return {};
  const tokens = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*')) continue;
    const parts = trimmed.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts.slice(1).join(':').trim();
      if (val.endsWith(';')) val = val.slice(0, -1).trim();
      tokens[key] = val;
    }
  }
  return tokens;
}

// Convert HSL string "H S% L%" to relative luminance per WCAG 2.1
function hslToLuminance(hslStr) {
  const parts = hslStr.trim().split(/\s+/);
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1].replace('%', '')) / 100;
  const l = parseFloat(parts[2].replace('%', '')) / 100;

  // HSL to RGB
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let rPrime = 0, gPrime = 0, bPrime = 0;
  if (h >= 0 && h < 60) {
    rPrime = c; gPrime = x; bPrime = 0;
  } else if (h >= 60 && h < 120) {
    rPrime = x; gPrime = c; bPrime = 0;
  } else if (h >= 120 && h < 180) {
    rPrime = 0; gPrime = c; bPrime = x;
  } else if (h >= 180 && h < 240) {
    rPrime = 0; gPrime = x; bPrime = c;
  } else if (h >= 240 && h < 300) {
    rPrime = x; gPrime = 0; bPrime = c;
  } else if (h >= 300 && h < 360) {
    rPrime = c; gPrime = 0; bPrime = x;
  }

  const r = rPrime + m;
  const g = gPrime + m;
  const b = bPrime + m;

  // sRGB to linear RGB
  const toLinear = (val) => {
    return val <= 0.04045 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  };

  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);

  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// Calculate contrast ratio between two luminance values
function contrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

const inputCssPath = path.resolve(__dirname, '../src/tailwind.input.css');

test('Feature: dashboard-ui-redesign, Property 1: Contraste de texto atende AA nos dois temas', () => {
  const css = fs.readFileSync(inputCssPath, 'utf8');
  const lightTokens = parseTokens(css, ':root');
  const darkTokens = parseTokens(css, '.dark');

  // Text pairs that must meet WCAG AA normal text contrast >= 4.5:1
  const pairsToCheck = [
    { text: '--foreground', surface: '--background', desc: 'foreground over background' },
    { text: '--foreground', surface: '--card', desc: 'foreground over card' },
    { text: '--muted-foreground', surface: '--background', desc: 'muted-foreground over background' },
    { text: '--primary-foreground', surface: '--primary', desc: 'primary-foreground over primary' }
  ];

  // Run property-based check for >= 100 iterations
  for (let i = 0; i < 100; i++) {
    const pair = pairsToCheck[i % pairsToCheck.length];

    // Check light theme
    const lightTextLum = hslToLuminance(lightTokens[pair.text]);
    const lightSurfLum = hslToLuminance(lightTokens[pair.surface]);
    const lightRatio = contrastRatio(lightTextLum, lightSurfLum);
    assert.ok(
      lightRatio >= 4.5,
      `Property 1 violation in Light Theme: ${pair.desc} has contrast ${lightRatio.toFixed(2)}:1, expected >= 4.5:1 (iteration ${i + 1})`
    );

    // Check dark theme
    const darkTextLum = hslToLuminance(darkTokens[pair.text]);
    const darkSurfLum = hslToLuminance(darkTokens[pair.surface]);
    const darkRatio = contrastRatio(darkTextLum, darkSurfLum);
    assert.ok(
      darkRatio >= 4.5,
      `Property 1 violation in Dark Theme: ${pair.desc} has contrast ${darkRatio.toFixed(2)}:1, expected >= 4.5:1 (iteration ${i + 1})`
    );
  }
});

test('Feature: dashboard-ui-redesign, Property 2: Contraste do indicador de foco atende AA', () => {
  const css = fs.readFileSync(inputCssPath, 'utf8');
  const lightTokens = parseTokens(css, ':root');
  const darkTokens = parseTokens(css, '.dark');

  // Focus ring pairs that must meet WCAG AA graphical elements/focus contrast >= 3.0:1
  const focusSurfaces = ['--background', '--card'];

  // Run property-based check for >= 100 iterations
  for (let i = 0; i < 100; i++) {
    const surfaceToken = focusSurfaces[i % focusSurfaces.length];

    // Light theme ring contrast
    const lightRingLum = hslToLuminance(lightTokens['--ring']);
    const lightSurfLum = hslToLuminance(lightTokens[surfaceToken]);
    const lightRatio = contrastRatio(lightRingLum, lightSurfLum);
    assert.ok(
      lightRatio >= 3.0,
      `Property 2 violation in Light Theme: focus ring against ${surfaceToken} has contrast ${lightRatio.toFixed(2)}:1, expected >= 3.0:1 (iteration ${i + 1})`
    );

    // Dark theme ring contrast
    const darkRingLum = hslToLuminance(darkTokens['--ring']);
    const darkSurfLum = hslToLuminance(darkTokens[surfaceToken]);
    const darkRatio = contrastRatio(darkRingLum, darkSurfLum);
    assert.ok(
      darkRatio >= 3.0,
      `Property 2 violation in Dark Theme: focus ring against ${surfaceToken} has contrast ${darkRatio.toFixed(2)}:1, expected >= 3.0:1 (iteration ${i + 1})`
    );
  }
});

