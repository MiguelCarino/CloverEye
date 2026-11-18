// The diagnostics report in a window of its own, to read in place: the
// same text Save diagnostics file writes (src-tauri/src/diag.rs), newest
// lines at the bottom. Filters by level and area and a search box narrow
// the log's lines; Refresh, Copy, Save, Close.

import { h, icon, toast, copyText } from './dom.js';
import { t } from './i18n.js';

let open = null;

/** A log line: "2026-11-17 10:04:12.345 INFO  net: …" → { level, area }. */
const LINE_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})? (ERROR|WARN|INFO|DEBUG) +([a-z0-9-]{1,16}): /;

/** The level and area of a report line, or null when it is not a log line
 *  (the report's header, crash dumps, an older session's free text). */
export function parseLine(line) {
  const m = LINE_RE.exec(line);
  return m ? { level: m[1].toLowerCase(), area: m[2] } : null;
}

/** Which levels each choice of the Level filter shows. */
const LEVEL_SETS = { all: null, problems: new Set(['error', 'warn']), errors: new Set(['error']) };

/**
 * The lines the filters keep. With the level or the area chosen, only log
 * lines that match; the search (any case) applies to every line kept.
 * @param {string[]} lines
 * @param {{level?: 'all'|'problems'|'errors', area?: string, query?: string}} f
 */
export function filterLines(lines, { level = 'all', area = '', query = '' } = {}) {
  const levels = LEVEL_SETS[level] ?? null;
  const q = query.trim().toLowerCase();
  if (!levels && !area && !q) return lines;
  return lines.filter((l) => {
    if (levels || area) {
      const p = parseLine(l);
      if (!p || (levels && !levels.has(p.level)) || (area && p.area !== area)) return false;
    }
    return !q || l.toLowerCase().includes(q);
  });
}

/** The areas in a report's lines, sorted. */
export function areasIn(lines) {
  const set = new Set();
  for (const l of lines) {
    const p = parseLine(l);
    if (p) set.add(p.area);
  }
  return [...set].sort();
}

/**
 * @param {object} o
 * @param {() => Promise<string>} o.load   the report's text
 * @param {() => Promise<string>} o.save   writes it to a file; the path
 * @param {Element} [o.opener]             focused again on close
 */
export function openLogDialog({ load, save, opener = null }) {
  if (open?.isConnected) {
    open.querySelector('[data-key="log-refresh"]')?.click();
    return open;
  }
  let lines = [];
  let fullText = '';
  const view = h('pre', { class: 'log-view', tabindex: '0', translate: 'no', 'aria-label': 'Diagnostics report', 'data-key': 'log-view' });
  const status = h('p', { class: 'field__hint log-dialog__status', 'aria-live': 'polite', 'data-key': 'log-status' });
  const shown = h('p', { class: 'field__hint log-dialog__count', 'aria-live': 'polite', 'data-key': 'log-count' });
  const levelSel = h(
    'select',
    { class: 'input', id: 'log-level', 'data-key': 'log-level', onchange: () => show() },
    h('option', { value: 'all', text: 'All levels' }),
    h('option', { value: 'problems', text: 'Warnings and errors' }),
    h('option', { value: 'errors', text: 'Errors only' }),
  );
  const areaSel = h('select', { class: 'input', id: 'log-area', 'data-key': 'log-area', onchange: () => show() });
  let searchTimer = null;
  const search = h('input', {
    type: 'search',
    class: 'input',
    id: 'log-search',
    placeholder: 'Search the log',
    'data-key': 'log-search',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(show, 150);
    },
  });
  const filters = h(
    'div',
    { class: 'log-filters', role: 'group', 'aria-label': 'Filter the log' },
    h('label', { class: 'log-filters__field' }, h('span', { class: 'log-filters__label', text: 'Level' }), levelSel),
    h('label', { class: 'log-filters__field' }, h('span', { class: 'log-filters__label', text: 'Area' }), areaSel),
    h('label', { class: 'log-filters__field log-filters__search' }, h('span', { class: 'log-filters__label', text: 'Search' }), search),
  );

  function fillAreas() {
    const keep = areaSel.value;
    const areas = areasIn(lines);
    areaSel.replaceChildren(h('option', { value: '', text: 'All areas' }), ...areas.map((a) => h('option', { value: a, text: a, translate: 'no' })));
    areaSel.value = areas.includes(keep) ? keep : '';
  }

  function show() {
    const kept = filterLines(lines, { level: levelSel.value, area: areaSel.value, query: search.value });
    const filtered = kept !== lines;
    view.textContent = filtered ? (kept.length ? kept.join('\n') : t('No lines match the filters.')) : fullText;
    shown.textContent = filtered ? t('{0} of {1} lines', kept.length, lines.length) : '';
    shown.hidden = !filtered;
    view.scrollTop = view.scrollHeight; // the newest lines
  }

  const close = () => {
    clearTimeout(searchTimer);
    if (d.open) d.close();
    d.remove();
    open = null;
    if (opener?.isConnected) opener.focus();
  };
  async function refresh() {
    status.textContent = t('Loading…');
    try {
      fullText = await load();
      lines = fullText.split('\n');
      fillAreas();
      status.textContent = '';
      show();
    } catch (e) {
      status.textContent = t('Couldn’t make the diagnostics: {0}', String(e?.message ?? e));
    }
  }
  const d = h(
    'dialog',
    { class: 'log-dialog', 'aria-labelledby': 'log-title' },
    h(
      'div',
      { class: 'dialog__body log-dialog__body' },
      h('h2', { class: 'dialog__title', id: 'log-title', text: 'Diagnostics' }),
      h('p', { class: 'dialog__text', text: 'What Save diagnostics file writes, newest lines at the bottom. It has no posts, captcha answers, cookies or passwords.' }),
      filters,
      view,
      shown,
      status,
    ),
    h(
      'div',
      { class: 'dialog__actions log-dialog__actions' },
      h('button', { type: 'button', class: 'btn', 'data-key': 'log-refresh', onclick: refresh }, icon('refresh'), 'Refresh'),
      // Copy takes what is shown: the filtered lines, or the whole report
      h('button', { type: 'button', class: 'btn', 'data-key': 'log-copy', onclick: async () => toast((await copyText(view.textContent)) ? 'Diagnostics copied' : 'Couldn’t copy. Save the file instead.') }, icon('copy'), 'Copy'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-key': 'log-save',
          onclick: async () => {
            try {
              status.textContent = t('Saved to {0}', await save());
            } catch (e) {
              status.textContent = t('Couldn’t make the diagnostics: {0}', String(e?.message ?? e));
            }
          },
        },
        icon('download'),
        'Save file',
      ),
      h('button', { type: 'button', class: 'btn btn--primary', 'data-key': 'log-close', autofocus: true, onclick: close, text: 'Close' }),
    ),
  );
  shown.hidden = true;
  d.addEventListener('close', close);
  document.body.append(d);
  d.showModal();
  open = d;
  refresh();
  return d;
}
