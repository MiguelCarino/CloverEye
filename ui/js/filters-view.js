// Settings → Filters: the list of filters (switch on or off, edit, remove),
// the form to add or change one (patterns are checked as they are typed and
// never throw), export as JSON to copy, import by pasting JSON, and the posts
// hidden by hand. The rules live in filter-model.js.

import * as F from './filter-model.js';
import { h, icon, toast, copyText } from './dom.js';

// What is being edited survives the redraws Settings goes through (a
// thread in another pane updating redraws the whole window).
const ui = {
  editing: null, // null | 'new' | a filter id
  draft: null, // { field, pattern, regex, matchCase, boardsText, action }
  panel: null, // null | 'export' | 'import'
  importText: '',
  importMsg: '',
  importError: false,
};

const blankDraft = () => ({ field: 'com', pattern: '', regex: false, matchCase: false, boardsText: '', action: 'hide' });
const draftOf = (f) => ({ field: f.field, pattern: f.pattern, regex: f.regex, matchCase: f.matchCase, boardsText: f.boards.join(' '), action: f.action });

/** What is wrong with the draft, or ''. */
function draftProblem(d) {
  const p = F.filterProblem(d);
  if (p) return p;
  const { bad } = F.parseBoards(d.boardsText);
  return bad.length ? `Not a board code: ${bad.join(' ')}` : '';
}

function boardsLabel(f) {
  return f.boards.length ? f.boards.map((b) => `/${b}/`).join(' ') : 'Every board';
}

/**
 * @param {object} o
 * @param {object} o.settings
 * @param {(next: object, how?: {redraw?: boolean, focus?: string}) => void} o.onChange
 */
