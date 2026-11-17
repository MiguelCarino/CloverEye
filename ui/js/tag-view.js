// Tags for lurking (tag-model.js): the chips over a catalog, the editor,
// and a tag's own page (its finds across boards, and in the library when
// it looks there too).

import * as T from './tag-model.js';
import { h, icon } from './dom.js';
import { confirmDialog } from './offline.js';
import { commentText } from './render.js';
import * as B from './browse-model.js';
import { postFlag } from './bridge.js';

/** Title or excerpt runs (browse-model.js) with spoiler text in a
 *  .seg-spoiler span, hidden until hovered or revealed, as on catalog cards. */
const runsEl = (runs) => runs.map((r) => (r.spoiler ? h('span', { class: 'seg-spoiler', text: r.text }) : r.text));

/**
 * The tag chips in a catalog's bar: press one to show only its threads.
 * @param {object} o
 * @param {string} o.board
 * @param {Array} o.tags          tagsFor(...)
 * @param {Map} o.labels          labelThreads(...)
 * @param {string} o.active       the tag shown ('' none)
 * @param {(id: string) => void} o.onPick
 * @param {(tag?: object) => void} o.onEdit   no tag: a new one
 * @param {(tag: object) => void} o.onPage    the tag's own page
 */
export function tagChips({ board, tags, labels, active, onPick, onToggle, onEdit, onPage, query = '', keyPrefix: k = '' }) {
  const count = (id) => [...labels.values()].filter((list) => list.some((t) => t.id === id)).length;
  const on = tags.find((t) => t.id === active) || null;
  const what = (t) => [...t.terms, ...(t.flags || [])].join(', ');
  const where = (t) => (t.board ? `Only /${board}/: ${what(t)}` : `Every active board: ${what(t)}`);
  return h(
    'div',
    { class: 'catalog-tags', role: 'group', 'aria-label': 'Tags' },
    tags.map((t) => {
      // a show tag, pressed: only its threads; a hide tag, on: what it finds
      // is hidden (here and in threads) until it is switched off
      const hide = t.mode === 'hide';
      const pressed = hide ? t.on : t.id === active;
      return h(
        'button',
        {
          type: 'button',
          class: `library__tag catalog-tags__tag${pressed ? ' library__tag--on' : ''}${hide ? ' catalog-tags__tag--hide' : ''}`,
          'aria-pressed': String(pressed),
          title: hide ? (t.on ? `Hiding: ${where(t)} · double-click to edit` : `Not hiding: ${where(t)} · double-click to edit`) : `${where(t)} · double-click to edit`,
          'data-key': `${k}tag-${t.id}`,
          onclick: () => (hide ? onToggle(t) : onPick(t.id === active ? '' : t.id)),
          ondblclick: (e) => {
            e.preventDefault();
            onEdit(t);
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            onEdit(t);
          },
        },
        hide ? icon(t.on ? 'eyeOff' : 'eye') : t.board ? null : icon('grid'),
        h('span', { translate: 'no', text: t.name }),
        h('span', { class: 'library__tag-n', text: String(count(t.id)) }),
      );
    }),
    on
      ? [
          // editing: a double-click on the chip
          !on.board || on.library
            ? h(
                'button',
                { type: 'button', class: 'link-btn', title: on.board ? 'Its threads and its library files on one page' : 'Its threads on every active board, on one page', 'data-key': `${k}tag-page`, onclick: () => onPage(on) },
                on.board ? 'With the library' : 'Across boards',
              )
            : null,
        ]
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--sm',
        // what is typed in the search box becomes the new tag's words
        title: query.trim() ? `Make a tag of “${query.trim()}”: show only it, or hide it` : 'A tag finds threads by their words: show only them, or hide them',
        'data-key': `${k}tag-new`,
        onclick: () => onEdit(null),
      },
      icon('plus'),
      'Tag',
    ),
  );
}

/** The labels on a catalog card: the tags its thread matches. */
export function cardLabels(hits) {
  if (!hits?.length) return null;
  return h(
    'span',
    { class: 'catalog-card__tags' },
    hits.slice(0, 3).map((t) => h('span', { class: 'catalog-card__tag', translate: 'no', text: t.name })),
  );
}

/**
 * The editor: a tag's name, words, where it looks. Resolves with the tag,
 * { deleted: true }, or null (cancelled).
 */
