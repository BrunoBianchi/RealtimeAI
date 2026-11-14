// Keep this module in sync with Browser/Home/src/lib/mockReport.js.
// The printable report of a mock interview, as one HTML document in LipCue's
// colors (dark background, green accent) for A4. It has its own palette: it is
// printed on its own, outside the app's theme.

const BANDS = [40, 70];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const band = (v) => (v === null ? 'none' : v < BANDS[0] ? 'low' : v < BANDS[1] ? 'mid' : 'high');
const level = (v) => (v === null || v === undefined ? 0 : v < BANDS[0] ? 1 : v < BANDS[1] ? 2 : 3);
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (s, n) => String(s).replace('{n}', n);

function segHtml(v) {
  const n = level(v);
  return `<span class="seg l${n}"><i></i><i></i><i></i></span>`;
}

const REPORT_CSS = `
@page{size:A4;margin:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0;background:#0a0b0c;color:#f4f4f5;font:12px/1.5 Inter,"Segoe UI",system-ui,-apple-system,sans-serif}
:root{--sc-1:#22c55e;--sc-2:#86efac;--sc-3:#d4d4d8;--sc-track:#26292e;--sc-line:rgba(255,255,255,.14);--sc-text:#f4f4f5;--sc-dim:#a1a1aa;--sc-avg:#ffffff}
.page{width:210mm;min-height:297mm;padding:16mm 15mm 18mm;position:relative;break-after:page;page-break-after:always;background:#0a0b0c;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.page:last-child{break-after:auto;page-break-after:auto}
.brand{display:flex;justify-content:space-between;align-items:center;color:#a1a1aa;font-size:10px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:12mm}
.brand b{color:#22c55e;letter-spacing:.04em;font-size:13px;text-transform:none}
.foot{position:absolute;left:15mm;right:15mm;bottom:8mm;display:flex;justify-content:space-between;color:#71717a;font-size:9px}
h1{font-size:26px;line-height:1.15;margin:0 0 4px}
h2{font-size:17px;margin:0 0 10px}
h3{font-size:12px;margin:0 0 6px;color:#a1a1aa;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.dim{color:#a1a1aa}
.card{background:#16181b;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;break-inside:avoid;page-break-inside:avoid}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.stack{display:grid;gap:10px}
.hero{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:center;margin:8mm 0}
.big{font-size:84px;font-weight:800;line-height:1;color:#22c55e}
.big small{font-size:14px;color:#a1a1aa;font-weight:500;margin-left:6px}
.band{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:11px;border:1px solid}
.band.high{color:#86efac;border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.1)}
.band.mid{color:#f5b544;border-color:rgba(245,181,68,.45);background:rgba(245,181,68,.08)}
.band.low{color:#fb7185;border-color:rgba(244,63,94,.45);background:rgba(244,63,94,.08)}
.stage b{font-size:28px;display:block}
.stage .dot,.row .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.d1{background:var(--sc-1)}.d2{background:var(--sc-2)}.d3{background:var(--sc-3)}
.mini{height:6px;border-radius:3px;background:#26292e;margin-top:6px;overflow:hidden}
.mini i{display:block;height:100%}
svg{width:100%;height:auto;display:block}
.donut{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:center}
.legend{display:grid;gap:8px}
.legend div{display:flex;justify-content:space-between;gap:8px}
ul{margin:4px 0 0;padding-left:16px}
li{margin:2px 0}
.verdict{border-left:3px solid #22c55e}
.seg{display:inline-grid;grid-template-columns:repeat(3,14px);gap:3px;vertical-align:middle}
.seg i{height:6px;border-radius:2px;background:#26292e}
.seg.l1 i:nth-child(1){background:#f43f5e}
.seg.l2 i:nth-child(-n+2){background:#f5b544}
.seg.l3 i{background:#22c55e}
.stagehead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:6px;margin:14px 0 4px}
.stagehead b{font-size:18px}
.stagehead span{color:#a1a1aa;font-size:10px;letter-spacing:.1em}
.row{display:grid;grid-template-columns:150px 54px 32px 1fr;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);break-inside:avoid}
.row .k{font-size:9px;color:#71717a;text-transform:uppercase;letter-spacing:.08em}
.row .v{font-weight:700;text-align:right}
.q{margin-bottom:10px}
.q .head{display:flex;gap:10px;align-items:flex-start}
.chip{min-width:34px;text-align:center;border-radius:8px;padding:2px 6px;font-weight:700;font-size:12px}
.chip.high{background:rgba(34,197,94,.14);color:#86efac}.chip.mid{background:rgba(245,181,68,.12);color:#f5b544}.chip.low{background:rgba(244,63,94,.12);color:#fb7185}.chip.none{background:#26292e;color:#a1a1aa}
.lbl{color:#a1a1aa;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-top:6px}
.tags span{display:inline-block;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:1px 8px;margin:2px 4px 2px 0;font-size:10px}
.tags.ok span{border-color:rgba(34,197,94,.45);color:#86efac}
.msg{margin:0 0 8px;break-inside:avoid}
.msg b{color:#22c55e}
.msg.you b{color:#d4d4d8}
.note{color:#a1a1aa;font-size:10px}
`;

