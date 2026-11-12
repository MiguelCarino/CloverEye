// Settings, inside the shell. Look (theme, density, text size), Content
// (NSFW boards, which setup never asks about) and Filters (filters-view.js)
// save as soon as they change.

import * as M from './setup-model.js';
import { h, icon, toast, copyText } from './dom.js';
import { applyLook } from './look.js';
import { askAdult } from './setup.js';
import { themePicker } from './theme-picker.js';
import { LANGS, t } from './i18n.js';
import { VERSION } from './version.js';
import { filtersSection } from './filters-view.js';
import { SAUCE_ENGINES } from './sauce-model.js';
import { ARCHIVES, ARCHIVE_OFF, archivesFor } from './archive-model.js';
import { normalizeDisplay } from './display-model.js';
import { normalizeStatsSettings, SAMPLE_INTERVALS } from './stats-model.js';
import { assistantControls } from './ai-setup-view.js';

function segmented(key, label, options, value, onChange) {
  const id = `set-seg-${key}`;
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field__label', id, text: label }),
    h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-labelledby': id },
      options.map((o) =>
        h(
          'label',
          {},
          h('input', {
            type: 'radio',
            name: `set-${key}`,
            value: String(o.value),
            checked: o.value === value,
            'data-key': `${key}-${o.value}`,
            onchange: () => onChange(o.value),
          }),
          h('span', { text: o.label }),
        ),
      ),
    ),
  );
}

/**
 * @param {object} o
 * @param {object} o.settings        current settings
 * @param {Array|null} o.boards      board list, if loaded this session
 * @param {(next: object, how?: {redraw?: boolean, focus?: string}) => void} o.onChange  saves and keeps the new settings
 * @param {() => void} o.onRunSetup
 * @param {(opener: Element) => void} [o.onDeleteMyStats]  asks, then deletes your own stats
 * @param {{detect: object, onDetect: (port?: number) => void}|null} [o.assistant]  Settings → Assistant (ai-setup-view.js)
 * @param {{text: () => Promise<string>, save: () => Promise<string>}|null} [o.diagnostics]
 */