export function editTag({ tag = null, board = '', opener = null, terms: given = '', flagList = [] }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      d.remove();
      opener?.isConnected && opener.focus({ preventScroll: true });
      resolve(v);
    };
    const seed = String(given || '').trim();
    const name = h('input', { class: 'input', id: 'tag-name', value: tag?.name || seed.slice(0, 40), maxlength: '40', placeholder: 'rust', 'data-key': 'tag-name' });
    const terms = h('textarea', { class: 'input', id: 'tag-terms', rows: '3', placeholder: 'rust, cargo, borrow checker', 'data-key': 'tag-terms' });
    terms.value = tag?.terms?.join(', ') || seed;
    // Show or Hide, at the top: the window turns green or red with it, and
    // the line under the fields says what the tag will do
    const radio = (value, checked) => h('input', { type: 'radio', name: 'tag-mode', value, checked, class: 'visually-hidden', 'data-key': `tag-mode-${value}`, onchange: () => paintMode() });
    const showMode = radio('show', (tag?.mode || 'show') === 'show');
    const hideMode = radio('hide', tag?.mode === 'hide');
    const modeHint = h('p', { class: 'tag-dialog__mode-hint', 'aria-live': 'polite' });
    const paintMode = () => {
      const hide = hideMode.checked;
      d.classList.toggle('tag-dialog--hide', hide);
      d.classList.toggle('tag-dialog--show', !hide);
      modeHint.textContent = hide ? 'Hides what it finds: threads, and posts in threads (stays on until you press it again)' : 'Shows only the threads it finds';
    };
    const whole = h('input', { type: 'checkbox', checked: Boolean(tag?.whole), 'data-key': 'tag-whole' });
    // flags (boards that have them): picked ones on top, the rest to search
    const chosen = new Set(tag?.flags || []);
    const flagValue = (c) => (c.kind === 'country' ? c.code : c.name);
    let flagQuery = '';
    const flagBox = h('div', { class: 'tag-dialog__flags' });
    const flagPic = (c) => {
      const f = postFlag(c.board || board || 'int', c.kind === 'country' ? { country: c.code, country_name: c.name } : { board_flag: c.code, flag_name: c.name }, true);
      return f?.src ? h('img', { src: f.src, alt: '', width: 16, height: 11, loading: 'lazy', onerror: (e) => e.currentTarget.remove() }) : null;
    };
    const paintFlags = () => {
      const q = flagQuery.trim().toLowerCase();
      const picked = flagList.filter((c) => chosen.has(flagValue(c)));
      // flags kept from before that this board does not list stay pickable off
      const extra = [...chosen].filter((v) => !flagList.some((c) => flagValue(c) === v));
      const rest = flagList.filter((c) => !chosen.has(flagValue(c)) && (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q));
      const toggle = (v) => {
        if (chosen.has(v)) chosen.delete(v);
        else chosen.add(v);
        paintFlags();
      };
      flagBox.replaceChildren(
        picked.length || extra.length
          ? h(
              'ul',
              { class: 'tag-dialog__picked', 'aria-label': 'Flags picked' },
              picked.map((c) =>
                h('li', null, h('button', { type: 'button', class: 'library__tag library__tag--on', title: 'Take this flag out', 'data-key': `tag-flag-off-${c.code}`, onclick: () => toggle(flagValue(c)) }, flagPic(c), h('span', { text: c.name }), icon('x'))),
              ),
              extra.map((v) => h('li', null, h('button', { type: 'button', class: 'library__tag library__tag--on', title: 'Take this flag out', onclick: () => toggle(v) }, h('span', { translate: 'no', text: v }), icon('x')))),
            )
          : null,
        h('input', {
          type: 'search',
          class: 'input',
          placeholder: 'Find a flag: country or code',
          'aria-label': 'Find a flag',
          value: flagQuery,
          'data-key': 'tag-flag-search',
          oninput: (e) => {
            flagQuery = e.target.value;
            const at = e.target.selectionStart;
            paintFlags();
            const again = flagBox.querySelector('[data-key="tag-flag-search"]');
            again?.focus();
            again?.setSelectionRange(at, at);
          },
        }),
        h(
          'ul',
          { class: 'flag-pick__list', 'aria-label': 'Flags' },
          rest.slice(0, 400).map((c) =>
            h(
              'li',
              null,
              h(
                'button',
                { type: 'button', class: 'flag-pick__item', title: `${c.name} (${c.code})`, 'data-key': `tag-flag-${c.code}`, onclick: () => toggle(flagValue(c)) },
                flagPic(c),
                h('span', { class: 'flag-pick__name', text: c.name }),
                h('span', { class: 'flag-pick__code', translate: 'no', text: c.kind === 'board' ? `/${c.board}/` : c.code }),
              ),
            ),
          ),
        ),
      );
    };
    if (flagList.length || chosen.size) paintFlags();
    const universal = h('input', { type: 'radio', name: 'tag-where', value: 'all', checked: tag ? !tag.board : !board, 'data-key': 'tag-where-all' });
    const here = board || tag?.board;
    const onBoard = here ? h('input', { type: 'radio', name: 'tag-where', value: 'board', checked: Boolean(tag ? tag.board : board), 'data-key': 'tag-where-board' }) : null;
    const library = h('input', { type: 'checkbox', checked: Boolean(tag?.library), 'data-key': 'tag-library' });
    const err = h('p', { class: 'field__error', role: 'alert', hidden: true });
    const save = () => {
      const next = T.normalizeTag({
        id: tag?.id,
        name: name.value,
        terms: terms.value,
        board: onBoard?.checked ? here : '',
        library: library.checked,
        mode: hideMode.checked ? 'hide' : 'show',
        // a hide tag made or switched to hide starts at work
        on: hideMode.checked && tag?.mode === 'hide' ? tag.on : true,
        whole: whole.checked,
        flags: [...chosen],
      });
      if (!next) {
        err.hidden = false;
        err.textContent = flagList.length ? 'A tag needs a name, and at least one word or flag.' : 'A tag needs a name and at least one word.';
        return;
      }
      finish(next);
    };
    const d = h(
      'dialog',
      { class: 'tag-dialog', 'aria-labelledby': 'tag-title' },
      h(
        'form',
        { class: 'dialog__body tag-dialog__form', onsubmit: (e) => (e.preventDefault(), save()) },
        h(
          'div',
          { class: 'tag-dialog__head' },
          h('h2', { class: 'dialog__title', id: 'tag-title', text: tag ? 'Edit tag' : 'New tag' }),
          h(
            'div',
            { class: 'tag-dialog__mode', role: 'radiogroup', 'aria-label': 'What the tag does' },
            h('label', { class: 'tag-dialog__mode-opt tag-dialog__mode-opt--show' }, showMode, icon('eye'), h('span', { text: 'Show' })),
            h('label', { class: 'tag-dialog__mode-opt tag-dialog__mode-opt--hide' }, hideMode, icon('eyeOff'), h('span', { text: 'Hide' })),
          ),
        ),
        h('label', { class: 'field__label', for: 'tag-name', text: 'Name' }),
        name,
        h('label', { class: 'field__label', for: 'tag-terms', text: 'Words to find' }),
        terms,
        h('p', { class: 'field__hint', text: 'Commas between words or phrases; any of them finds a thread. -word leaves out threads with it; /pattern/ is a regular expression.' }),
        h('label', { class: 'checkline' }, whole, h('span', { text: 'Whole words only (“art” does not find “start”)' })),
        flagList.length || chosen.size
          ? h(
              'fieldset',
              { class: 'tag-dialog__where' },
              h('legend', { class: 'field__label', text: 'Flags to find' }),
              h('p', { class: 'field__hint', text: 'Posts with any of these flags; words and flags both count.' }),
              flagBox,
            )
          : null,
        h(
          'fieldset',
          { class: 'tag-dialog__where' },
          h('legend', { class: 'field__label', text: 'Looks in' }),
          onBoard ? h('label', { class: 'checkline' }, onBoard, h('span', { text: `/${here}/ only` })) : null,
          h('label', { class: 'checkline' }, universal, h('span', { text: 'Every active board (favourites and open boards)' })),
          h('label', { class: 'checkline' }, library, h('span', { text: 'Also the library (its files’ names, tags and threads)' })),
        ),
        modeHint,
        err,
        h(
          'div',
          { class: 'dialog__actions' },
          tag
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn--danger tag-dialog__delete',
                  'data-key': 'tag-delete',
                  onclick: async (e) => {
                    const ok = await confirmDialog({ title: 'Delete this tag?', text: `“${tag.name}” is deleted. Threads and files are not touched.`, confirm: 'Delete', opener: e.currentTarget });
                    if (ok) finish({ deleted: true });
                  },
                },
                icon('trash'),
                'Delete',
              )
            : null,
          h('button', { type: 'button', class: 'btn', 'data-key': 'tag-cancel', onclick: () => finish(null), text: 'Cancel' }),
          h('button', { type: 'submit', class: 'btn btn--primary', 'data-key': 'tag-save', text: 'Save' }),
        ),
      ),
    );
    d.addEventListener('close', () => finish(null));
    paintMode();
    document.body.append(d);
    d.showModal();
    name.focus();
  });
}

