// Behavior tests (not string checks) for:
//   * goal answer settings (playbook, answer language, coding language) that
//     reverted on save because the stale nested copy won over the edited field;
//   * inheritance of documents between goals (only the candidate's own files);
//   * PDF extraction: spaces between items, two-column résumés, wrapped lines,
//     headers/footers/page numbers, scanned PDFs detected for OCR;
//   * DOCX extraction from the ZIP central directory with XML entities.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-dash-'));
process.env.LOCALAPPDATA = tmp;
process.env.RTAI_TEST_EXPORTS = '1';

// Minimal 'electron' so main.js can be required outside Electron.
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
  BrowserWindow: function () {},
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
  nativeTheme: { shouldUseDarkColors: true },
  Notification: { isSupported: () => false }
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return realLoad.call(this, request, ...rest);
};
const main = require('../main.js');
Module._load = realLoad;
const pdfText = require('../pdf_text.js');
const fixtures = path.join(__dirname, 'fixtures');

function readGoal(id) {
  return JSON.parse(fs.readFileSync(path.join(tmp, 'RealTimeAI', 'agents', `${id}.json`), 'utf8'));
}

test('playbook, answer language and coding language persist over the stale nested copy', () => {
  const first = main.saveAgentToDisk({
    id: 'nubank',
    company: 'Nubank',
    role: 'Estágio',
    documents: [{ title: 'cv.pdf', tag: 'resume', content: 'Eu desenvolvi o TechFinance App em Node.js.' }]
  });
  assert.strictEqual(first.playbook_name, 'Standard STAR');

  // What the UI does: load the goal (it carries the nested copies), change the
  // flat fields and save.
  const loaded = main.loadAllAgents().find((a) => a.id === 'nubank');
  assert.ok(loaded.playbook && loaded.playbook.name === 'Standard STAR', 'loaded goal has the nested copy');
  loaded.playbook_name = 'Executive STAR';
  loaded.playbook_answer_length = 'Concise';
  loaded.playbook_behavioral_structure = 'Executive STAR (Impact-first)';
  loaded.playbook_lead_with_answer = true;
  loaded.playbook_name_tradeoffs = true;
  loaded.answer_language = 'en-US';
  loaded.coding_language = 'Python';
  const saved = main.saveAgentToDisk(loaded);

  assert.strictEqual(saved.playbook_name, 'Executive STAR');
  assert.strictEqual(saved.playbook_answer_length, 'Concise');
  assert.strictEqual(saved.answer_language, 'en-US');
  assert.strictEqual(saved.coding_language, 'Python');

  const disk = readGoal('nubank');
  assert.strictEqual(disk.playbook_name, 'Executive STAR');
  assert.strictEqual(disk.playbook.name, 'Executive STAR', 'nested copy follows the edit');
  assert.strictEqual(disk.playbook.answer_length, 'Concise');
  assert.strictEqual(disk.playbook_name_tradeoffs, true);
  assert.strictEqual(disk.answer_language, 'en-US');
  assert.strictEqual(disk.response_defaults.answer_language, 'en-US');
  assert.strictEqual(disk.coding_language, 'Python');
  assert.strictEqual(disk.response_defaults.coding_language, 'Python');

  // Back to "Auto / Match the job" (empty string) must also stick.
  const again = main.loadAllAgents().find((a) => a.id === 'nubank');
  again.coding_language = '';
  main.saveAgentToDisk(again);
  assert.strictEqual(readGoal('nubank').coding_language, '');
  assert.strictEqual(readGoal('nubank').response_defaults.coding_language, '');
});

test('a new goal inherits only the candidate files of another goal', () => {
  main.saveAgentToDisk({
    id: 'itau',
    company: 'Itaú',
    documents: [
      { title: 'Curriculo_Bruno.pdf', tag: 'resume', content: 'Eu desenvolvi pipelines em Python na Vertis.' },
      { title: 'Itau_cultura.pdf', tag: 'material', content: 'O Itaú valoriza o cliente. Cultura Itaú.' },
      { title: 'Vaga_Itau.txt', tag: 'job', content: 'Requisitos da vaga: Java.' }
    ]
  });
  const fresh = main.saveAgentToDisk({ id: 'stone', company: 'Stone', documents: [] });
  const titles = fresh.documents.map((d) => d.title);
  assert.ok(titles.includes('Curriculo_Bruno.pdf'), titles.join(','));
  assert.ok(!titles.includes('Itau_cultura.pdf'), 'another company material leaked');
  assert.ok(!titles.includes('Vaga_Itau.txt'), 'another job description leaked');
});

test('PDF: words on the same line are separated (no "Softwarejun/2026")', async () => {
  const r = await pdfText.extractPdfText(fs.readFileSync(path.join(fixtures, 'one_column.pdf')));
  assert.ok(r.text.includes('Engenheiro de Software jun/2026'), r.text.slice(0, 300));
  assert.ok(!/Softwarejun/.test(r.text));
  // Wrapped lines become one paragraph.
  assert.ok(r.text.includes('com o time profissional da Midea e uma equipe de cinco estudantes'), r.text);
  assert.ok(r.text.includes('82% das transações'));
  assert.strictEqual(pdfText.looksScanned(r), false);
});

