// The Stats pane: board activity (Boards) and your own counts (You). The
// shell owns the data (stats.js) and redraws only this pane's content when
// a sample arrives; the sampler's line is set in place every few seconds.
// The numbers come from stats-model.js and my-stats-model.js. Text only
// through textContent; charts are inline SVG coloured by the theme's tokens.

import { h, icon } from './dom.js';
import { ago } from './browse-model.js';
import { boardRow, sortRows, sparkPath } from './stats-model.js';
import { totals, dailySeries, topBoards, bars, formatDuration } from './my-stats-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
};
const lang = () => document.documentElement.lang || undefined;

/** 3.4 or 27: one decimal under ten, whole numbers above. */
export function fmtRate(n) {
  if (!Number.isFinite(n)) return '—';
  const digits = n < 10 ? 1 : 0;
  try {
    return n.toLocaleString(lang(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch {
    return n.toFixed(digits);
  }
}

const fmtCount = (n) => {
  try {
    return Math.round(n).toLocaleString(lang());
  } catch {
    return String(Math.round(n));
  }
};

const fullTime = (ms) => {
  try {
    return new Date(ms).toLocaleString(lang(), { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
};

function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  try {
    return new Date(y, m - 1, d).toLocaleDateString(lang(), { month: 'short', day: 'numeric' });
  } catch {
    return key;
  }
}

/** "4 min" / "40 s": how long until the next sample. */
const waitText = (ms) => (ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))} s` : `${Math.ceil(ms / 60_000)} min`);

/** The sampler's line, as the pane shows it (set in place every few seconds). */
export function statusText(status, { isMain = true, now = Date.now() } = {}) {
  const s = status || { state: 'off' };
  if (s.state === 'manual') return `Sampling now: /${s.board}/ (${s.done + 1} of ${s.total})`;
  if (s.state === 'sampling') return `Sampling /${s.board}/…`;
  if (s.state === 'busy') return `Waiting for your own requests before sampling /${s.board}/`;
  if (s.state === 'next') return `Background sampling on. Next: /${s.board}/ in ${waitText(Math.max(0, s.at - now))}`;
  if (s.state === 'paused') return 'Background sampling paused while the window is hidden.';
  if (s.state === 'none') return 'Background sampling on, but there are no boards to follow: star some favourites, or choose more boards in Settings → Stats.';
  if (s.state === 'loading') return 'Loading the board list…';
  if (!isMain) return 'Background sampling runs in the main window. Here, rates come from catalogs you open.';
  return 'Background sampling is off: rates come from catalogs you open. Settings → Stats → Track board activity samples your boards on its own.';
}

function sparkline(values) {
  const w = 96;
  const hgt = 24;
  const { d, low, high } = sparkPath(values, w, hgt);
  const label = d ? `Posts a minute over the last 24 hours: low ${fmtRate(low)}, high ${fmtRate(high)}` : 'No samples in the last 24 hours';
  return svg(
    'svg',
    { class: 'stats-spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': label },
    svg('title', {}, document.createTextNode(label)),
    svg('line', { class: 'stats-spark__base', x1: 0, y1: hgt - 1, x2: w, y2: hgt - 1 }),
    d ? svg('path', { class: 'stats-spark__line', d }) : null,
  );
}

const SORT_HEADS = [
  { key: 'board', label: 'Board' },
  { key: 'ppm', label: 'Posts a minute' },
  { key: 'hour', label: 'Average, last hour' },
  { key: 'day', label: 'Average, 24 h' },
  { key: 'tph', label: 'Threads an hour' },
  { key: 'threads', label: 'Live threads' },
  { key: 'busiest', label: 'Busiest thread now' },
  { key: 'spark', label: 'Last 24 hours' },
];
const SORTABLE = new Set(['board', 'ppm', 'tph']);

function boardsTable({ rows, view, keyPrefix, hue, now, onSort, onOpenBoard, onOpenThread }) {
  const sorted = sortRows(rows, view.sort, view.dir);
  const head = h(
    'tr',
    {},
    SORT_HEADS.map((c) => {
      if (!SORTABLE.has(c.key)) return h('th', { scope: 'col', class: `stats-table__${c.key}`, text: c.label });
      const on = view.sort === c.key;
      return h(
        'th',
        { scope: 'col', class: `stats-table__${c.key}`, 'aria-sort': on ? (view.dir === 'asc' ? 'ascending' : 'descending') : null },
        h(
          'button',
          {
            type: 'button',
            class: 'stats-table__sort',
            'data-key': `${keyPrefix}stats-sort-${c.key}`,
            onclick: () => onSort(c.key),
          },
          c.label,
          h('span', { class: 'stats-table__arrow', 'aria-hidden': 'true', text: on ? (view.dir === 'asc' ? '▲' : '▼') : '' }),
        ),
      );
    }),
  );
  const body = sorted.map((r) => {
    const collecting = r.count < 2;
    return h(
      'tr',
      { 'data-board': r.board },
      h(
        'th',
        { scope: 'row', class: 'stats-table__board' },
        h(
          'button',
          { type: 'button', class: 'stats-table__open', 'data-key': `${keyPrefix}stats-board-${r.board}`, 'aria-label': `Open /${r.board}/`, onclick: () => onOpenBoard(r.board) },
          h('span', { class: 'board-tag', style: { '--hue': hue(r.board) }, text: `/${r.board}/` }),
        ),
        r.last ? h('span', { class: 'stats-table__when', title: fullTime(r.last), text: `Last sample ${ago(r.last / 1000, now)}` }) : null,
      ),
      h(
        'td',
        { class: `stats-table__ppm${collecting ? ' stats-table__wait' : ''}` },
        collecting ? 'Collecting… (needs two samples)' : Number.isFinite(r.ppm) ? h('strong', { text: fmtRate(r.ppm) }) : h('span', { title: 'No samples in the last two hours', text: '—' }),
      ),
      h('td', { class: 'stats-table__hour', title: Number.isFinite(r.hour) ? null : 'Not enough samples yet', text: fmtRate(r.hour) }),
      h('td', { class: 'stats-table__day', title: Number.isFinite(r.day) ? null : 'Not enough samples yet', text: fmtRate(r.day) }),
      h('td', { class: 'stats-table__tph', title: Number.isFinite(r.tph) ? null : 'Not enough samples yet', text: fmtRate(r.tph) }),
      h('td', { class: 'stats-table__threads', text: Number.isFinite(r.threads) ? fmtCount(r.threads) : '—' }),
      h(
        'td',
        { class: 'stats-table__busiest' },
        r.busiest
          ? h(
              'button',
              {
                type: 'button',
                class: 'stats-table__thread',
                'data-key': `${keyPrefix}stats-thread-${r.board}`,
                title: `${r.busiest.added} new replies since the sample before`,
                onclick: () => onOpenThread(r.board, r.busiest.no),
              },
              h('span', { class: 'stats-table__added', text: `+${r.busiest.added}` }),
              h('span', { class: 'stats-table__title', translate: r.busiest.title ? 'no' : null, text: r.busiest.title || `No. ${r.busiest.no}` }),
            )
          : '—',
      ),
      h('td', { class: 'stats-table__spark' }, sparkline(r.spark)),
    );
  });
  return h(
    'div',
    { class: 'stats-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Board activity' },
    h('table', { class: 'stats-table' }, h('caption', { class: 'visually-hidden', text: 'Board activity: posts a minute, threads an hour and the busiest thread of each board' }), h('thead', {}, head), h('tbody', {}, body)),
  );
}

/** Detailed stats for every board, on 4stats.io, in the system browser. */
export const FOURSTATS_URL = 'https://4stats.io/';

function fourStatsButton(o, cls = 'btn') {
  return o.onOpen4stats
    ? h('button', { type: 'button', class: cls, 'data-key': `${o.keyPrefix || ''}stats-4stats-open`, title: FOURSTATS_URL, onclick: o.onOpen4stats }, icon('external'), 'Open 4stats.io')
    : null;
}

/** Board activity is off (Settings → Stats → Track board activity): the
 *  pane offers only 4stats.io. */
function boardsOffPanel(o) {
  return h(
    'div',
    { class: 'stats__panel' },
    h(
      'div',
      { class: 'callout stats-fourstats' },
      icon('chart'),
      h(
        'div',
        {},
        h('strong', { text: 'Detailed 4chan stats are on 4stats.io. ' }),
        'Activity for every board, with history, in your browser.',
        h('div', { class: 'inline' }, fourStatsButton(o)),
      ),
    ),
    h('p', { class: 'field__hint', text: 'To follow your own boards here, turn on Settings → Stats → Track board activity.' }),
  );
}

function boardsPanel(o) {
  const { boards, view, now } = o;
  const rows = boards.map((b) => boardRow(b, o.store.boards[b], now));
  return h(
    'div',
    { class: 'stats__panel' },
    rows.length
      ? boardsTable({ ...o, rows, view })
      : h('p', { class: 'rail__empty', text: 'No boards here yet. Open a board’s catalog or star favourites.' }),
    h('p', {
      class: 'field__hint',
      text: 'Posts a minute come from how far a board’s highest post number rose between two samples (each board numbers its posts one by one). Threads an hour count new opening posts between samples; the busiest thread gained the most replies since the sample before. Samples are kept for 24 hours, on this computer.',
    }),
    o.onOpen4stats
      ? h(
          'p',
          { class: 'stats-fourstats__line' },
          icon('chart'),
          'For detailed 4chan stats, with history for every board: ',
          h('button', { type: 'button', class: 'link-btn', 'data-key': `${o.keyPrefix || ''}stats-4stats`, onclick: o.onOpen4stats, text: '4stats.io' }),
        )
      : null,
  );
}

const COUNTER_ROWS = [
  { key: 'time', label: 'Time spent', fmt: formatDuration },
  { key: 'threads', label: 'Threads opened' },
  { key: 'read', label: 'Posts read' },
  { key: 'posts', label: 'Posts made' },
  { key: 'replies', label: 'Replies to you' },
  { key: 'files', label: 'Files viewed' },
  { key: 'saved', label: 'Threads saved offline' },
];

const METRICS = [
  { key: 'time', label: 'Time spent', fmt: formatDuration },
  { key: 'threads', label: 'Threads opened' },
  { key: 'read', label: 'Posts read' },
];

function barChart(mine, now, metric) {
  const m = METRICS.find((x) => x.key === metric) || METRICS[0];
  const fmt = m.fmt || fmtCount;
  const series = dailySeries(mine, now, 30, m.key);
  const w = 300;
  const hgt = 80;
  const list = bars(series, w, hgt);
  const total = series.reduce((n, s) => n + s.value, 0);
  const top = series.reduce((a, s) => (s.value > (a?.value || 0) ? s : a), null);
  const label = top ? `${m.label} per day, last 30 days: ${fmt(total)} in all, the most on ${dayLabel(top.day)} (${fmt(top.value)})` : `${m.label} per day, last 30 days: nothing yet`;
  return h(
    'figure',
    { class: 'stats-chart' },
    svg(
      'svg',
      { class: 'stats-chart__svg', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
      svg('title', {}, document.createTextNode(label)),
      list.map((b) =>
        svg('rect', { class: b.value ? 'stats-chart__bar' : 'stats-chart__bar stats-chart__bar--none', x: b.x, y: b.y, width: b.w, height: b.h, rx: 1 }, svg('title', {}, document.createTextNode(`${dayLabel(b.day)}: ${fmt(b.value)}`))),
      ),
    ),
    h('figcaption', { class: 'stats-chart__axis', 'aria-hidden': 'true' }, h('span', { text: dayLabel(series[0].day) }), h('span', { text: 'Today' })),
  );
}

function minePanel({ mine, on, now, view, keyPrefix, hue, onMetric, onMineToggle, onDeleteMine, onOpenBoard }) {
  const has = Object.keys(mine.days).length > 0;
  const periods = [
    { label: 'Today', t: totals(mine, now, 1) },
    { label: 'Last 7 days', t: totals(mine, now, 7) },
    { label: 'Last 30 days', t: totals(mine, now, 30) },
  ];
  const top = topBoards(mine, now, 30, 5);
  return h(
    'div',
    { class: 'stats__panel' },
    h('p', { class: 'stats__promise' }, icon('shield'), 'Your stats stay on this computer: nothing is sent anywhere.'),
    on
      ? null
      : h(
          'div',
          { class: 'callout' },
          icon('info'),
          h(
            'div',
            {},
            h('strong', { text: has ? 'Counting is off: what is here stays until you delete it. ' : 'Counting your own activity is off. ' }),
            'When on, CloverEye counts per day the time you spend in it, threads opened, posts read and made, replies to you, files viewed and threads saved, and keeps 90 days. ',
            h('button', { type: 'button', class: 'link-btn', 'data-key': `${keyPrefix}stats-mine-on`, onclick: () => onMineToggle(true), text: 'Turn it on' }),
          ),
        ),
    has || on
      ? h(
          'div',
          { class: 'stats-cards' },
          periods.map((p) =>
            h(
              'section',
              { class: 'stats-card', 'aria-label': p.label },
              h('h3', { class: 'stats-card__title', text: p.label }),
              h(
                'dl',
                { class: 'stats-card__list' },
                COUNTER_ROWS.map((c) => h('div', { class: 'stats-card__row' }, h('dt', { text: c.label }), h('dd', { text: (c.fmt || fmtCount)(p.t[c.key]) }))),
              ),
            ),
          ),
        )
      : null,
    has || on
      ? h(
          'section',
          { class: 'stats-section', 'aria-labelledby': `${keyPrefix}stats-days-h` },
          h('h3', { class: 'stats-section__title', id: `${keyPrefix}stats-days-h`, text: 'Per day' }),
          h(
            'div',
            { class: 'stats-metrics', role: 'group', 'aria-label': 'What the chart shows' },
            METRICS.map((m) =>
              h('button', {
                type: 'button',
                class: 'btn btn--sm',
                'aria-pressed': String(view.metric === m.key),
                'data-key': `${keyPrefix}stats-metric-${m.key}`,
                onclick: () => onMetric(m.key),
                text: m.label,
              }),
            ),
          ),
          barChart(mine, now, view.metric),
        )
      : null,
    top.length
      ? h(
          'section',
          { class: 'stats-section', 'aria-labelledby': `${keyPrefix}stats-top-h` },
          h('h3', { class: 'stats-section__title', id: `${keyPrefix}stats-top-h`, text: 'Top boards, last 30 days' }),
          h(
            'ol',
            { class: 'stats-top' },
            top.map((b) =>
              h(
                'li',
                { class: 'stats-top__row' },
                h(
                  'button',
                  { type: 'button', class: 'stats-table__open', 'data-key': `${keyPrefix}stats-top-${b.board}`, 'aria-label': `Open /${b.board}/`, onclick: () => onOpenBoard(b.board) },
                  h('span', { class: 'board-tag', style: { '--hue': hue(b.board) }, text: `/${b.board}/` }),
                ),
                h('span', { class: 'stats-top__time', text: formatDuration(b.time) }),
                h('span', { class: 'stats-top__threads', text: b.threads === 1 ? '1 thread opened' : `${fmtCount(b.threads)} threads opened` }),
              ),
            ),
          ),
        )
      : null,
    h('p', {
      class: 'field__hint',
      text: 'Time counts while a CloverEye window is focused and visible, in 15-second steps. Posts read are posts newly marked read as they scroll past. Files viewed counts files shown in the gallery, opened in a thread with a click, or previewed on hover. A reply to you counts once, when it first shows up.',
    }),
    has
      ? h(
          'div',
          { class: 'inline' },
          h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}stats-delete-mine`, onclick: (e) => onDeleteMine(e.currentTarget) }, icon('trash'), 'Delete my stats'),
        )
      : null,
  );
}

