// When Orby's voice (server TTS) fails, the system voice reads the sentence,
// so an Advanced interview is never silent (renderer/mock.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mock.js'), 'utf8');
const ptBR = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'locales', 'pt-BR.js'), 'utf8');
const NOTICE = "Orby's voice is unavailable right now, so the system voice is reading the questions.";

test('a failed clip falls back to the system voice in the interview language, with a notice once', () => {
  const speak = src.slice(src.indexOf('function speakSentence('), src.indexOf('async function runTurn('));
  assert.match(speak, /if \(!bytes\) \{[\s\S]*speakWithSystemVoice\(text\)/);
  assert.match(speak, /M\.voiceFallback = true/);
  assert.ok(speak.includes(NOTICE));
  const fallback = src.slice(src.indexOf('function speakWithSystemVoice('), src.indexOf('function speakSentence('));
  assert.match(fallback, /u\.lang = M\.lang/);
  assert.match(fallback, /setTimeout\(resolve/, 'a voice that never ends cannot hold the interview');
  assert.match(src, /M\.voiceFallback = false/, 'each interview starts with Orby\'s own voice');
  assert.match(src, /window\.speechSynthesis\.cancel\(\)/, 'ending the interview stops the system voice');
  assert.ok(ptBR.includes(JSON.stringify(NOTICE)) || ptBR.includes(`"${NOTICE}"`), 'pt-BR entry');
});
