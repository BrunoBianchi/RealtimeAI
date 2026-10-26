'use strict';
// PDF -> clean text for the RAG.
//
// pdf-parse's default page renderer glued text items on the same line with no
// space ("Desenvolviuma API"), interleaved the two columns of a résumé line by
// line, and kept hyphenation, ligatures, page numbers and repeated headers.
// This renderer rebuilds the reading order from the item positions:
//   * columns: a vertical gutter crossed by (almost) no text splits the page,
//     and each column is read top to bottom;
//   * spaces: inserted from the horizontal gap between items;
//   * paragraphs: a vertical gap larger than the usual line spacing;
// then cleans the text (ligatures, hyphenation, wrapped lines, bullets,
// page numbers, headers/footers repeated on most pages).

let pdfParseLib = null;
function getPdfParse() {
  if (pdfParseLib) return pdfParseLib;
  try {
    // The inner module avoids pdf-parse's index.js debug harness.
    pdfParseLib = require('pdf-parse/lib/pdf-parse.js');
  } catch (_e) {
    pdfParseLib = null;
  }
  return pdfParseLib;
}

const PAGE_BREAK = '\n\u000C\n';

function itemBox(it) {
  const t = it.transform || [1, 0, 0, 1, 0, 0];
  const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || Math.abs(t[0]) || 10;
  const x = t[4];
  const y = t[5];
  const w = typeof it.width === 'number' && it.width > 0 ? it.width : size * 0.5 * String(it.str || '').length;
  return { str: String(it.str || ''), x, y, w, x1: x + w, size };
}

// Finds a vertical gutter that splits the page into two columns.
function findGutter(items, pageWidth) {
  if (items.length < 20 || !(pageWidth > 0)) return null;
  const textItems = items.filter((i) => i.str.trim());
  let best = null;
  for (let pct = 0.22; pct <= 0.78; pct += 0.01) {
    const x = pageWidth * pct;
    let crossing = 0;
    let left = 0;
    let right = 0;
    for (const it of textItems) {
      const chars = it.str.trim().length;
      if (it.x < x - 1 && it.x1 > x + 1) crossing += chars;
      else if (it.x1 <= x + 1) left += chars;
      else right += chars;
    }
    // Weighted by text, not by item count: a résumé with right-aligned dates
    // ("jan/2022 - atual") is one column, the dates are a small share of it.
    const n = left + right + crossing;
    if (crossing > n * 0.02) continue;
    if (left < n * 0.2 || right < n * 0.2) continue;
    // Width of the empty band around x: prefer the widest gutter.
    let gapL = 0;
    let gapR = pageWidth;
    for (const it of textItems) {
      if (it.x1 <= x + 1) gapL = Math.max(gapL, it.x1);
      if (it.x >= x - 1) gapR = Math.min(gapR, it.x);
    }
    const band = gapR - gapL;
    if (band < 8) continue;
    if (!best || band > best.band) best = { x: (gapL + gapR) / 2, band };
  }
  return best ? best.x : null;
}

// Rebuilds the lines of one column (items already filtered to it).
function renderColumn(items) {
  if (!items.length) return '';
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.length ? lines[lines.length - 1] : null;
    const tol = Math.max(1.5, Math.min(it.size, line ? line.size : it.size) * 0.45);
    if (line && Math.abs(line.y - it.y) <= tol) {
      line.items.push(it);
      line.size = Math.max(line.size, it.size);
    } else {
      lines.push({ y: it.y, size: it.size, items: [it] });
    }
  }
  const textLines = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let s = '';
    let prev = null;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - prev.x1;
        const needSpace = gap > Math.min(prev.size, it.size) * 0.18;
        // Any visible gap is a word break ("Software" ... "jun/2026" used to
        // come out glued as "Softwarejun/2026").
        if (needSpace && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      }
      s += it.str;
      prev = it;
    }
    textLines.push({ y: line.y, size: line.size, text: s.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '') });
  }
  // Paragraph breaks from vertical gaps.
  const gaps = [];
  for (let i = 1; i < textLines.length; i += 1) gaps.push(textLines[i - 1].y - textLines[i].y);
  const typical = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  let out = '';
  for (let i = 0; i < textLines.length; i += 1) {
    if (i > 0) {
      const gap = textLines[i - 1].y - textLines[i].y;
      out += typical > 0 && gap > typical * 1.55 ? '\n\n' : '\n';
    }
    out += textLines[i].text;
  }
  return out;
}

