// Saved threads: the list (a pane), a confirm before deleting one, and the
// save controls a thread's toolbar shows. The shell owns the state; these
// only draw it. Text only through textContent.

import { h, icon } from './dom.js';
import { formatBytes } from './render.js';
import { progressText } from './offline-model.js';

const tagOf = (board, hue) => h('span', { class: 'board-tag', style: { '--hue': hue(board) }, text: `/${board}/` });

/** "11 Nov 2026, 14:03" in the UI's language (the page's lang, as post
 *  times use; the system's when it has none). */
export function savedDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/**
 * A modal "are you sure" (uses the page's <dialog> styles). Resolves true
 * when confirmed; Esc, Cancel or the backdrop's close resolve false.
 */
export function confirmDialog({ title, text, confirm, opener = null }) {
  return new Promise((resolve) => {
    // The buttons answer directly; the close event (Esc) is only a fallback,
    // since it is queued and never fires in a page that is not shown.
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      if (d.open) d.close();
      d.remove();
      if (opener?.isConnected) opener.focus();
      resolve(answer);
    };
    const d = h(
      'dialog',
      { class: 'confirm-dialog', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text' },
      h('div', { class: 'dialog__body' }, h('h2', { class: 'dialog__title', id: 'confirm-title', text: title }), h('p', { class: 'dialog__text', id: 'confirm-text', text })),
      h(
        'div',
        { class: 'dialog__actions' },
        h('button', { type: 'button', class: 'btn', 'data-key': 'confirm-cancel', autofocus: true, onclick: () => finish(false), text: 'Cancel' }),
        h('button', { type: 'button', class: 'btn btn--danger', 'data-key': 'confirm-ok', onclick: () => finish(true) }, confirm),
      ),
    );
    d.addEventListener('close', () => finish(false));
    document.body.append(d);
    d.showModal();
    d.querySelector('[autofocus]')?.focus();
  });
}

/**
 * The thread toolbar's save controls: Save offline (Update saved copy once
 * saved) and Download all files; while one runs, its progress and Cancel.
 * @param {object} o
 * @param {object|null} o.job       { kind: 'offline'|'all', done, total, cancelled }
 * @param {boolean} o.saved         this thread is in the saved list
 * @param {string} o.keyPrefix
 * @param {string} o.progressKey    data-save-progress value, for updates in place
 */
export function saveControls({ job, saved, keyPrefix = '', progressKey, onSave, onDownloadAll, onCancel }) {
  if (job) {
    return h(
      'span',
      { class: 'save-job', role: 'status' },
      h('span', { class: 'save-job__text', 'data-save-progress': progressKey, text: job.cancelled ? 'Stopping…' : progressText(job) }),
      h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `${keyPrefix}save-cancel`, disabled: job.cancelled, onclick: onCancel }, icon('x'), 'Cancel'),
    );
  }
  return [
    h(
      'button',
      {
        type: 'button',
        class: `btn${saved ? ' btn--on' : ''}`,
        'data-key': `${keyPrefix}thread-save-offline`,
        title: saved ? 'Save the new posts and files to the saved copy' : 'Save this thread and its files to read offline',
        onclick: onSave,
      },
      icon('folder'),
      saved ? 'Update saved copy' : 'Save offline',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        'data-key': `${keyPrefix}thread-download-all`,
        title: 'Download every file of this thread to the download folder, one a second',
        onclick: onDownloadAll,
      },
      icon('download'),
      'Download all',
    ),
  ];
}

/**
 * The list of saved threads: title, board, date, size; open or delete each.
 * @param {object} o
 * @param {{status: string, list: object[], error?: string, hidden?: number}} o.saved
 *   `hidden`: how many were left out (NSFW boards while those are off)
 * @param {(board: string) => number} o.hue     a board's tag colour
 * @param {string} [o.keyPrefix]
 */
export function savedListView({ saved, hue, keyPrefix = '', onOpen, onDelete, onRefresh }) {
  const out = h('div', { class: 'browse saved' });
  out.append(
    h(
      'div',
      { class: 'browse__tools' },
      h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}saved-refresh`, onclick: onRefresh, disabled: saved.status === 'loading' }, icon('refresh'), 'Refresh'),
      h('span', { class: 'field__hint', text: 'Saved threads open from disk, with no request to the site.' }),
    ),
  );
  if (saved.status === 'error') {
    out.append(h('div', { class: 'callout callout--danger', role: 'alert' }, icon('wifiOff'), h('div', {}, h('strong', { text: 'Couldn’t read the saved threads. ' }), saved.error || '')));
    return out;
  }
  if (saved.status !== 'ok' && !saved.list.length) {
    out.append(h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Loading the saved threads…'));
    return out;
  }
  const hiddenNote = saved.hidden > 0 ? h('p', { class: 'field__hint', text: 'Saved threads on NSFW boards are hidden while NSFW boards are off.' }) : null;
  if (!saved.list.length) {
    out.append(saved.hidden > 0 ? hiddenNote : h('p', { class: 'rail__empty', text: 'No saved threads yet. Save offline in a thread keeps it here.' }));
    return out;
  }
  out.append(
    h(
      'ul',
      { class: 'saved__list', 'aria-label': 'Saved threads' },
      saved.list.map((e) => {
        const name = e.title || `No. ${e.no}`;
        return h(
          'li',
          { class: 'saved__row' },
          h(
            'button',
            { type: 'button', class: 'saved__open', 'data-key': `${keyPrefix}saved-${e.board}-${e.no}`, onclick: () => onOpen(e) },
            tagOf(e.board, hue),
            h('span', { class: 'saved__title', translate: e.title ? 'no' : null, text: name }),
            h(
              'span',
              { class: 'saved__meta' },
              h('span', { text: savedDate(e.savedAt) }),
              h('span', { text: e.files === 1 ? '1 file' : `${e.files} files` }),
              h('span', { text: formatBytes(e.bytes) }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn icon-btn--sm saved__delete',
              title: 'Delete the saved copy',
              'aria-label': `Delete the saved copy of ${name}`,
              'data-key': `${keyPrefix}saved-delete-${e.board}-${e.no}`,
              onclick: (ev) => onDelete(e, ev.currentTarget),
            },
            icon('trash'),
          ),
        );
      }),
    ),
  );
  if (hiddenNote) out.append(hiddenNote);
  return out;
}