export function renderSettings({ settings, boards, onChange, onRunSetup, onDeleteMyStats = null, assistant = null, diagnostics = null }) {
  const s = settings;
  const look = (mutate) => {
    const next = structuredClone(s);
    mutate(next);
    applyLook(next);
    onChange(next, { redraw: false });
    Object.assign(s, next); // the radios already show it; no redraw needed
  };
  const nsfwOn = M.nsfwVisible(s);
  const confirmed = s.nsfw.confirmedAdultAt ? new Date(s.nsfw.confirmedAdultAt) : null;

  return h(
    'div',
    { class: 'settings' },
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-look' },
      h('h2', { class: 'settings__heading', id: 'set-look', text: 'Look' }),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'set-lang', text: 'Language' }),
        h(
          'select',
          {
            id: 'set-lang',
            class: 'input input--short',
            'data-key': 'set-lang',
            onchange: (e) => look((n) => (n.lang = e.target.value)),
          },
          h('option', { value: 'system', selected: s.lang === 'system', text: 'Same as the system' }),
          // each language in its own name: never translated
          LANGS.map((l) => h('option', { value: l.code, selected: s.lang === l.code, translate: 'no', text: l.name })),
        ),
      ),
      themePicker({ value: s.theme, onChange: (v) => look((n) => (n.theme = v)) }),
      segmented(
        'density',
        'Density',
        [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ],
        s.density,
        (v) => look((n) => (n.density = v)),
      ),
      segmented('text', 'Text size', M.TEXT_SCALES, s.textScale, (v) => look((n) => (n.textScale = v))),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-hover-t', text: 'Preview files on hover' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-hover-d',
            text: 'Resting the mouse on a thumbnail shows the full image, or plays the video muted, as large as the window allows.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(s.ui?.hoverPreview !== false),
          'aria-labelledby': 'sw-hover-t',
          'aria-describedby': 'sw-hover-d',
          'data-key': 'switch-hover',
          onclick: () => {
            const next = structuredClone(s);
            next.ui = { ...next.ui, hoverPreview: s.ui?.hoverPreview === false };
            applyLook(next);
            onChange(next, { focus: 'switch-hover' });
          },
        }),
      ),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-idcolour-t', text: 'Colour poster IDs' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-idcolour-d',
            text: 'On boards that show poster IDs, each ID gets a colour of its own, so one poster’s posts stand out. Clicking an ID highlights them all.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(s.ids?.colour !== false),
          'aria-labelledby': 'sw-idcolour-t',
          'aria-describedby': 'sw-idcolour-d',
          'data-key': 'switch-idcolour',
          onclick: () => {
            const next = structuredClone(s);
            next.ids = { ...next.ids, colour: s.ids?.colour === false };
            onChange(next, { focus: 'switch-idcolour' });
          },
        }),
      ),
      segmented(
        'quotelinks',
        'Quote links',
        [
          { value: 'inline', label: 'Expand inline' },
          { value: 'jump', label: 'Jump to post' },
        ],
        s.quotes?.links || 'inline',
        (v) => look((n) => (n.quotes = { ...n.quotes, links: v })),
      ),
      h('p', { class: 'field__hint', text: 'Clicking >>123 in a thread opens that post right below the link, or scrolls to it. Ctrl or ⌘ while clicking does the other.' }),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-quoteprev-t', text: 'Preview quoted posts' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-quoteprev-d',
            text: 'Resting the mouse on a quote link, or tabbing to it, shows the quoted post beside the link. Esc hides it.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(s.quotes?.preview !== false),
          'aria-labelledby': 'sw-quoteprev-t',
          'aria-describedby': 'sw-quoteprev-d',
          'data-key': 'switch-quote-preview',
          onclick: () => {
            const next = structuredClone(s);
            next.quotes = { ...next.quotes, preview: s.quotes?.preview === false };
            applyLook(next);
            onChange(next, { focus: 'switch-quote-preview' });
          },
        }),
      ),
    ),
    postsSection(s, onChange),
    replySection(s, onChange),
    filesSection(s, onChange),
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-content' },
      h('h2', { class: 'settings__heading', id: 'set-content', text: 'Content' }),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-nsfw-t', text: 'Show NSFW boards' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-nsfw-d',
            text: 'Boards the site marks as not worksafe. While this is off they never appear in board lists, favourites or search. Turning it on asks you to confirm you are 18 or older; turning it off forgets that.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(nsfwOn),
          'aria-labelledby': 'sw-nsfw-t',
          'aria-describedby': 'sw-nsfw-d',
          'data-key': 'switch-nsfw',
          onclick: (e) => {
            if (M.nsfwVisible(s)) {
              onChange(M.setNsfw(s, false, { boards }), { focus: 'switch-nsfw' });
              toast('NSFW boards hidden');
            } else {
              askAdult(e.currentTarget, () => {
                onChange(M.setNsfw(s, true, { confirmedAdult: true }), { focus: 'switch-nsfw' });
                toast('NSFW boards will be shown');
              });
            }
          },
        }),
      ),
      h(
        'div',
        { class: 'state-line' },
        nsfwOn
          ? h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'All boards, NSFW included')
          : h('span', { class: 'pill pill--ok' }, h('span', { class: 'dot' }), 'Worksafe boards only'),
        nsfwOn && confirmed ? h('span', { text: `18+ confirmed ${confirmed.toLocaleDateString()}` }) : null,
      ),
      segmented(
        'embeds',
        'Embeds',
        [
          { value: 'off', label: 'Off' },
          { value: 'click', label: 'Click to load' },
        ],
        s.embeds?.mode || 'click',
        (v) => {
          const next = structuredClone(s);
          next.embeds = { mode: v };
          onChange(next, { focus: `embeds-${v}` });
        },
      ),
      h('p', {
        class: 'field__hint',
        text: 'Web addresses in posts are links that open in your browser. With Click to load, YouTube, Vimeo, Streamable and SoundCloud links also get an Embed button that plays them in a small player in the corner; nothing is loaded from those sites until you click it. Twitter and X links stay links.',
      }),
    ),
    statsSection(s, onChange, onDeleteMyStats),
    sauceSection(s, onChange),
    archiveSection(s, boards, onChange),
    filtersSection({ settings: s, onChange }),
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-setup' },
      h('h2', { class: 'settings__heading', id: 'set-setup', text: 'Setup' }),
      h('p', { class: 'field__hint', text: 'Walk through the first-time steps again: look, favourites, video, watching, files.' }),
      h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn', 'data-key': 'rerun', onclick: () => onRunSetup() }, icon('refresh'), 'Run setup again')),
    ),
    assistant
      ? h(
          'section',
          { class: 'settings__section', 'aria-labelledby': 'set-ai', id: 'set-ai-section' },
          h('h2', { class: 'settings__heading', id: 'set-ai', text: 'Assistant' }),
          h('p', { class: 'field__hint', text: 'Ask questions about the catalogs and threads you have open, answered by an AI model running on this computer.' }),
          assistantControls({
            ai: s.ai,
            detect: assistant.detect,
            full: true,
            onChange: (ai) => {
              const next = structuredClone(s);
              next.ai = ai;
              onChange(next, { focus: document.activeElement?.dataset?.key || null });
            },
            onDetect: (port) => assistant.onDetect(port),
          }),
        )
      : null,
    diagnostics ? diagnosticsSection(diagnostics) : null,
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-about' },
      h('h2', { class: 'settings__heading', id: 'set-about', text: 'About' }),
      h('p', { class: 'settings__version', 'data-key': 'version' }, h('strong', { translate: 'no', text: `CloverEye ${VERSION}` })),
      h('p', { class: 'field__hint', text: 'Free software under the AGPL-3.0. Not affiliated with or endorsed by 4chan.' }),
    ),
  );
}

