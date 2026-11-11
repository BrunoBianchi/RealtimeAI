'use strict';

(function () {
  const C = window.Cue;
  const keywords = new Set(('as async await break case catch class const continue def defer del do else elif enum except export ' +
    'extends finally fn for foreach from func function go if implements import in interface is lambda let match mod namespace ' +
    'new nonlocal not and or package pass private protected pub public raise return static struct super switch this throw ' +
    'throws try type typeof use using val var void when while with yield mut unsafe default include sizeof instanceof assert delete').split(' '));
  const sqlKeywords = new Set('select where join inner left right on group by order having limit distinct union insert update into values create table set asc desc nulls between over partition offset'.split(' '));
  const types = new Set(('bool boolean byte char double float int int32 int64 long number short str string String uint usize ' +
    'size_t auto Any List Map Set Array Object Vec Optional Promise None True False null true false nil nullptr undefined ' +
    'u8 u16 u32 u64 i8 i16 i32 i64 f32 f64').split(' '));

  const syntaxClasses = {
    keyword: 'syntax-keyword', type: 'syntax-type', string: 'syntax-string',
    number: 'syntax-number', comment: 'syntax-comment', function: 'syntax-function'
  };

  function highlightedRows(code, language) {
    const lang = language.toLowerCase();
    const python = /^(python|py)$/.test(lang);
    const sql = /^(sql|postgresql|mysql|sqlite)$/.test(lang);
    const comments = [];
    if (!python) comments.push(String.raw`/\*[\s\S]*?(?:\*/|$)`);
    if (!python && !sql) comments.push(String.raw`//[^\n]*`);
    if (sql) comments.push(String.raw`--[^\n]*`);
    if (python || /^(|text|bash|sh|ruby)$/.test(lang)) comments.push(String.raw`#[^\n]*`);

    const strings = [String.raw`"(?:\\[^\n]|[^"\\\n])*"?`, String.raw`'(?:\\[^\n]|[^'\\\n])*'?`, '`[^`\\n]*`?'];
    if (python) strings.unshift('"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)");
    const tokens = new RegExp([
      `(?<comment>${comments.join('|')})`,
      `(?<string>${strings.join('|')})`,
      String.raw`(?<number>\d[\w]*(?:\.\d[\w]*)?)`,
      String.raw`(?<word>[\p{L}_$][\p{L}\p{N}_$]*)`
    ].join('|'), 'gu');

    const lines = [''];
    let end = 0;
    const append = (text, tone) => {
      for (const [i, piece] of text.split('\n').entries()) {
        if (i) lines.push('');
        if (piece) lines[lines.length - 1] += tone
          ? `<span class="${syntaxClasses[tone]}">${C.esc(piece)}</span>` : C.esc(piece);
      }
    };
    for (const match of code.matchAll(tokens)) {
      const [value] = match;
      append(code.slice(end, match.index));
      end = match.index + value.length;
      const { comment, string, number, word } = match.groups;
      let tone = comment ? 'comment' : string ? 'string' : number ? 'number' : '';
      if (word) {
        const key = sql ? word.toLowerCase() : word;
        if (keywords.has(key) || (sql && sqlKeywords.has(key))) tone = 'keyword';
        else if (types.has(key)) tone = 'type';
        else if (/^[ \t]*\(/.test(code.slice(end))) tone = 'function';
      }
      append(value, tone);
    }
    append(code.slice(end));
    return lines.map((line, i) => `<span class="coding-row"><span class="coding-line-number" aria-hidden="true">${i + 1}</span>${line}</span>`).join('');
  }

  C.actions['copy-coding-block'] = async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.text);
      C.toast('Code copied.');
    } catch {
      C.toast('Could not copy code.', 'error');
    }
  };

  C.codingMd = (src, answerId, streaming) => {
    const blocks = C.markdownParts(src, { coding: true, streaming });
    const prose = blocks.filter((block) => block.text).map((block) => C.md(block.text)).join('');
    if (!blocks.some((block) => block.code)) return prose;
    const code = blocks.filter((block) => 'code' in block && block.code).map(({ language, code, closed }) =>
      `<div class="coding-editor"><div class="coding-editor-head">${C.icon('code')}<span>Code</span>
          <span class="coding-language" data-no-i18n>${C.esc(language)}</span>
          ${closed ? `<button type="button" class="coding-copy" data-action="copy-coding-block" data-text="${C.esc(code)}">${C.icon('copy')}<span>Copy code</span></button>` : ''}
        </div>
        <pre tabindex="0" aria-label="Code"><code data-no-i18n>${highlightedRows(code, language)}</code></pre></div>`).join('');
    return `<div class="coding-answer" data-answer-id="${C.esc(answerId)}"><div class="coding-columns${prose ? '' : ' code-only'}">
      <div class="coding-column coding-code-column">${code}</div>
      ${prose ? `<div class="coding-column coding-explanation" tabindex="0" aria-label="Explanation"><div class="coding-explanation-head">Explanation</div>${prose}</div>` : ''}
    </div></div>`;
  };
})();