function renderPageItems(rawItems, pageWidth) {
  const items = rawItems.map(itemBox).filter((i) => i.str.length > 0);
  const gutter = findGutter(items, pageWidth);
  if (gutter === null) return renderColumn(items);
  const left = items.filter((i) => i.x1 <= gutter + 1 || (i.x < gutter && i.x1 - gutter < gutter - i.x));
  const right = items.filter((i) => !left.includes(i));
  return `${renderColumn(left)}\n\n${renderColumn(right)}`;
}

function pageRenderer(pageData) {
  let width = 0;
  try {
    const vp = pageData.getViewport(1);
    width = vp && vp.width ? vp.width : 0;
  } catch (_e) {
    width = 0;
  }
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((tc) => renderPageItems(tc.items || [], width) + PAGE_BREAK);
}

const LIGATURES = {
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st'
};
const BULLET_RE = /^\s*(?:[•●○◦▪▫■□►▶➢➤✓✔‣⁃∙·]|[-*–](?=\s)||||)\s*/u;
const LINE_END_RE = /[.!?:;)\]]["'”’]?$/;

function isPageNumber(line) {
  const s = line.trim();
  return (
    /^\d{1,3}$/.test(s) ||
    /^(p[aá]g(ina)?\.?|page)\s*\d{1,3}(\s*(de|of|\/)\s*\d{1,3})?$/i.test(s) ||
    /^\d{1,3}\s*(\/|de|of)\s*\d{1,3}$/i.test(s) ||
    /^[-–]\s*\d{1,3}\s*[-–]$/.test(s)
  );
}

// Lines that repeat on most pages (headers/footers) are dropped.
function repeatedLines(pages) {
  if (pages.length < 3) return new Set();
  const counts = new Map();
  for (const p of pages) {
    const seen = new Set();
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    const edge = [...lines.slice(0, 3), ...lines.slice(-3)];
    for (const l of edge) {
      const key = l.replace(/\d+/g, '#');
      if (key.length < 3 || key.length > 60 || seen.has(key)) continue; // headers/footers are short
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const out = new Set();
  for (const [k, n] of counts) if (n >= Math.ceil(pages.length * 0.6)) out.add(k);
  return out;
}

function cleanPdfText(raw) {
  let text = String(raw || '').replace(/\r/g, '');
  text = text.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c);
  text = text.replace(/­/g, '').replace(/ /g, ' ').replace(/[​-‍﻿]/g, '');

  const pages = text.split('\u000C').map((p) => p.trim()).filter(Boolean);
  const repeated = repeatedLines(pages);
  const lines = [];
  for (const p of pages) {
    const pageLines = p.split('\n').map((raw) => raw.replace(/[ \t]+/g, ' ').trim());
    const nonEmpty = pageLines.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
    const edge = new Set([...nonEmpty.slice(0, 3), ...nonEmpty.slice(-3)]);
    const kept = [];
    pageLines.forEach((t, i) => {
      // Page numbers and headers/footers only count at the top/bottom of a page.
      if (t && edge.has(i) && (isPageNumber(t) || repeated.has(t.replace(/\d+/g, '#')))) return;
      kept.push(t);
    });
    // Blank lines left where a header/footer was removed are not paragraph breaks.
    while (kept.length && !kept[0]) kept.shift();
    while (kept.length && !kept[kept.length - 1]) kept.pop();
    lines.push(...kept);
    // A paragraph that continues on the next page stays one paragraph.
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]) last -= 1;
    if (last < 0 || LINE_END_RE.test(lines[last]) || lines[last].length < 40) lines.push('');
  }

  // Typical full line length: a line close to it that does not end a
  // sentence was wrapped by the page width, whatever the next line starts with.
  const lengths = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const fullLine = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;

  // Join wrapped lines into paragraphs; keep bullets, headings and blank lines.
  const out = [];
  for (const line of lines) {
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let cur = line.replace(BULLET_RE, (m) => (m.trim() ? '• ' : ''));
    const isBullet = cur.startsWith('• ');
    const prev = out.length ? out[out.length - 1] : '';
    const prevIsHeading = prev && prev.length < 40 && (prev === prev.toUpperCase() || /:$/.test(prev));
    if (prev && !isBullet && !prevIsHeading) {
      // "desenvol-" + "vimento" -> "desenvolvimento"
      if (/[\p{Ll}\p{Lu}]-$/u.test(prev) && /^\p{Ll}/u.test(cur)) {
        out[out.length - 1] = prev.slice(0, -1) + cur;
        continue;
      }
      // A line that does not end a sentence, followed by one that starts in
      // lowercase (or continues a number/paren), is the same paragraph.
      const wrapped = fullLine >= 40 && prev.length >= fullLine * 0.8 && /^[\p{L}0-9(]/u.test(cur);
      if (!LINE_END_RE.test(prev) && (wrapped || /^[\p{Ll}0-9(,]/u.test(cur))) {
        out[out.length - 1] = `${prev} ${cur}`;
        continue;
      }
    }
    out.push(cur);
  }
  return out
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns { text, pages, chars_per_page }.
async function extractPdfText(buffer) {
  const pdfParse = getPdfParse();
  if (!pdfParse) return { text: '', pages: 0, chars_per_page: 0 };
  try {
    const data = await pdfParse(buffer, { max: 0, pagerender: pageRenderer });
    const text = cleanPdfText(data.text || '');
    const pages = data.numpages || 1;
    return { text, pages, chars_per_page: text.replace(/\s+/g, '').length / pages };
  } catch (_e) {
    return { text: '', pages: 0, chars_per_page: 0 };
  }
}

// A PDF whose pages carry (almost) no text layer is a scan or an image export.
function looksScanned(result) {
  return !result.text || result.chars_per_page < 60;
}

// OCR / reading through OpenRouter's file-parser (mistral-ocr): used only for
// PDFs without a text layer. One call at upload time, never during the live
// interview. Resolves to '' on any failure.
function ocrPdfWithOpenRouter(buffer, filename, apiKey, httpsModule, model = 'qwen/qwen3.6-flash', timeoutMs = 90000) {
  if (!apiKey || !buffer || !buffer.length) return Promise.resolve('');
  const payload = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 6000,
    stream: false,
    plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Transcreva TODO o texto deste PDF, na ordem de leitura, como texto puro. Não resuma, não traduza, ' +
              'não comente e não invente nada. Mantenha nomes, datas e números exatamente como estão. ' +
              'Use uma linha por item de lista e uma linha em branco entre seções.'
          },
          { type: 'file', file: { filename: filename || 'documento.pdf', file_data: `data:application/pdf;base64,${buffer.toString('base64')}` } }
        ]
      }
    ]
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = httpsModule.request(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload, 'utf8'),
            'HTTP-Referer': 'https://realtimeai.local',
            'X-Title': 'RealTimeAI Studio'
          },
          timeout: timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              finish(String(parsed?.choices?.[0]?.message?.content || '').trim());
            } catch (_e) {
              finish('');
            }
          });
        }
      );
      req.on('error', () => finish(''));
      req.on('timeout', () => {
        req.destroy();
        finish('');
      });
      req.write(payload);
      req.end();
    } catch (_e) {
      finish('');
    }
  });
}

module.exports = { extractPdfText, cleanPdfText, renderPageItems, looksScanned, ocrPdfWithOpenRouter, PAGE_BREAK };
