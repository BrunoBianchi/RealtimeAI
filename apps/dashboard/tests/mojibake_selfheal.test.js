// Self-heal of cp1252 double-encoded ("mojibake") agent data: agent files
// written by older builds carry UTF-8 text that was decoded as Windows-1252
// and re-encoded as UTF-8 ("Nubank Â· EstÃ¡gio" instead of "Nubank · Estágio").
// The repair lives in apps/dashboard/src/main/main.js (healAgentStrings) and
// in the native engine (src/core/include/rtai/text_util.hpp) so both sides
// converge on clean data. These tests pin the detection rules: repair real
// mojibake, never touch legitimate text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

// Extract the helpers from main.js without booting Electron: evaluate just
// the helper block between its markers.
const helperStart = mainJs.indexOf('const CP1252_REVERSE');
const helperEnd = mainJs.indexOf('function loadAllAgents()');
assert.ok(helperStart > 0 && helperEnd > helperStart, 'helper block must exist in main.js');
const helperBlock = mainJs.slice(helperStart, helperEnd);
const helpers = new Function(`${helperBlock}; return { looksDoubleEncoded, repairDoubleEncoded, healAgentStrings };`)();

test('Feature: mojibake-self-heal, Property 1: detecta e repara nome double-encoded real', () => {
  // Exact corrupted bytes found on disk (double-encoded "Nubank · Estágio ...").
  const corrupted = 'Nubank \u00C2\u00B7 Est\u00C3\u00A1gio em Engenharia de Software';
  assert.ok(helpers.looksDoubleEncoded(corrupted), 'corrupted name must be detected');
  assert.strictEqual(
    helpers.repairDoubleEncoded(corrupted),
    'Nubank \u00B7 Est\u00E1gio em Engenharia de Software'
  );
});

test('Feature: mojibake-self-heal, Property 2: repara "AÃ§Ã£o" e travessão', () => {
  assert.strictEqual(helpers.repairDoubleEncoded('A\u00C3\u00A7\u00C3\u00A3o'), 'A\u00E7\u00E3o');
  // "â€”" is the double-encoded form of "—".
  assert.strictEqual(helpers.repairDoubleEncoded('fundo \u00E2\u20AC\u201D precisa'), 'fundo \u2014 precisa');
});

test('Feature: mojibake-self-heal, Property 3: texto limpo nunca é alterado (idempotência)', () => {
  const clean = [
    'Analista de Dados Sr.',
    'Voc\u00EA n\u00E3o precisa saber tudo',
    'Tech Lead \u00B7 Java & Arquitetura',
    'Situa\u00E7\u00E3o, Tarefa, A\u00E7\u00E3o, Resultado',
    'Backend Pleno - Go',
    ''
  ];
  for (const s of clean) {
    // The observable contract: clean text never changes. (looksDoubleEncoded
    // is only a cheap pre-filter; the decision happens in repairDoubleEncoded
    // via the strict round-trip shrink test.)
    assert.strictEqual(helpers.repairDoubleEncoded(s), s, `clean text must not change: ${s}`);
  }
});

test('Feature: mojibake-self-heal, Property 4: texto grego/cirílico legítimo não é tocado', () => {
  const greek = '\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC';
  const cyrillic = '\u041F\u0440\u0438\u0432\u0435\u0442';
  assert.strictEqual(helpers.repairDoubleEncoded(greek), greek);
  assert.strictEqual(helpers.repairDoubleEncoded(cyrillic), cyrillic);
});

test('Feature: mojibake-self-heal, Property 5: healAgentStrings cura campos do agente', () => {
  const ag = {
    name: 'Nubank \u00C2\u00B7 Est\u00C3\u00A1gio',
    company: 'Nubank',
    role: 'Est\u00E1gio',
    custom_instructions: 'Use o formato STAR (Contexto, A\u00C3\u00A7\u00C3\u00A3o, Resultado)',
    documents: [{ name: 'doc.md', content: 'Conte\u00C3\u00BAdo' }]
  };
  const changed = helpers.healAgentStrings(ag);
  assert.ok(changed, 'agent with mojibake must report changed=true');
  assert.strictEqual(ag.name, 'Nubank \u00B7 Est\u00E1gio');
  assert.strictEqual(ag.custom_instructions, 'Use o formato STAR (Contexto, A\u00E7\u00E3o, Resultado)');
  assert.strictEqual(ag.documents[0].content, 'Conte\u00FAdo');
  assert.strictEqual(ag.company, 'Nubank');
  assert.strictEqual(ag.role, 'Est\u00E1gio');
});

test('Feature: mojibake-self-heal, Property 6: healAgentStrings não altera agente limpo', () => {
  const ag = {
    name: 'Analista de Dados Sr.',
    company: 'Ita\u00FA',
    role: 'Dados',
    documents: [{ name: 'cv.md', content: 'Engenheiro de Software' }]
  };
  const before = JSON.stringify(ag);
  const changed = helpers.healAgentStrings(ag);
  assert.ok(!changed, 'clean agent must report changed=false');
  assert.strictEqual(JSON.stringify(ag), before);
});

test('Feature: mojibake-self-heal, Property 7: loadAllAgents chama o self-heal e persiste', () => {
  // The wiring itself: the loader must invoke healAgentStrings right after
  // parsing each agent file and write the file back when it changed.
  assert.ok(
    mainJs.includes('if (healAgentStrings(data))'),
    'loadAllAgents must call healAgentStrings and persist on change'
  );
  assert.ok(
    /fs\.writeFileSync\(fullPath, JSON\.stringify\(data, null, 2\), 'utf8'\);/.test(mainJs),
    'repaired agent must be written back as UTF-8 JSON'
  );
});

test('Feature: mojibake-self-heal, Property 8: build:css roda sem warning do Browserslist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['build:css'], 'node ../../scripts/run-tailwind-css.mjs && npm run build:liveavatar');
  assert.ok(
    fs.existsSync(path.resolve(__dirname, '../../../scripts/run-tailwind-css.mjs')),
    'run-tailwind-css.mjs wrapper must exist'
  );
  const wrapper = fs.readFileSync(path.resolve(__dirname, '../../../scripts/run-tailwind-css.mjs'), 'utf8');
  assert.ok(wrapper.includes('BROWSERSLIST_IGNORE_OLD_DATA'), 'wrapper must set the env escape hatch');
  assert.ok(wrapper.includes('--no-autoprefixer'), 'wrapper must skip autoprefixer (Electron target)');
});