/** A labelled on/off switch for one field of settings.display
 *  (display-model.js). */
function displaySwitch(s, onChange, { key, title, desc, field }) {
  const on = Boolean(s.display?.[field]);
  return h(
    'div',
    { class: 'switch-row' },
    h(
      'div',
      { class: 'switch-row__text' },
      h('div', { class: 'switch-row__title', id: `sw-${key}-t`, text: title }),
      h('div', { class: 'switch-row__desc', id: `sw-${key}-d`, text: desc }),
    ),
    h('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': String(on),
      'aria-labelledby': `sw-${key}-t`,
      'aria-describedby': `sw-${key}-d`,
      'data-key': `switch-${key}`,
      onclick: () => {
        const next = structuredClone(s);
        next.display = { ...normalizeDisplay(next.display), [field]: !on };
        applyLook(next);
        onChange(next, { focus: `switch-${key}` });
      },
    }),
  );
}

/** Posts: how times read, spoilers, work mode, images opened in threads,
 *  the gallery's preloading and anonymised names (display-model.js). */
function postsSection(s, onChange) {
  const d = normalizeDisplay(s.display);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-posts' },
    h('h2', { class: 'settings__heading', id: 'set-posts', text: 'Posts' }),
    segmented(
      'timestamps',
      'Timestamps',
      [
        { value: 'local', label: 'Local time' },
        { value: 'relative', label: 'Relative' },
        { value: 'board', label: 'Board time' },
      ],
      d.time,
      (v) => {
        const next = structuredClone(s);
        next.display = { ...d, time: v };
        onChange(next, { focus: `timestamps-${v}` });
      },
    ),
    h('p', {
      class: 'field__hint',
      text: 'Local time shows when each post was made in your time and language. Relative shows its age, “3 min ago”, kept up to date, with the full time on hover. Board time shows the time as the site writes it.',
    }),
    displaySwitch(s, onChange, {
      key: 'spoilers',
      field: 'revealSpoilers',
      title: 'Reveal spoilers',
      desc: 'Spoilered images show their real thumbnail, and spoiler text is shown without the black bar (still marked).',
    }),
    displaySwitch(s, onChange, {
      key: 'hideimages',
      field: 'hideImages',
      title: 'Hide images (work mode)',
      desc: 'Files in threads become one line with the file’s name; click it to show that one file. Catalog cards show a placeholder instead of the picture.',
    }),
    displaySwitch(s, onChange, {
      key: 'autoexpand',
      field: 'autoExpand',
      title: 'Expand images in threads',
      desc: 'Images open at full size in place as the thread is drawn, fitted to the pane and the window. Videos still wait for a click.',
    }),
    displaySwitch(s, onChange, {
      key: 'preload',
      field: 'galleryPreload',
      title: 'Preload in the gallery',
      desc: 'The gallery starts loading the next and previous images while you look at one, so moving is instant. Videos are not preloaded.',
    }),
    displaySwitch(s, onChange, {
      key: 'anonymize',
      field: 'anonymize',
      title: 'Anonymize names',
      desc: 'Every name and tripcode shows as Anonymous. Poster IDs and flags stay; filters still match the real names.',
    }),
  );
}

/** Files: where downloads and saved threads go. A folder is kept when it
 *  is a full path (setup-model.js normalizeFolder) or left empty. */