/**
 * The pane's content.
 * @param {object} o
 * @param {{tab: string, sort: string, dir: string, metric: string}} o.view   this pane's choices
 * @param {string[]} o.boards       the boards to list (NSFW ones only while those are shown)
 * @param {object} o.store          board samples (stats-model.js)
 * @param {object} o.mine           your counts (my-stats-model.js)
 * @param {boolean} o.mineOn        Settings → Stats → Count my own activity
 * @param {boolean} o.trackOn       Settings → Stats → Track board activity
 * @param {Function} [o.onOpen4stats] opens 4stats.io in the system browser
 * @param {object} o.status         the sampler's (stats.js)
 */
export function statsView(o) {
  const { view, keyPrefix = '', status, isMain, now = Date.now() } = o;
  const trackOn = o.trackOn !== false;
  const tab = (key, label) =>
    h('button', {
      type: 'button',
      class: 'btn btn--sm',
      'aria-pressed': String(view.tab === key),
      'data-key': `${keyPrefix}stats-tab-${key}`,
      onclick: () => o.onTab(key),
      text: label,
    });
  return h(
    'div',
    { class: 'browse stats', 'data-stats-host': '' },
    h(
      'div',
      { class: 'browse__tools' },
      h('div', { class: 'stats-tabs', role: 'group', 'aria-label': 'Stats' }, tab('boards', 'Boards'), tab('you', 'You')),
      view.tab === 'boards' && trackOn
        ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}stats-refresh`, title: o.refreshKeys || null, onclick: o.onRefresh }, icon('refresh'), 'Sample now')
        : null,
    ),
    view.tab === 'boards' && trackOn ? h('p', { class: 'stats__status', role: 'status', 'data-stats-status': '', text: statusText(status, { isMain, now }) }) : null,
    view.tab === 'boards' ? (trackOn ? boardsPanel({ ...o, now }) : boardsOffPanel(o)) : minePanel({ mine: o.mine, on: o.mineOn, now, view, keyPrefix, hue: o.hue, onMetric: o.onMetric, onMineToggle: o.onMineToggle, onDeleteMine: o.onDeleteMine, onOpenBoard: o.onOpenBoard }),
  );
}