/**
 * A tag's page: the threads it finds on its boards, newest catalogs first,
 * and its library files when it looks there.
 * @param {object} o
 * @param {object} o.tag
 * @param {string[]} o.boards
 * @param {(board: string) => object|undefined} o.catalog   st.cats entry
 * @param {object} o.bridge
 * @param {Array} [o.files]   library entries it matches
 * @param {(e: object) => string} [o.fileUrl]
 */
export function tagPage({ tag, boards, catalog, bridge, files = null, fileUrl = null, onOpen, onOpenFile, onEdit, onRefresh, keyPrefix: k = '' }) {
  const loaded = boards.filter((b) => catalog(b)?.threads);
  const waiting = boards.filter((b) => catalog(b)?.status === 'loading' || !catalog(b));
  const failed = boards.filter((b) => catalog(b)?.status === 'error' && !catalog(b)?.threads);
  const finds = T.findAcross(tag, loaded.map((b) => [b, catalog(b).threads]), commentText);
  const names = (list) => list.map((b) => `/${b}/`).join(' ');
  const where = [boards.length ? `Looking in ${names(boards)}` : 'No active boards: add favourites, or open a board.'];
  if (waiting.length) where.push(`Still loading: ${waiting.length}`);
  if (failed.length) where.push(`Couldn’t load ${names(failed)}`);
  return h(
    'div',
    { class: 'browse tag-page' },
    h(
      'div',
      { class: 'browse__tools browse__tools--sticky' },
      h('span', { class: 'tag-page__terms', translate: 'no', title: 'Words to find', text: [...tag.terms, ...(tag.flags || [])].join(', ') }),
      h('button', { type: 'button', class: 'btn', 'data-key': `${k}tagpage-refresh`, onclick: onRefresh }, icon('refresh'), 'Refresh'),
      h('button', { type: 'button', class: 'btn', 'data-key': `${k}tagpage-edit`, onclick: (e) => onEdit(e.currentTarget) }, icon('settings'), 'Edit tag'),
    ),
    h(
      'p',
      { class: 'state-line', role: 'status' },
      where.join(' · '),
    ),
    files
      ? h(
          'section',
          { class: 'tag-page__section' },
          h('h3', { class: 'library__h', text: files.length === 1 ? 'In your library: 1 file' : `In your library: ${files.length} files` }),
          files.length
            ? h(
                'ul',
                { class: 'library__grid' },
                files.slice(0, 60).map((e) =>
                  h(
                    'li',
                    { class: 'library__tile' },
                    h(
                      'button',
                      { type: 'button', class: 'library__thumb', title: e.name, 'aria-label': e.name, 'data-key': `${k}tagpage-file-${e.id}`, onclick: () => onOpenFile(e) },
                      e.kind === 'video' ? h('video', { src: fileUrl(e), muted: true, preload: 'metadata', 'aria-hidden': 'true' }) : h('img', { src: fileUrl(e), alt: '', loading: 'lazy' }),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'field__hint', text: 'Nothing in the library matches yet.' }),
        )
      : null,
    h('h3', { class: 'library__h', text: finds.length === 1 ? '1 thread' : `Threads: ${finds.length}` }),
    finds.length
      ? h(
          'ul',
          { class: 'catalog' },
          finds.map(({ board, thread: t }) => {
            const thumb = t.tim ? bridge.thumbUrl(board, t) : null;
            return h(
              'li',
              { class: 'catalog__item' },
              h(
                'button',
                { type: 'button', class: 'catalog-card', 'data-key': `${k}tagpage-thread-${board}-${t.no}`, onclick: () => onOpen(board, t.no) },
                h('span', { class: 'catalog-card__thumb' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', width: t.tn_w || 150, height: t.tn_h || 150 }) : h('span', { class: 'catalog-card__nofile', text: 'No file' })),
                h('span', { class: 'catalog-card__title', translate: 'no' }, runsEl(B.titleRuns(t))),
                t.sub ? h('span', { class: 'catalog-card__text', translate: 'no' }, runsEl(B.excerptRuns(t))) : null,
              ),
              h('div', { class: 'catalog-card__foot' }, h('span', { class: 'catalog-card__counts' }, h('span', { class: 'tag', translate: 'no', text: `/${board}/` }), h('span', { text: `R ${t.replies ?? 0}` }), h('span', { text: `I ${t.images ?? 0}` }))),
            );
          }),
        )
      : h('p', { class: 'rail__empty', text: waiting.length ? 'Still looking…' : 'No thread matches this tag right now.' }),
  );
}