function filesSection(s, onChange) {
  const folder = ({ key, field, label, placeholder, hint }) => {
    const id = `set-${key}`;
    const errId = `${id}-err`;
    return h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: id, text: label }),
      h('input', {
        id,
        class: 'input',
        type: 'text',
        placeholder,
        value: s.files?.[field] || '',
        spellcheck: 'false',
        autocomplete: 'off',
        'data-key': id,
        onchange: (e) => {
          const raw = e.target.value.trim();
          const row = e.target.closest('.field');
          row.querySelector('.field__error')?.remove();
          e.target.removeAttribute('aria-invalid');
          const dir = M.normalizeFolder(raw);
          if (raw && !dir) {
            e.target.setAttribute('aria-invalid', 'true');
            e.target.setAttribute('aria-describedby', errId);
            row.append(h('p', { class: 'field__error', id: errId, role: 'alert', text: 'Enter a full folder path, or leave it empty for the default.' }));
            return;
          }
          const next = structuredClone(s);
          next.files = { ...next.files, [field]: dir };
          onChange(next, { focus: id });
          toast(dir ? 'Folder saved' : 'The default folder is used');
        },
      }),
      h('p', { class: 'field__hint', text: hint }),
    );
  };
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-files' },
    h('h2', { class: 'settings__heading', id: 'set-files', text: 'Files' }),
    folder({
      key: 'downloadDir',
      field: 'downloadDir',
      label: 'Download folder',
      placeholder: 'Downloads/CloverEye',
      hint: 'Files saved from the gallery and Download all go here. Leave empty to use Downloads/CloverEye.',
    }),
    folder({
      key: 'savedDir',
      field: 'savedDir',
      label: 'Saved threads folder',
      placeholder: 'Downloads/CloverEye/Saved threads',
      hint: 'Save offline keeps each thread here, with its files, to read without the site. Leave empty to use Downloads/CloverEye/Saved threads.',
    }),
  );
}

/** Replying: what the reply form does with an attached file. */
function replySection(s, onChange) {
  const on = Boolean(s.post?.randomName);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-reply' },
    h('h2', { class: 'settings__heading', id: 'set-reply', text: 'Replying' }),
    h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row__text' },
        h('div', { class: 'switch-row__title', id: 'sw-randomname-t', text: 'Random file names' }),
        h('div', {
          class: 'switch-row__desc',
          id: 'sw-randomname-d',
          text: 'Files you attach go out under a random-looking name made of numbers, like 1731312345678.png, instead of their own name. The reply form can switch it for each post.',
        }),
      ),
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(on),
        'aria-labelledby': 'sw-randomname-t',
        'aria-describedby': 'sw-randomname-d',
        'data-key': 'switch-randomname',
        onclick: () => {
          const next = structuredClone(s);
          next.post = { ...(next.post || {}), randomName: !on };
          onChange(next, { focus: 'switch-randomname' });
        },
      }),
    ),
    h('p', { class: 'field__hint', text: 'To quote part of a post, select its text, then press the post’s No.: the reply starts with the selection as greentext.' }),
  );
}

/** A switch row (title, description) for one field of settings.stats. */
function statsSwitch(s, onChange, { key, field, title, desc }) {
  const st = normalizeStatsSettings(s.stats);
  return h(
    'div',
    { class: 'switch-row' },
    h(
      'div',
      { class: 'switch-row__text' },
      h('div', { class: 'switch-row__title', id: `sw-${key}-t`, text: title }),
      h('div', { class: 'switch-row__desc', id: `sw-${key}-d`, text: desc }),
    ),
    h('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': String(st[field]),
      'aria-labelledby': `sw-${key}-t`,
      'aria-describedby': `sw-${key}-d`,
      'data-key': `switch-${key}`,
      onclick: () => {
        const next = structuredClone(s);
        next.stats = { ...st, [field]: !st[field] };
        onChange(next, { focus: `switch-${key}` });
      },
    }),
  );
}

/** Stats (stats-model.js, my-stats-model.js): background sampling of board
 *  activity, and counting your own activity; both off by default. */
