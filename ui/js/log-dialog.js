// The diagnostics report in a window of its own, to read in place: the
// same text Save diagnostics file writes (src-tauri/src/diag.rs), newest
// lines at the bottom. Refresh, Copy, Save, Close.

import { h, icon, toast, copyText } from './dom.js';
import { t } from './i18n.js';

let open = null;

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
  const view = h('pre', { class: 'log-view', tabindex: '0', translate: 'no', 'aria-label': 'Diagnostics report', 'data-key': 'log-view' });
  const status = h('p', { class: 'field__hint log-dialog__status', 'aria-live': 'polite', 'data-key': 'log-status' });
  const close = () => {
    if (d.open) d.close();
    d.remove();
    open = null;
    if (opener?.isConnected) opener.focus();
  };
  async function refresh() {
    status.textContent = t('Loading…');
    try {
      view.textContent = await load();
      status.textContent = '';
      view.scrollTop = view.scrollHeight; // the newest lines
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
      view,
      status,
    ),
    h(
      'div',
      { class: 'dialog__actions log-dialog__actions' },
      h('button', { type: 'button', class: 'btn', 'data-key': 'log-refresh', onclick: refresh }, icon('refresh'), 'Refresh'),
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
  d.addEventListener('close', close);
  document.body.append(d);
  d.showModal();
  open = d;
  refresh();
  return d;
}