// The printable report: a cover, the score breakdown, the comparison, the
// signals per stage, each answer, the language and the conversation. `card`
// comes from mockScorecard.js scorecard(), `parts` from its reportParts() (the
// chart pictures and the title), `L` carries the translated text with `L.date`
// and `L.meta` already formatted.
function reportHtml(record, card, L, parts) {
  const J = record.evaluation || {};
  const page = (n, body) => `<section class="page"><div class="brand"><b>LipCue</b><span>${esc(L.subtitle)}</span></div>${body}`
    + `<div class="foot"><span>${esc(record.company || '-')} · ${esc(record.role || '-')}</span><span>${n}</span></div></section>`;
  const list = (title, rows) => (rows && rows.length ? `<div class="card"><h3>${esc(title)}</h3><ul>${rows.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const pages = [];
  const hasCard = card && card.index !== null;

  // 1. Cover.
  const cmp = card && card.avg
    ? `${esc(fill(L.avgOf, card.avg.n))}: <b>${card.avg.index}</b>${card.delta !== null ? ` (${card.delta >= 0 ? '+' : ''}${card.delta})` : ''}`
    : esc(L.first);
  const stages = hasCard ? `<div class="grid3">${card.stages.map((s, i) => `<div class="card stage"><span class="dot d${i + 1}"></span><span class="dim">${esc(L.stages[s.key])}</span>`
    + `<b>${s.score === null ? '-' : s.score}<small class="dim" style="font-size:11px;font-weight:500"> ${esc(L.of100)}</small></b>`
    + `<div class="mini"><i class="d${i + 1}" style="width:${s.score || 0}%"></i></div>`
    + `<div class="note" style="margin-top:6px">${esc(L.stageHint[s.key])}</div></div>`).join('')}</div>` : '';
  pages.push(page(1, `<h3>${esc(L.title)}</h3><h1>${esc(record.company || '-')} · ${esc(record.role || '-')}</h1><div class="dim">${esc(L.date)}${L.meta ? ` · ${esc(L.meta)}` : ''}</div>`
    + (hasCard ? `<div class="hero"><div class="big">${card.index}<small>${esc(L.of100)}</small></div><div><span class="band ${card.band}">${esc(L.band[card.band])}</span>`
      + `<p class="dim" style="margin:8px 0 0">${esc(L.bandHint[card.band])}</p><p style="margin:8px 0 0">${cmp}</p></div></div>` : `<p class="dim">${esc(L.noScore)}</p>`)
    + stages
    + (J.resumo ? `<div class="card" style="margin-top:10px"><h3>${esc(L.summary)}</h3><p style="margin:0">${esc(J.resumo)}</p></div>` : '')
    + `<p class="note" style="margin-top:10px">${esc(L.method)}</p>`));

  // 2. Breakdown.
  if (hasCard) {
    const legend = card.stages.map((s, i) => `<div><span><span class="dot d${i + 1}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px"></span>${esc(L.stages[s.key])}</span><b>${s.score === null ? '-' : s.score}</b></div>`).join('');
    const radar = parts.radar;
    pages.push(page(2, `<h2>${esc(L.breakdown)}</h2><div class="grid2"><div class="card"><h3>${esc(L.compose)}</h3><div class="donut">${parts.donut}<div class="legend">${legend}</div></div>`
      + `<p class="note">${esc(L.composeHint)}</p></div>`
      + `<div class="card"><h3>${esc(L.strong)}</h3>${radar || `<p class="dim">${esc(L.fewAxes)}</p>`}${card.avg ? `<p class="note">— ${esc(L.you)} · - - ${esc(L.avg)}</p>` : ''}</div></div>`
      + (J.vaga ? `<div class="card verdict" style="margin-top:10px"><h3>${esc(L.verdict)}</h3><p style="margin:0">${esc(J.vaga)}</p></div>` : '')
      + (card.coverage && (card.coverage.covered.length || card.coverage.missing.length)
        ? `<div class="grid2" style="margin-top:10px"><div class="card"><h3>${esc(L.coverageCovered)}</h3><div class="tags ok">${card.coverage.covered.map((x) => `<span>${esc(x)}</span>`).join('') || '-'}</div></div>`
          + `<div class="card"><h3>${esc(L.coverageMissing)}</h3><div class="tags">${card.coverage.missing.map((x) => `<span>${esc(x)}</span>`).join('') || '-'}</div></div></div>` : '')
      + `<div class="grid2" style="margin-top:10px">${list(L.strengths, J.fortes)}${list(L.improve, J.melhorar)}</div>`
      + (J.proximo ? `<div class="card" style="margin-top:10px"><h3>${esc(L.next)}</h3><p style="margin:0">${esc(J.proximo)}</p></div>` : '')
      + (J.objetivo ? `<div class="card" style="margin-top:10px"><h3>${esc(L.goal)}</h3><p style="margin:0">${esc(J.objetivo)}</p></div>` : '')));

    // 3. Comparison and the signals per stage.
    const rows = card.stages.map((s, i) => `<div class="stagehead"><span><span class="dot d${i + 1}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px"></span><b>${esc(L.stages[s.key])}</b></span>`
      + `<span><b style="font-size:18px;color:#f4f4f5">${s.score === null ? '-' : s.score}</b> ${esc(L.of100).toUpperCase()}</span></div>`
      + s.rows.map((r) => `<div class="row"><div><span class="dot d${i + 1}"></span>${esc(r.kind === 'judged' ? L.criteria[r.key] : L.measured[r.key])}<div class="k">${esc(r.kind === 'judged' ? L.judged : L.measuredTag)}</div></div>`
        + `${segHtml(r.value)}<span class="v">${r.value}</span><span class="dim">${esc(r.kind === 'judged' ? L.criteriaHint[r.key] : L.measuredHint[r.key])}</span></div>`).join('')).join('');
    pages.push(page(3, `<h2>${esc(L.compare)}</h2><div class="card">${parts.bars}`
      + `<p class="note">${card.avg ? `▮ ${esc(fill(L.avgOf, card.avg.n))}. ` : `${esc(L.first)} `}${esc(L.bandsLegend)}</p></div>`
      + (J.pitfalls && J.pitfalls.length ? `<div class="card" style="margin-top:12px"><h3>${esc(L.pitfalls)}</h3><ul>${J.pitfalls.map((p) => `<li><b>${esc(L.pitfall[p.id] || p.id)}</b> · ${esc(L.pitfallFix[p.id] || '')}</li>`).join('')}</ul></div>` : '')));
    pages.push(page(4, `<h2>${esc(L.signals)}</h2><p class="note" style="margin:-4px 0 4px">${esc(L.method)}</p>${rows}`));
  }

  // 4. Each answer.
  if (J.items && J.items.length) {
    pages.push(page(pages.length + 1, `<h2>${esc(L.questions)}</h2>` + J.items.map((it) => `<div class="card q"><div class="head"><span class="chip ${band(num(it.score))}">${num(it.score) === null ? '-' : it.score}</span><b>${esc(it.question)}</b></div>`
      + (it.veredito ? `<p style="margin:6px 0 0">${esc(it.veredito)}</p>` : '')
      + (it.lacuna ? `<div class="lbl">${esc(L.gap)}</div><div>${esc(it.lacuna)}</div>` : '')
      + (it.dica ? `<div class="lbl">${esc(L.tip)}</div><div>${esc(it.dica)}</div>` : '')
      + (it.reescrita && it.reescrita.melhorada ? `<div class="lbl">${esc(L.rewrite)}</div><div class="dim">${esc(it.reescrita.melhorada)}</div>` : '')
      + '</div>').join('')));
  }

  // 5. Language.
  const lang = record.language;
  if (lang && (lang.resumo || (lang.dicas && lang.dicas.length))) {
    pages.push(page(pages.length + 1, `<h2>${esc(L.language)}${num(lang.nota) !== null ? ` · ${lang.nota} ${esc(L.of100)}` : ''}</h2>`
      + (lang.resumo ? `<div class="card"><p style="margin:0">${esc(lang.resumo)}</p></div>` : '')
      + (lang.dicas && lang.dicas.length ? `<div class="card" style="margin-top:10px"><ul>${lang.dicas.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : '')));
  }

  // 6. The conversation.
  if (record.messages && record.messages.length) {
    pages.push(page(pages.length + 1, `<h2>${esc(L.transcript)}</h2>` + record.messages.map((m) => `<p class="msg ${m.role === 'user' ? 'you' : 'orby'}"><b>${esc(m.role === 'user' ? L.speakerYou : L.speakerOrby)}:</b> ${esc(m.content)}</p>`).join('')));
  }
  return `<!doctype html><html lang="${esc(L.lang || 'en')}"><head><meta charset="utf-8"><title>${esc(parts.title)}</title><style>${REPORT_CSS}</style></head><body>${pages.join('')}</body></html>`;
}

module.exports = { reportHtml };