function statsSection(s, onChange, onDeleteMyStats) {
  const st = normalizeStatsSettings(s.stats);
  const set = (patch, focus) => {
    const next = structuredClone(s);
    next.stats = { ...st, ...patch };
    onChange(next, { focus });
  };
  const scopes = [
    { value: 'favourites', label: 'Favourite boards' },
    { value: 'worksafe', label: 'All worksafe boards' },
  ];
  // every board, NSFW ones included, only while those are shown
  if (M.nsfwVisible(s) || st.scope === 'visible') scopes.push({ value: 'visible', label: 'All boards I can see' });
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-stats' },
    h('h2', { class: 'settings__heading', id: 'set-stats', text: 'Stats' }),
    statsSwitch(s, onChange, {
      key: 'stats-track',
      field: 'track',
      title: 'Track board activity',
      desc: 'Samples the catalogs of the boards below in the background, for the Stats pane: one board at a time, through the same request queue as everything else, only while none of your own requests is waiting. Off: the Stats pane uses only the catalogs you open.',
    }),
    st.track
      ? [
          segmented('stats-scope', 'Boards to sample', scopes, st.scope, (v) => set({ scope: v }, `stats-scope-${v}`)),
          segmented(
            'stats-interval',
            'Sample each board at most every',
            SAMPLE_INTERVALS.map((n) => ({ value: n, label: `${n} min` })),
            st.intervalMin,
            (v) => set({ intervalMin: v }, `stats-interval-${v}`),
          ),
          h('p', { class: 'field__hint', text: 'Sampling runs in the main window and pauses once it has been hidden for longer than this.' }),
        ]
      : null,
    statsSwitch(s, onChange, {
      key: 'stats-mine',
      field: 'mine',
      title: 'Count my own activity',
      desc: 'Per day, for 90 days: time spent in CloverEye, threads opened, posts read and made, replies to you, files viewed and threads saved, and time and threads per board. Shown under Stats → You.',
    }),
    h('p', { class: 'stats__promise' }, icon('shield'), 'Your stats stay on this computer: nothing is sent anywhere.'),
    onDeleteMyStats
      ? h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn', 'data-key': 'stats-delete-mine', onclick: (e) => onDeleteMyStats(e.currentTarget) }, icon('trash'), 'Delete my stats'))
      : null,
  );
}

/** Which reverse image search sites each file's Search menu offers. */
function sauceSection(s, onChange) {
  const on = new Set(s.sauce?.engines || []);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-sauce' },
    h('h2', { class: 'settings__heading', id: 'set-sauce', text: 'Reverse image search' }),
    h(
      'fieldset',
      { class: 'sauce-pick', 'aria-describedby': 'set-sauce-d' },
      h('legend', { class: 'visually-hidden', text: 'Sites in each file’s Search menu' }),
      SAUCE_ENGINES.map((e) =>
        h(
          'label',
          { class: 'checkline' },
          h('input', {
            type: 'checkbox',
            checked: on.has(e.id),
            'data-key': `sauce-${e.id}`,
            onchange: (ev) => {
              const next = structuredClone(s);
              const set = new Set(next.sauce?.engines || []);
              if (ev.target.checked) set.add(e.id);
              else set.delete(e.id);
              next.sauce = { engines: SAUCE_ENGINES.map((x) => x.id).filter((id) => set.has(id)) };
              onChange(next, { focus: `sauce-${e.id}` });
            },
          }),
          h('span', { translate: 'no', text: e.label }),
        ),
      ),
    ),
    h('p', {
      class: 'field__hint',
      id: 'set-sauce-d',
      text: 'Each file in a thread gets a Search menu with these sites; videos are searched by their thumbnail. The file’s address goes to the site you pick, in your browser, and nowhere until you pick one. With none ticked there is no menu.',
    }),
  );
}

// The board whose archive the Archives section shows (kept across redraws).
let archiveBoard = 'g';

