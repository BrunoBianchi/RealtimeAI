const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const stylesCssPath = path.resolve(__dirname, '../src/renderer/styles.css');

test('Task 6.2: Snapshot e validação do styles.css gerado (Requirements: 1.1, 2.1, 3.1)', () => {
  assert.ok(fs.existsSync(stylesCssPath), 'dashboard/src/styles.css must exist');
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // Req 1.1: --radius: .375rem or 0.375rem in minified css
  assert.ok(
    css.includes('--radius:.375rem') || css.includes('--radius:0.375rem'),
    'styles.css must contain --radius:.375rem'
  );

  // Req 2.1: --primary: 221 83% 53% (light) and 213 94% 68% (dark)
  assert.ok(
    css.includes('221 83% 53%'),
    'styles.css must contain light theme primary/ring color 221 83% 53%'
  );
  assert.ok(
    css.includes('213 94% 68%'),
    'styles.css must contain dark theme primary/ring color 213 94% 68%'
  );

  // Req 2.3: --live and --destructive are 347 77% 50%
  assert.ok(
    css.includes('347 77% 50%'),
    'styles.css must contain live and destructive color 347 77% 50%'
  );

  // Verify essential component and utility classes exist (no purge regressions)
  const requiredClasses = [
    '.sh-btn',
    '.sh-btn-primary',
    '.sh-btn-live',
    '.sh-btn-secondary',
    '.sh-btn-outline',
    '.sh-input',
    '.sh-textarea',
    '.sh-card',
    '.sh-nav-item',
    '.settings-subnav-btn',
    '.library-tab',
    '.kbd-badge',
    '.rounded-lg',
    '.rounded-md',
    '.rounded-full'
  ];

  for (const cls of requiredClasses) {
    assert.ok(
      css.includes(cls),
      `styles.css must retain required class: ${cls}`
    );
  }
});

