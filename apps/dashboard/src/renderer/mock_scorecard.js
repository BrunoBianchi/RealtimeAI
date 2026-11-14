(function mockScorecard() {
  // Keep this module in sync with Browser/Home/src/lib/mockScorecard.js.
  // The scorecard of a mock interview: three stages built from the judged
  // criteria (75%) and the measured signals (25%), an index out of 100 with a
  // band, and a comparison with the person's own earlier interviews (never with
  // made-up market data). Also the charts as SVG strings and the conversation as
  // text. Colors come from CSS variables the page sets:
  // --sc-1, --sc-2, --sc-3 (stages), --sc-track, --sc-line, --sc-text, --sc-dim, --sc-avg.

  const STAGES = [
    { key: 'conteudo', criteria: ['adequacao', 'evidencias'], measured: ['ownership', 'results'] },
    { key: 'comunicacao', criteria: ['estrutura', 'objetividade', 'idioma'], measured: ['pace', 'fillers'] },
    { key: 'aderencia', criteria: ['vaga', 'cultura'], measured: ['coverage'] },
  ];
  const AXES = ['adequacao', 'evidencias', 'estrutura', 'objetividade', 'idioma', 'vaga', 'cultura'];
  const BANDS = [40, 70];
  const JUDGED = 0.75;
  const EARLIER_LIMIT = 10;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const mean = (list) => {
    const v = list.map(num).filter((x) => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const round = (v) => (v === null ? null : Math.round(v));
  const band = (v) => (v === null ? 'none' : v < BANDS[0] ? 'low' : v < BANDS[1] ? 'mid' : 'high');
  // 0 (not scored) to 3 filled segments.
  const level = (v) => (v === null || v === undefined ? 0 : v < BANDS[0] ? 1 : v < BANDS[1] ? 2 : 3);

  // The values of one saved interview, all from 0 to 100.
  function values(record) {
    const J = record && record.evaluation;
    if (!J) return null;
    const criteria = {};
    for (const k of AXES) criteria[k] = num(J.criteria && J.criteria[k]);
    criteria.idioma = num(record.language && record.language.nota);
    const m = J.measured || {};
    const measured = {
      ownership: num(m.ownership), results: num(m.results), pace: num(m.pace), fillers: num(m.fillers),
      coverage: num(m.coverage && m.coverage.score),
    };
    return { criteria, measured };
  }

  function stagesOf(v) {
    const out = {};
    for (const s of STAGES) {
      const judged = mean(s.criteria.map((k) => v.criteria[k]));
      const measured = mean(s.measured.map((k) => v.measured[k]));
      const score = judged !== null && measured !== null ? JUDGED * judged + (1 - JUDGED) * measured : judged !== null ? judged : measured;
      out[s.key] = round(score);
    }
    return out;
  }

  // `earlier`: the other saved interviews; only those before this one count.
  function scorecard(record, earlier) {
    const v = values(record);
    if (!v) return null;
    const stages = stagesOf(v);
    const index = round(mean(Object.values(stages)));
    const before = (earlier || [])
      .filter((r) => r && r.id !== record.id && r.startedAt < record.startedAt && values(r))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, EARLIER_LIMIT)
      .map((r) => {
        const ev = values(r);
        const st = stagesOf(ev);
        return { index: mean(Object.values(st)), stages: st, criteria: ev.criteria, measured: ev.measured };
      });
    const avg = before.length ? {
      n: before.length,
      index: round(mean(before.map((b) => b.index))),
      stages: Object.fromEntries(STAGES.map((s) => [s.key, round(mean(before.map((b) => b.stages[s.key])))])),
      criteria: Object.fromEntries(AXES.map((k) => [k, round(mean(before.map((b) => b.criteria[k])))])),
      measured: Object.fromEntries(Object.keys(v.measured).map((k) => [k, round(mean(before.map((b) => b.measured[k])))])),
    } : null;
    const rows = Object.fromEntries(STAGES.map((s) => [s.key, [
      ...s.criteria.map((k) => ({ key: k, kind: 'judged', value: round(v.criteria[k]), avg: avg ? avg.criteria[k] : null })),
      ...s.measured.map((k) => ({ key: k, kind: 'measured', value: round(v.measured[k]), avg: avg ? avg.measured[k] : null })),
    ].filter((r) => r.value !== null)]));
    const J = record.evaluation;
    return {
      index,
      band: band(index),
      stages: STAGES.map((s) => ({ key: s.key, score: stages[s.key], band: band(stages[s.key]), avg: avg ? avg.stages[s.key] : null, rows: rows[s.key] })),
      criteria: v.criteria,
      measured: v.measured,
      coverage: J.measured && J.measured.coverage ? J.measured.coverage : null,
      avg,
      delta: avg && index !== null && avg.index !== null ? index - avg.index : null,
    };
  }

  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f1 = (n) => Math.round(n * 10) / 10;

  // What each stage adds to the index: a ring split in three, out of 100.
  function donutSvg(card, labels) {
    const r = 78;
    const C = 2 * Math.PI * r;
    let done = 0;
    const arcs = card.stages.map((s, i) => {
      const part = s.score === null ? 0 : s.score / card.stages.length;
      const len = Math.max(0, (C * part) / 100 - 3);
      const arc = len > 0
        ? `<circle cx="100" cy="100" r="${r}" fill="none" style="stroke:var(--sc-${i + 1})" stroke-width="22" stroke-dasharray="${f1(len)} ${f1(C)}" stroke-dashoffset="${f1(-(C * done) / 100)}" transform="rotate(-90 100 100)"/>`
        : '';
      done += part;
      return arc;
    }).join('');
    return `<svg viewBox="0 0 200 200" role="img" aria-label="${esc(labels.index)}: ${card.index === null ? '-' : card.index} ${esc(labels.of100)}" xmlns="http://www.w3.org/2000/svg">`
      + `<circle cx="100" cy="100" r="${r}" fill="none" style="stroke:var(--sc-track)" stroke-width="22"/>${arcs}`
      + `<text x="100" y="104" text-anchor="middle" style="fill:var(--sc-text);font-size:46px;font-weight:700">${card.index === null ? '-' : card.index}</text>`
      + `<text x="100" y="128" text-anchor="middle" style="fill:var(--sc-dim);font-size:12px;letter-spacing:.08em">${esc(labels.of100).toUpperCase()}</text></svg>`;
  }

  // The criteria as a radar, with the earlier average dashed when there is one.
  function radarSvg(card, labels) {
    const axes = AXES.filter((k) => num(card.criteria[k]) !== null);
    if (axes.length < 3) return '';
    const cx = 190;
    const cy = 150;
    const R = 100;
    const at = (i, v) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
      return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100), a];
    };
    const poly = (vals) => vals.map((v, i) => at(i, v).slice(0, 2).map(f1).join(',')).join(' ');
    const rings = [25, 50, 75, 100].map((v) => `<polygon points="${poly(axes.map(() => v))}" fill="none" style="stroke:var(--sc-line)" stroke-width="1"/>`).join('');
    const spokes = axes.map((_, i) => {
      const [x, y] = at(i, 100);
      return `<line x1="${cx}" y1="${cy}" x2="${f1(x)}" y2="${f1(y)}" style="stroke:var(--sc-line)" stroke-width="1"/>`;
    }).join('');
    const avgVals = card.avg ? axes.map((k) => card.avg.criteria[k]) : [];
    // A dashed outline when every axis has an earlier average, else a hollow dot on those that do.
    const avg = !card.avg ? '' : avgVals.every((v) => v !== null)
      ? `<polygon data-avg points="${poly(avgVals)}" fill="none" style="stroke:var(--sc-avg)" stroke-width="1.5" stroke-dasharray="4 4"/>`
      : avgVals.map((v, i) => {
        if (v === null) return '';
        const [x, y] = at(i, v);
        return `<circle data-avg cx="${f1(x)}" cy="${f1(y)}" r="4" fill="none" style="stroke:var(--sc-avg)" stroke-width="1.5"/>`;
      }).join('');
    const mine = `<polygon points="${poly(axes.map((k) => card.criteria[k]))}" style="fill:var(--sc-1);fill-opacity:.22;stroke:var(--sc-1)" stroke-width="2"/>`;
    const dots = axes.map((k, i) => {
      const [x, y] = at(i, card.criteria[k]);
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="3" style="fill:var(--sc-1)"/>`;
    }).join('');
    const names = axes.map((k, i) => {
      const [x, y, a] = at(i, 118);
      const c = Math.cos(a);
      const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
      const dy = Math.sin(a) > 0.5 ? 10 : Math.sin(a) < -0.5 ? -2 : 4;
      return `<text x="${f1(x)}" y="${f1(y + dy)}" text-anchor="${anchor}" style="fill:var(--sc-dim);font-size:13px">${esc(labels.criteria[k])} <tspan style="fill:var(--sc-text);font-weight:700">${card.criteria[k]}</tspan></text>`;
    }).join('');
    return `<svg viewBox="-60 0 500 300" role="img" aria-label="${esc(labels.strong)}" xmlns="http://www.w3.org/2000/svg">${rings}${spokes}${avg}${mine}${dots}${names}</svg>`;
  }

  // Horizontal bars from 0 to 100 with the band lines and the earlier average as a marker.
  function barsSvg(rows, labels) {
    const W = 560;
    const x0 = 180;
    const bw = 320;
    const top = 22;
    const h = 34;
    const H = top + rows.length * h + 8;
    const X = (v) => x0 + (bw * v) / 100;
    const lines = BANDS.map((b) => `<line x1="${f1(X(b))}" y1="${top - 6}" x2="${f1(X(b))}" y2="${H - 6}" style="stroke:var(--sc-line)" stroke-dasharray="3 4"/>`
      + `<text x="${f1(X(b))}" y="${top - 10}" text-anchor="middle" style="fill:var(--sc-dim);font-size:10px">${b}</text>`).join('');
    const body = rows.map((r, i) => {
      const y = top + i * h;
      const v = r.value === null ? 0 : r.value;
      const marker = r.avg !== null && r.avg !== undefined
        ? `<rect x="${f1(X(r.avg) - 1.5)}" y="${y + 4}" width="3" height="20" rx="1" style="fill:var(--sc-avg)"><title>${esc(labels.avg)}: ${r.avg}</title></rect>` : '';
      return `<text x="${x0 - 12}" y="${y + 18}" text-anchor="end" style="fill:var(--sc-text);font-size:12px${r.strong ? ';font-weight:700' : ''}">${esc(r.label)}</text>`
        + `<rect x="${x0}" y="${y + 7}" width="${bw}" height="14" rx="4" style="fill:var(--sc-track)"/>`
        + `<rect x="${x0}" y="${y + 7}" width="${f1((bw * v) / 100)}" height="14" rx="4" style="fill:var(--sc-${r.tone || 1})"/>${marker}`
        + `<text x="${x0 + bw + 12}" y="${y + 18}" style="fill:var(--sc-text);font-size:12px;font-weight:700">${r.value === null ? '-' : r.value}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(labels.compare)}" xmlns="http://www.w3.org/2000/svg">${lines}${body}</svg>`;
  }

  // Index and stages next to the earlier average.
  function compareRows(card, labels) {
    return [
      { label: labels.index, value: card.index, avg: card.avg ? card.avg.index : null, strong: true },
      ...card.stages.map((s, i) => ({ label: labels.stages[s.key], value: s.score, avg: s.avg, tone: i + 1 })),
    ];
  }

  function fileStem(record) {
    const slug = `${record.company || ''} ${record.role || ''}`.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
    const day = new Date(record.startedAt).toISOString().slice(0, 10);
    return `lipcue-mock-${slug || 'interview'}-${day}`;
  }

  // The conversation as plain text, in the order it happened.
  function transcriptText(record, labels) {
    const out = [`${labels.title}: ${record.company || '-'} · ${record.role || '-'}`, labels.date, ''];
    for (const m of record.messages || []) {
      out.push(`${m.role === 'user' ? labels.you : labels.orby}:`, m.content, '');
    }
    return out.join('\n');
  }

  // The chart pictures and the title the printable report (mockReport.js) uses.
  function reportParts(record, card, labels) {
    return {
      title: fileStem(record),
      donut: card && card.index !== null ? donutSvg(card, labels) : '',
      radar: card && card.index !== null ? radarSvg(card, labels) : '',
      bars: card && card.index !== null ? barsSvg(compareRows(card, labels), labels) : '',
    };
  }

  window.Cue.mockScorecard = { STAGES, AXES, BANDS, band, level, scorecard, donutSvg, radarSvg, barsSvg, compareRows, fileStem, transcriptText, reportParts };
})();