/** Archive links: on or off, and which archive each board's links go to. */
function archiveSection(s, boardList, onChange) {
  const prefs = s.archives || { enabled: true, boards: {} };
  // NSFW boards stay out of the list (and the choices) while they are off
  const boards = M.visibleArchivedBoards(s, boardList);
  if (!boards.includes(archiveBoard)) archiveBoard = boards[0];
  const list = archivesFor(archiveBoard);
  const choice = prefs.boards?.[archiveBoard] || '';
  const save = (mutate, focus) => {
    const next = structuredClone(s);
    next.archives = { enabled: prefs.enabled !== false, boards: { ...prefs.boards } };
    mutate(next.archives);
    onChange(next, { focus });
  };
  const host = (id) => ARCHIVES.find((a) => a.id === id)?.host || id;
  const changed = Object.entries(prefs.boards || {}).filter(([b]) => boards.includes(b));
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-archives' },
    h('h2', { class: 'settings__heading', id: 'set-archives', text: 'Archives' }),
    h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row__text' },
        h('div', { class: 'switch-row__title', id: 'sw-archives-t', text: 'Links to archives' }),
        h('div', {
          class: 'switch-row__desc',
          id: 'sw-archives-d',
          text: 'Dead quote links, quotes of threads that are gone, and gone or archived threads get an “Open in archive” link to a third-party archive, opened in your browser. Nothing is fetched from the archive.',
        }),
      ),
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(prefs.enabled !== false),
        'aria-labelledby': 'sw-archives-t',
        'aria-describedby': 'sw-archives-d',
        'data-key': 'switch-archives',
        onclick: () => save((a) => (a.enabled = prefs.enabled === false), 'switch-archives'),
      }),
    ),
    h(
      'div',
      { class: 'archive-pick' },
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'set-archive-board', text: 'Board' }),
        h(
          'select',
          {
            id: 'set-archive-board',
            class: 'input input--short',
            'data-key': 'archive-board',
            disabled: prefs.enabled === false,
            onchange: (e) => {
              archiveBoard = e.target.value;
              onChange(s, { focus: 'archive-board' });
            },
          },
          boards.map((b) => h('option', { value: b, selected: b === archiveBoard, translate: 'no', text: `/${b}/` })),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'set-archive-pick', text: 'Archive' }),
        h(
          'select',
          {
            id: 'set-archive-pick',
            class: 'input input--short',
            'data-key': 'archive-pick',
            disabled: prefs.enabled === false,
            onchange: (e) =>
              save((a) => {
                if (e.target.value) a.boards[archiveBoard] = e.target.value;
                else delete a.boards[archiveBoard];
              }, 'archive-pick'),
          },
          h('option', { value: '', selected: !choice, text: `Automatic (${list[0]?.host || ''})` }),
          list.map((a) => h('option', { value: a.id, selected: choice === a.id, translate: 'no', text: a.host })),
          h('option', { value: ARCHIVE_OFF, selected: choice === ARCHIVE_OFF, text: 'Off' }),
        ),
      ),
    ),
    changed.length
      ? h(
          'div',
          { class: 'archive-changed' },
          h('span', { class: 'field__hint', text: 'Your choices:' }),
          changed.map(([b, id]) =>
            h(
              'button',
              {
                type: 'button',
                class: 'pill archive-changed__item',
                'data-key': `archive-reset-${b}`,
                'aria-label': `Use the automatic archive for /${b}/`,
                title: `Use the automatic archive for /${b}/`,
                onclick: () => save((a) => delete a.boards[b], 'archive-board'),
              },
              h('span', { translate: 'no', text: `/${b}/ ` }),
              id === ARCHIVE_OFF ? h('span', { text: 'Off' }) : h('span', { translate: 'no', text: host(id) }),
              icon('x'),
            ),
          ),
        )
      : null,
    h('p', {
      class: 'field__hint',
      text: 'Each board uses the first archive that keeps it unless you pick another. The list is built in and kept by hand, so an archive may have moved or closed since.',
    }),
  );
}

/** Diagnostics: one text file to attach to a bug report (src-tauri/src/diag.rs). */
function diagnosticsSection(diag) {
  const status = h('p', { class: 'field__hint', 'data-key': 'diag-status', 'aria-live': 'polite', hidden: true });
  const say = (text) => {
    status.textContent = text;
    status.hidden = false;
  };
  const busy = async (btn, job) => {
    btn.disabled = true;
    try {
      await job();
    } catch (e) {
      say(t('Couldn’t make the diagnostics: {0}', String(e?.message ?? e)));
    } finally {
      btn.disabled = false;
    }
  };
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-diag' },
    h('h2', { class: 'settings__heading', id: 'set-diag', text: 'Diagnostics' }),
    h('p', {
      class: 'field__hint',
      text: 'If something goes wrong, attach a diagnostics file to your report. It lists CloverEye’s and the system’s versions, recent WebKit crashes and what the post helper did this session and the one before. It has no posts, captcha answers, cookies or passwords.',
    }),
    h(
      'div',
      { class: 'inline' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-key': 'diag-save',
          onclick: (e) =>
            busy(e.currentTarget, async () => {
              const path = await diag.save();
              say(t('Saved to {0}', path));
              toast('Diagnostics saved');
            }),
        },
        icon('download'),
        'Save diagnostics file',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-key': 'diag-copy',
          onclick: (e) =>
            busy(e.currentTarget, async () => {
              const ok = await copyText(await diag.text());
              toast(ok ? 'Diagnostics copied' : 'Couldn’t copy. Save the file instead.');
            }),
        },
        icon('copy'),
        'Copy diagnostics',
      ),
    ),
    status,
  );
}