export function filtersSection({ settings, onChange }) {
  const filters = settings.filters || [];
  const hiddenCount = (settings.hiddenPosts || []).length;
  const redraw = (focus) => onChange(settings, { focus });

  const form = () => {
    const d = ui.draft;
    const isNew = ui.editing === 'new';
    const err = h('p', { class: 'field__error', id: 'filter-error', role: 'status', 'aria-live': 'polite', text: d.pattern ? draftProblem(d) : '' });
    const pattern = h('input', {
      id: 'filter-pattern',
      class: 'input filter-form__pattern',
      value: d.pattern,
      maxlength: String(F.MAX_PATTERN),
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': 'filter-error filter-pattern-hint',
      'aria-invalid': d.pattern && draftProblem(d) ? 'true' : null,
      'data-key': 'filter-pattern',
      oninput: (e) => {
        d.pattern = e.target.value;
        check();
      },
    });
    const boards = h('input', {
      id: 'filter-boards',
      class: 'input',
      value: d.boardsText,
      placeholder: 'g v diy',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': 'filter-boards-hint',
      'data-key': 'filter-boards',
      oninput: (e) => {
        d.boardsText = e.target.value;
        check();
      },
    });
    function check() {
      const p = draftProblem(d);
      err.textContent = d.pattern || d.boardsText ? p : '';
      if (d.pattern && p) pattern.setAttribute('aria-invalid', 'true');
      else pattern.removeAttribute('aria-invalid');
    }
    const save = () => {
      const p = draftProblem(d);
      if (p) {
        err.textContent = p;
        pattern.focus();
        return;
      }
      const raw = { field: d.field, pattern: d.pattern, regex: d.regex, matchCase: d.matchCase, boards: F.parseBoards(d.boardsText).boards, action: d.action, enabled: true };
      let next;
      if (isNew) {
        next = F.addFilter(settings, raw);
        if (next === settings) {
          err.textContent = F.addProblemText(F.addProblem(settings, raw)) || 'That filter is already there.';
          return;
        }
      } else {
        const old = filters.find((f) => f.id === ui.editing);
        next = F.updateFilter(settings, ui.editing, { ...raw, enabled: old ? old.enabled : true });
        // Checked above, so a refusal here means the edit did not fit.
        if (next === settings) {
          err.textContent = F.addProblemText('size');
          return;
        }
      }
      const focus = isNew ? 'filter-add' : `filter-edit-${ui.editing}`;
      ui.editing = null;
      ui.draft = null;
      onChange(next, { focus });
      toast(isNew ? 'Filter added' : 'Filter saved');
    };
    const cancel = () => {
      const focus = isNew ? 'filter-add' : `filter-edit-${ui.editing}`;
      ui.editing = null;
      ui.draft = null;
      redraw(focus);
    };
    return h(
      'div',
      {
        class: 'filter-form',
        role: 'group',
        'aria-label': isNew ? 'New filter' : 'Change filter',
        onkeydown: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') {
            e.preventDefault();
            save();
          }
        },
      },
      h(
        'div',
        { class: 'filter-form__row' },
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'filter-field', text: 'Match on' }),
          h(
            'select',
            { id: 'filter-field', class: 'input', 'data-key': 'filter-field', onchange: (e) => ((d.field = e.target.value), check()) },
            F.FILTER_FIELDS.map((f) => h('option', { value: f.value, selected: f.value === d.field, text: f.label })),
          ),
        ),
        h(
          'div',
          { class: 'field filter-form__grow' },
          h('label', { class: 'field__label', for: 'filter-pattern', text: 'Text or pattern' }),
          pattern,
        ),
      ),
      h(
        'p',
        { class: 'field__hint', id: 'filter-pattern-hint' },
        'Plain text matches anywhere in comments, subjects and file names, and the whole value of names, tripcodes, IDs and MD5s. Case is ignored unless Match case is on.',
      ),
      h(
        'div',
        { class: 'filter-form__checks' },
        h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: d.regex, 'data-key': 'filter-regex', onchange: (e) => ((d.regex = e.target.checked), check()) }), h('span', { text: 'Regular expression' })),
        h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: d.matchCase, 'data-key': 'filter-case', onchange: (e) => ((d.matchCase = e.target.checked), check()) }), h('span', { text: 'Match case' })),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'filter-boards', text: 'Boards' }),
        boards,
        h('p', { class: 'field__hint', id: 'filter-boards-hint', text: 'Board codes separated by spaces. Empty means every board.' }),
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field__label', id: 'filter-action-l', text: 'Then' }),
        h(
          'div',
          { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'filter-action-l' },
          F.FILTER_ACTIONS.map((a) =>
            h(
              'label',
              {},
              h('input', { type: 'radio', name: 'filter-action', value: a.value, checked: a.value === d.action, 'data-key': `filter-action-${a.value}`, onchange: () => (d.action = a.value) }),
              h('span', { text: a.label }),
            ),
          ),
        ),
      ),
      err,
      h(
        'div',
        { class: 'inline' },
        h('button', { type: 'button', class: 'btn btn--primary', 'data-key': 'filter-save', onclick: save }, icon('check'), isNew ? 'Add filter' : 'Save filter'),
        h('button', { type: 'button', class: 'btn btn--ghost', 'data-key': 'filter-cancel', onclick: cancel, text: 'Cancel' }),
      ),
    );
  };

  const row = (f) => {
    if (ui.editing === f.id && ui.draft) return h('li', { class: 'filter-list__item filter-list__item--editing' }, form());
    const problem = F.filterProblem(f);
    const sumId = `filter-sum-${f.id}`;
    return h(
      'li',
      { class: `filter-list__item${f.enabled ? '' : ' filter-list__item--off'}` },
      h('button', {
        type: 'button',
        class: 'switch switch--sm',
        role: 'switch',
        'aria-checked': String(f.enabled),
        'aria-labelledby': sumId,
        title: f.enabled ? 'On: click to turn this filter off' : 'Off: click to turn this filter on',
        'data-key': `filter-on-${f.id}`,
        onclick: () => onChange(F.updateFilter(settings, f.id, { enabled: !f.enabled }), { focus: `filter-on-${f.id}` }),
      }),
      h(
        'div',
        { class: 'filter-list__text', id: sumId },
        h(
          'div',
          { class: 'filter-list__head' },
          h('span', { class: `pill${f.action === 'highlight' ? ' pill--hl' : ''}`, text: f.action === 'highlight' ? 'Highlight' : 'Hide' }),
          h('span', { class: 'filter-list__field', text: F.fieldLabel(f.field) }),
          h('code', { class: 'filter-list__pattern', translate: 'no', text: f.regex ? `/${f.pattern}/${f.matchCase ? '' : 'i'}` : f.pattern }),
        ),
        h('div', { class: 'field__hint', text: boardsLabel(f) }),
        problem ? h('div', { class: 'field__error', text: problem }) : null,
      ),
      h(
        'div',
        { class: 'filter-list__actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn--sm btn--ghost',
            'data-key': `filter-edit-${f.id}`,
            disabled: ui.editing !== null,
            onclick: () => {
              ui.editing = f.id;
              ui.draft = draftOf(f);
              redraw('filter-pattern');
            },
          },
          'Edit',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn icon-btn--sm',
            'aria-label': 'Remove this filter',
            title: 'Remove this filter',
            'data-key': `filter-remove-${f.id}`,
            onclick: () => {
              onChange(F.removeFilter(settings, f.id), { focus: 'filter-add' });
              toast('Filter removed');
            },
          },
          icon('x'),
        ),
      ),
    );
  };

  const panel = () => {
    if (ui.panel === 'export') {
      const text = F.exportFilters(filters);
      return h(
        'div',
        { class: 'filter-panel' },
        h('label', { class: 'field__label', for: 'filter-export', text: 'Your filters as JSON' }),
        h('textarea', { id: 'filter-export', class: 'input filter-panel__text', rows: '8', readonly: true, spellcheck: 'false', 'data-key': 'filter-export-text', translate: 'no' }, text),
        h(
          'div',
          { class: 'inline' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              'data-key': 'filter-copy',
              onclick: async () => toast((await copyText(text)) ? 'Filters copied' : 'Couldn’t copy. Select the text and copy it yourself.'),
            },
            icon('copy'),
            'Copy',
          ),
          h('button', { type: 'button', class: 'btn btn--ghost', 'data-key': 'filter-panel-close', onclick: () => ((ui.panel = null), redraw('filter-export')), text: 'Close' }),
        ),
      );
    }
    if (ui.panel === 'import') {
      const doImport = () => {
        const res = F.parseFilterImport(ui.importText);
        if (res.error) {
          ui.importMsg = res.error;
          ui.importError = true;
          redraw('filter-import-text');
          return;
        }
        const { settings: next, added } = F.mergeFilters(settings, res.filters);
        const already = res.filters.length - added;
        const parts = [added === 1 ? '1 filter added.' : `${added} filters added.`];
        if (already) parts.push(already === 1 ? '1 was already there or did not fit.' : `${already} were already there or did not fit.`);
        if (res.skipped) parts.push(res.skipped === 1 ? '1 entry was not a filter.' : `${res.skipped} entries were not filters.`);
        ui.importMsg = parts.join(' ');
        ui.importError = false;
        if (added) ui.importText = '';
        onChange(next, { focus: 'filter-import-text' });
      };
      return h(
        'div',
        { class: 'filter-panel' },
        h('label', { class: 'field__label', for: 'filter-import', text: 'Paste filters as JSON' }),
        h('textarea', {
          id: 'filter-import',
          class: 'input filter-panel__text',
          rows: '8',
          spellcheck: 'false',
          'aria-describedby': 'filter-import-msg',
          'data-key': 'filter-import-text',
          oninput: (e) => (ui.importText = e.target.value),
        }, ui.importText),
        h('p', { class: ui.importError ? 'field__error' : 'field__hint', id: 'filter-import-msg', role: 'status', 'aria-live': 'polite', text: ui.importMsg }),
        h(
          'div',
          { class: 'inline' },
          h('button', { type: 'button', class: 'btn', 'data-key': 'filter-import-go', onclick: doImport }, icon('download'), 'Import'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              'data-key': 'filter-panel-close',
              onclick: () => {
                ui.panel = null;
                ui.importMsg = '';
                redraw('filter-import');
              },
              text: 'Close',
            },
          ),
        ),
      );
    }
    return null;
  };

  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'set-filters' },
    h('h2', { class: 'settings__heading', id: 'set-filters', text: 'Filters' }),
    h(
      'p',
      { class: 'field__hint', text: 'Hide or highlight threads and posts by their comment, subject, name, tripcode, poster ID, file name or file MD5. A post’s … menu adds one too.' },
    ),
    filters.length
      ? h('ul', { class: 'filter-list', 'aria-label': 'Filters' }, filters.map(row))
      : h('p', { class: 'rail__empty', text: 'No filters yet.' }),
    ui.editing === 'new' && ui.draft ? form() : null,
    h(
      'div',
      { class: 'inline' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-key': 'filter-add',
          disabled: ui.editing !== null || filters.length >= F.MAX_FILTERS,
          onclick: () => {
            ui.editing = 'new';
            ui.draft = blankDraft();
            redraw('filter-pattern');
          },
        },
        icon('plus'),
        'Add a filter',
      ),
      h(
        'button',
        {
          type: 'button',
          class: `btn btn--ghost${ui.panel === 'export' ? ' btn--on' : ''}`,
          'aria-pressed': String(ui.panel === 'export'),
          'data-key': 'filter-export',
          disabled: !filters.length,
          onclick: () => ((ui.panel = ui.panel === 'export' ? null : 'export'), redraw('filter-export')),
        },
        icon('copy'),
        'Export',
      ),
      h(
        'button',
        {
          type: 'button',
          class: `btn btn--ghost${ui.panel === 'import' ? ' btn--on' : ''}`,
          'aria-pressed': String(ui.panel === 'import'),
          'data-key': 'filter-import',
          onclick: () => {
            ui.panel = ui.panel === 'import' ? null : 'import';
            ui.importMsg = '';
            redraw(ui.panel ? 'filter-import-text' : 'filter-import');
          },
        },
        icon('download'),
        'Import',
      ),
    ),
    panel(),
    h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row__text' },
        h('div', { class: 'switch-row__title', id: 'sw-hide-replies-t', text: 'Also hide replies to hidden posts' }),
        h('div', {
          class: 'switch-row__desc',
          id: 'sw-hide-replies-d',
          text: 'A reply whose quotes are all hidden posts is hidden too, and so on down the chain. Your own posts always stay, and quotes of the opening post do not count.',
        }),
      ),
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(settings.hide?.replies !== false),
        'aria-labelledby': 'sw-hide-replies-t',
        'aria-describedby': 'sw-hide-replies-d',
        'data-key': 'switch-hide-replies',
        onclick: () => onChange({ ...settings, hide: { ...settings.hide, replies: settings.hide?.replies === false } }, { focus: 'switch-hide-replies' }),
      }),
    ),
    h(
      'div',
      { class: 'state-line' },
      h('span', { text: hiddenCount === 1 ? '1 post or thread hidden by hand.' : `${hiddenCount} posts and threads hidden by hand.` }),
      hiddenCount
        ? h('button', {
            type: 'button',
            class: 'link-btn',
            'data-key': 'filter-unhide-all',
            onclick: () => {
              onChange({ ...settings, hiddenPosts: [] }, { focus: 'filter-add' });
              toast('Everything hidden by hand is shown again');
            },
            text: 'Unhide all',
          })
        : null,
    ),
  );
}