test('PDF: a two-column résumé is read column by column', async () => {
  const r = await pdfText.extractPdfText(fs.readFileSync(path.join(fixtures, 'two_column.pdf')));
  const exp = r.text.indexOf('EXPERIÊNCIA');
  const skills = r.text.indexOf('HABILIDADES');
  assert.ok(exp > 0 && skills >= 0);
  // The experience paragraph must come out whole, not interleaved with the sidebar.
  assert.ok(
    r.text.includes('Construí pipelines em Python para grandes volumes de dados e monitoramento de redes 5G'),
    r.text
  );
  // Sidebar text comes as its own block, before or after the main column.
  assert.ok(r.text.includes('Português nativo, inglês profissional e francês elementar.'), r.text);
});

test('PDF: headers, footers and page numbers are removed; paragraphs survive page breaks', async () => {
  const r = await pdfText.extractPdfText(fs.readFileSync(path.join(fixtures, 'multipage.pdf')));
  assert.strictEqual(r.pages, 3);
  assert.ok(!r.text.includes('Cultura e Valores'), 'repeated header kept');
  assert.ok(!r.text.split('\n').some((l) => /^\d+$/.test(l.trim())), 'page number kept');
  const paras = r.text.split('\n\n');
  assert.strictEqual(paras.length, 27);
  for (const p of paras) {
    assert.match(p.trim(), /^Valor \d+, .*produto\.$/s, p.slice(0, 120));
  }
});

test('PDF: a scanned PDF is detected so it goes to OCR', async () => {
  const r = await pdfText.extractPdfText(fs.readFileSync(path.join(fixtures, 'scanned.pdf')));
  assert.strictEqual(pdfText.looksScanned(r), true);
});

test('PDF OCR request uses the OpenRouter file-parser with the PDF as a data URL', async () => {
  let sent = null;
  const fakeHttps = {
    request: (_url, _opts, cb) => {
      const req = {
        on: () => req,
        write: (body) => {
          sent = JSON.parse(body);
        },
        end: () => {
          const res = {
            on: (ev, fn) => {
              if (ev === 'data') fn(Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Texto OCR' } }] })));
              if (ev === 'end') fn();
              return res;
            }
          };
          cb(res);
        },
        destroy: () => {}
      };
      return req;
    }
  };
  const out = await pdfText.ocrPdfWithOpenRouter(Buffer.from('%PDF-1.4 fake'), 'cv.pdf', 'sk-test', fakeHttps);
  assert.strictEqual(out, 'Texto OCR');
  assert.deepStrictEqual(sent.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  const file = sent.messages[0].content.find((c) => c.type === 'file');
  assert.strictEqual(file.file.filename, 'cv.pdf');
  assert.ok(file.file.file_data.startsWith('data:application/pdf;base64,'));
  assert.strictEqual(await pdfText.ocrPdfWithOpenRouter(Buffer.from('x'), 'a.pdf', '', fakeHttps), '', 'no key, no call');
});

test('PDF text cleanup: ligatures, hyphenation, bullets', () => {
  const raw = 'Desenvolvi a deﬁnição do desenvol-\nvimento do serviço de\npagamentos.\n Item um\n● Item dois\n';
  const t = pdfText.cleanPdfText(raw);
  assert.ok(t.includes('definição'), t);
  assert.ok(t.includes('desenvolvimento do serviço de pagamentos.'), t);
  assert.ok(t.includes('• Item um\n• Item dois'), t);
});

test('extractDocumentContent uses the new PDF reader end to end', async () => {
  const r = await main.extractDocumentContent(path.join(fixtures, 'one_column.pdf'));
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.content.includes('Engenheiro de Software jun/2026'));
});

test('DOCX: read through the central directory, entities decoded', () => {
  // Build a minimal .docx whose local header sizes are 0 (data descriptor style).
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>P&amp;D em IA &lt;tempo real&gt;</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Segunda</w:t></w:r><w:r><w:tab/><w:t>linha</w:t></w:r></w:p></w:body></w:document>';
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 6); // flag: data descriptor
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, name, data]);
  const centralPart = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  const docx = Buffer.concat([localPart, centralPart, eocd]);
  const text = main.extractTextFromDocx(docx);
  assert.ok(text.includes('P&D em IA <tempo real>'), text);
  assert.ok(/Segunda\s+linha/.test(text), text);
});

test('the old built-in sample resume is never kept or inherited', () => {
  const agentsDir = path.join(tmp, 'RealTimeAI', 'agents');
  // A goal saved by an older version, still carrying the fake starter resume.
  fs.writeFileSync(
    path.join(agentsDir, 'entrevista-principal.json'),
    JSON.stringify({
      id: 'entrevista-principal',
      name: 'Entrevista Principal',
      company: 'Nubank / Big Tech',
      documents: [
        {
          title: 'Resumo_Curriculo_e_Projetos.md',
          tag: 'resume',
          content:
            'Engenheiro de Software com foco em sistemas de tempo real (C++20, Node.js, Python, Rust), arquitetura distribuída de baixa latência (<50ms).'
        }
      ]
    })
  );
  const loaded = main.loadAllAgents().find((a) => a.id === 'entrevista-principal');
  assert.ok(!loaded.documents.some((d) => d.title === 'Resumo_Curriculo_e_Projetos.md'), 'sample resume kept');
  for (const a of main.loadAllAgents()) {
    for (const d of main.inheritableDocuments(a)) {
      assert.ok(!String(d.content).startsWith('Engenheiro de Software com foco em sistemas de tempo real'));
    }
  }
});
