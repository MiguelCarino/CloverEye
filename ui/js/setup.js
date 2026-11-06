// First-time setup wizard (SCOPE §3.1b). State and rules live in
// setup-model.js; this file only draws them and handles input.

import * as M from './setup-model.js';
import { h, clear, icon, toast, copyText } from './dom.js';
import { applyLook } from './look.js';
import { parseComment, formatBytes, backlinks, decodeEntities } from './render.js';
import { themePicker } from './theme-picker.js';

export const RULES_URL = 'https://www.4chan.org/rules';

let sample = null;
async function loadSample() {
  if (!sample) {
    const res = await fetch('data/sample-thread.json');
    if (!res.ok) throw new Error(`sample thread: HTTP ${res.status}`);
    sample = await res.json();
  }
  return sample;
}

/** What kind of element has focus, for M.keyAction. */
export function targetKind(el) {
  if (!el || el === document.body || el === document.documentElement) return 'other';
  if (el.closest?.('[data-grid]')) return 'grid';
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'SELECT') return 'select';
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'radio') return 'radio';
    if (t === 'range') return 'range';
    if (t === 'checkbox') return 'toggle';
    return 'text';
  }
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON' || el.getAttribute?.('role') === 'button') return 'button';
  return 'other';
}

// ------------------------------------------------------------- post render

/** Volume and mute carry over from one video to the next this session. */
const videoPrefs = { volume: 0.6, muted: false };

/** One post card from API-shaped data. Text only through textContent.
 *  `thumb`/`full` are the file's URLs (the bridge decides: the image host in
 *  the app, local pictures in the browser mock); without them the local
 *  `_thumb` field of the setup sample is used. Clicking the file expands it
 *  in place: the full image, or a player for WebM/MP4. */
/** The little flag before a poster's name (its name on hover). */
function postFlagNode(flag) {
  const title = decodeEntities(flag.title);
  if (flag.src) {
    return h('img', { class: 'post__flag', src: flag.src, alt: title, title, width: '16', height: '11', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  }
  return h('span', { class: 'post__flag post__flag--code', title, 'aria-label': title, text: flag.code });
}

export function renderPost(post, { backrefs = [], onQuote = null, onReply = null, isYou = () => false, thumb = null, full = null, flag = null, idPrefix = 'sample-p' } = {}) {
  const lines = parseComment(post.com || '');
  const com = h('div', { class: 'post__com', translate: 'no' });
  for (const line of lines) {
    const row = h('div', { class: 'post__line' });
    for (const seg of line) {
      if (seg.type === 'quotelink') {
        row.append(
          h('button', {
            type: 'button',
            class: `seg-quotelink${seg.target && isYou(seg.target) ? ' seg-quotelink--you' : ''}`,
            'data-target': seg.target ?? '',
            onclick: () => onQuote?.(seg.target),
            text: seg.target && isYou(seg.target) ? `${seg.text} (You)` : seg.text,
          }),
        );
      } else if (seg.type === 'code') {
        row.append(h('code', { class: 'seg-code', text: seg.text }));
      } else {
        row.append(h('span', { class: `seg-${seg.type}`, text: seg.text }));
      }
    }
    com.append(row);
  }
  // <pre> lines come out as separate lines; join consecutive code lines.
  const codeRows = [...com.querySelectorAll('.post__line')];
  for (let i = codeRows.length - 1; i > 0; i--) {
    const cur = codeRows[i];
    const prev = codeRows[i - 1];
    const a = prev.lastElementChild;
    const b = cur.firstElementChild;
    if (a?.classList.contains('seg-code') && b?.classList.contains('seg-code') && cur.childElementCount === 1) {
      a.textContent += `\n${b.textContent}`;
      cur.remove();
    }
  }

  const meta = h(
    'div',
    { class: 'post__meta' },
    flag ? postFlagNode(flag) : null,
    h('span', { class: 'post__name', translate: 'no', text: decodeEntities(post.name || 'Anonymous') }),
    post.trip ? h('span', { translate: 'no', text: post.trip }) : null,
    isYou(post.no) ? h('span', { class: 'pill pill--you', text: 'You' }) : null,
    post.capcode ? h('span', { class: 'pill', text: post.capcode }) : null,
    h('span', { translate: 'no', text: post.now || '' }),
    onReply
      ? h('button', { type: 'button', class: 'post__no post__no--reply', title: 'Reply quoting this post', 'aria-label': `Reply quoting No. ${post.no}`, onclick: onReply, text: `No. ${post.no}` })
      : h('span', { class: 'post__no', text: `No. ${post.no}` }),
  );
  const thumbSrc = thumb || post._thumb || null;
  const fileName = `${decodeEntities(post.filename || 'file')}${post.ext || ''}`;
  let file = null;
  if (post.filedeleted) {
    file = h('div', { class: 'post__file post__file--gone', text: 'File deleted' });
  } else if (thumbSrc) {
    const img = h('img', {
      src: thumbSrc,
      alt: fileName,
      width: post.tn_w || 125,
      height: post.tn_h || 125,
      loading: 'lazy',
      decoding: 'async',
    });
    const isVideo = /^\.(webm|mp4)$/i.test(post.ext || '');
    const open = h(
      'button',
      {
        type: 'button',
        class: 'post__thumb',
        'aria-expanded': 'false',
        'data-preview': full || null,
        'data-preview-w': post.w || null,
        'data-preview-h': post.h || null,
        'data-preview-video': isVideo ? 'true' : null,
        'aria-label': `${isVideo ? 'Play' : 'Expand'} ${fileName}`,
        onclick: (e) => {
          const btn = e.currentTarget;
          const fig = btn.closest('.post__file');
          const expanded = btn.getAttribute('aria-expanded') === 'true';
          fig.querySelectorAll('.post__media, .post__close').forEach((el) => el.remove());
          btn.setAttribute('aria-expanded', String(!expanded));
          fig.classList.toggle('post__file--open', !expanded);
          if (expanded || !full) return;
          const media = isVideo
            ? h('video', { class: 'post__media', src: full, controls: true, autoplay: true, loop: true, preload: 'metadata' })
            : h('img', { class: 'post__media', src: full, alt: fileName, decoding: 'async' });
          if (isVideo) {
            // One video at a time, at the volume the person last chose.
            media.volume = videoPrefs.volume;
            media.muted = videoPrefs.muted;
            media.addEventListener('volumechange', () => {
              videoPrefs.volume = media.volume;
              videoPrefs.muted = media.muted;
            });
            media.addEventListener('play', () => {
              for (const v of document.querySelectorAll('video.post__media')) if (v !== media && !v.paused) v.pause();
            });
          }
          media.addEventListener('click', (ev) => {
            if (!isVideo) {
              ev.preventDefault();
              btn.click();
            }
          });
          btn.after(media);
          if (isVideo) {
            media.after(
              h('button', {
                type: 'button',
                class: 'btn btn--sm post__close',
                onclick: () => {
                  btn.click();
                  btn.focus();
                },
                text: 'Close video',
              }),
            );
          }
        },
      },
      img,
      isVideo ? h('span', { class: 'post__play', 'aria-hidden': 'true', text: '▶' }) : null,
    );
    file = h(
      'figure',
      { class: 'post__file', style: { margin: 0 } },
      open,
      h('span', { translate: 'no', text: `${fileName} · ${post.w && post.h ? `${post.w}×${post.h} · ` : ''}${formatBytes(post.fsize)}` }),
    );
  }
  const back = backrefs.length
    ? h(
        'div',
        { class: 'post__backlinks' },
        h('span', { text: 'Replies' }),
        backrefs.map((n) =>
          h('button', { type: 'button', class: 'seg-quotelink', onclick: () => onQuote?.(n), text: `>>${n}` }),
        ),
      )
    : null;
  return h(
    'article',
    { class: `post${post.resto === 0 ? ' post--op' : ''}${isYou(post.no) ? ' post--you' : ''}`, id: `${idPrefix}${post.no}`, 'data-no': post.no },
    meta,
    post.sub ? h('div', { class: 'post__sub', translate: 'no', text: decodeEntities(post.sub) }) : null,
    h('div', { class: 'post__main' }, file, com),
    back,
  );
}

// ------------------------------------------------------------------ wizard

let active = null; // the running wizard, for the shared dialogs
let dialogsWired = false;
let onAdult = null; // what the 18+ dialog's "Turn on" does this time

/** Asks for the 18+ confirmation (Settings → Content). `onConfirm` runs only
 *  after the box is ticked and "Turn on" pressed; Cancel and Esc do nothing. */
export function askAdult(opener, onConfirm) {
  wireDialogs();
  onAdult = onConfirm;
  openDialog('adultDialog', opener);
}

function wireDialogs() {
  if (dialogsWired) return;
  dialogsWired = true;
  const skip = document.getElementById('skipDialog');
  skip.querySelector('[data-act="cancel"]').addEventListener('click', () => skip.close());
  skip.querySelector('[data-act="confirm"]').addEventListener('click', () => {
    skip.close();
    active?.finish(true);
  });
  const adult = document.getElementById('adultDialog');
  const box = adult.querySelector('#adultConfirm');
  const ok = adult.querySelector('[data-act="confirm"]');
  box.addEventListener('change', () => {
    ok.disabled = !box.checked;
  });
  adult.querySelector('[data-act="cancel"]').addEventListener('click', () => adult.close());
  ok.addEventListener('click', () => {
    if (!box.checked) return;
    const done = onAdult;
    onAdult = null;
    adult.close();
    done?.();
  });
  adult.addEventListener('close', () => {
    onAdult = null;
  });
  for (const d of [skip, adult]) {
    d.addEventListener('close', () => {
      const back = d._returnFocus;
      d._returnFocus = null;
      if (back?.isConnected) back.focus();
    });
  }
}

function openDialog(id, opener) {
  const d = document.getElementById(id);
  d._returnFocus = opener || document.activeElement;
  if (id === 'adultDialog') {
    d.querySelector('#adultConfirm').checked = false;
    d.querySelector('[data-act="confirm"]').disabled = true;
  }
  d.showModal();
  d.querySelector('[autofocus]')?.focus();
}

/**
 * Opens the wizard.
 * @param {object} o
 * @param {object} o.bridge
 * @param {object} o.settings  current (normalised) settings
 * @param {boolean} [o.rerun]  Settings → Run setup again
 * @param {Array} [o.boards]   board list already loaded this session
 * @param {(settings, extra) => void} o.onFinish
 * @param {(title: string) => void} [o.setTitle]
 */
export function startSetup({ bridge, settings, rerun = false, boards = null, onFinish, onBoards = () => {}, setTitle = () => {} }) {
  wireDialogs();
  const steps = M.stepsToShow(settings, { rerun });
  if (steps.length === 0) {
    onFinish(settings, { boards });
    return null;
  }
  const st = {
    steps,
    index: 0,
    maxVisited: 0,
    dir: 'forward',
    draft: M.pruneFavourites(structuredClone(settings), boards),
    errors: {},
    boards: boards ? { status: 'ok', list: boards, error: '' } : { status: 'idle', list: null, error: '' },
    query: '',
    gridFocus: null, // board code holding the grid's single Tab stop
    ffmpeg: { status: 'idle', check: null },
    notifyPermission: null,
  };

  const root = document.getElementById('setup');
  const progressList = document.getElementById('progress');
  const progressCount = document.getElementById('progressCount');
  const host = document.getElementById('stepHost');
  const skipBtn = document.getElementById('skipBtn');
  const backBtn = document.getElementById('backBtn');
  const nextBtn = document.getElementById('nextBtn');
  const escHint = document.getElementById('escHint');
  const ac = new AbortController();
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });

  const step = () => st.steps[st.index];
  const indexOf = (id) => st.steps.findIndex((s) => s.id === id);

  // ---------------------------------------------------------------- frame

  function renderProgress() {
    clear(progressList);
    progressList.style.setProperty('--steps', String(st.steps.length));
    st.steps.forEach((s, i) => {
      const state = i < st.index ? 'done' : i === st.index ? 'current' : 'todo';
      progressList.append(
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'progress__step',
              'data-state': state,
              'aria-current': i === st.index ? 'step' : null,
              'aria-label': `Step ${i + 1} of ${st.steps.length}: ${s.label}${i < st.index ? ' (done)' : ''}`,
              disabled: i > st.maxVisited || i === st.index,
              onclick: () => go(i),
            },
            h('span', { class: 'progress__bar' }),
            h('span', { class: 'progress__label', text: `${i + 1}. ${s.short || s.label}` }),
          ),
        ),
      );
    });
    progressCount.textContent = `Step ${st.index + 1} of ${st.steps.length} · ${step().label}`;
  }

  function renderActions() {
    const last = st.index === st.steps.length - 1;
    backBtn.disabled = st.index === 0;
    skipBtn.hidden = last;
    if (escHint) escHint.hidden = last;
    if (last) {
      const dest = M.firstDestination(st.draft);
      nextBtn.textContent = dest.kind === 'board' ? `Open /${dest.board}/` : 'Open the board list';
    } else {
      nextBtn.textContent = 'Next';
    }
  }

  /** Draws the current step. `focus`: 'heading' after navigation, 'keep'
   *  to restore the focused control (by data-key) after an update. */
  function render(focus = 'heading') {
    const keep = focus === 'keep' ? document.activeElement?.dataset?.key : null;
    renderProgress();
    renderActions();
    clear(host);
    const node = RENDER[step().id]();
    if (focus === 'heading') node.dataset.enter = st.dir;
    host.append(node);
    if (focus === 'heading') {
      host.scrollTop = 0;
      node.querySelector('.step__title')?.focus({ preventScroll: true });
    } else if (keep) {
      host.querySelector(`[data-key="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    }
    setTitle(`Setup · ${step().label}`);
  }

  function go(i, dir) {
    if (i < 0 || i >= st.steps.length) return;
    st.dir = dir || (i < st.index ? 'back' : 'forward');
    st.index = i;
    st.maxVisited = Math.max(st.maxVisited, i);
    st.errors = {};
    render('heading');
    enter(step().id);
  }

  function enter(id) {
    // The board list is the first request to the site, made only here.
    if (id === 'boards' && st.boards.status === 'idle') loadBoards();
    if (id === 'video' && st.ffmpeg.status === 'idle') checkFfmpeg();
  }

  function next() {
    const v = M.validateStep(step().id, st.draft);
    if (!v.ok) {
      st.errors = v.errors;
      render('none');
      host
        .querySelector('[aria-invalid="true"], .field__error')
        ?.closest('.field, .switch-row')
        ?.querySelector('input, button')
        ?.focus({ preventScroll: true });
      host.querySelector('.field__error')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    st.errors = {};
    if (st.index === st.steps.length - 1) finish(false);
    else go(st.index + 1, 'forward');
  }

  function back() {
    if (st.index > 0) go(st.index - 1, 'back');
  }

  async function finish(skipped) {
    // Prunes NSFW favourites even without a board list (remembered codes).
    const draft = M.pruneFavourites(st.draft, st.boards.status === 'ok' ? st.boards.list : null);
    const final = M.completeSetup(draft, { skipped });
    try {
      await bridge.setSettings(final);
    } catch (e) {
      toast(`Settings were not saved: ${e?.message || e}`);
    }
    close();
    applyLook(final);
    onFinish(final, { boards: st.boards.status === 'ok' ? st.boards.list : null });
  }

  let closed = false;
  /** True once this wizard closed or another one replaced it: async work
   *  that finishes then must not touch the shared setup DOM or the title. */
  const gone = () => closed || active !== api;

  function close() {
    closed = true;
    ac.abort();
    root.hidden = true;
    clear(host);
    if (active === api) active = null;
  }

  function update(mutator, focus = 'keep') {
    st.draft = mutator(structuredClone(st.draft)) || st.draft;
    render(focus);
  }

  // -------------------------------------------------------------- effects

  async function loadBoards() {
    st.boards = { status: 'loading', list: null, error: '' };
    if (step().id === 'boards') render('keep');
    try {
      const res = await bridge.fetchBoards();
      const list = Array.isArray(res?.boards) ? res.boards : [];
      if (!list.length) throw new Error('The board list came back empty.');
      if (gone()) {
        onBoards(list); // keep the late list for the shell
        return;
      }
      st.boards = { status: 'ok', list, error: '' };
      st.draft = M.pruneFavourites(st.draft, list);
    } catch (e) {
      if (gone()) return;
      st.boards = { status: 'error', list: null, error: String(e?.message || e) };
    }
    if (step().id === 'boards') {
      render('keep');
      if (st.boards.status === 'error') host.querySelector('[data-key="retry"]')?.focus();
    }
  }

  async function checkFfmpeg() {
    st.ffmpeg = { status: 'checking', check: st.ffmpeg.check };
    if (step().id === 'video') render('keep');
    let check;
    try {
      check = await bridge.checkFfmpeg();
    } catch (e) {
      check = { found: false, error: String(e?.message || e) };
    }
    if (gone()) return;
    st.ffmpeg = { status: 'done', check };
    if (step().id === 'video') render('keep');
  }

  // --------------------------------------------------------------- pieces

  function head(title, lead, eyebrow) {
    return h(
      'div',
      { class: 'step__head' },
      h('p', { class: 'step__eyebrow', text: eyebrow ?? `Step ${st.index + 1} of ${st.steps.length}` }),
      h('h1', { class: 'step__title', id: 'stepTitle', tabindex: '-1', text: title }),
      lead ? h('p', { class: 'step__lead', text: lead }) : null,
    );
  }

  function segmented(key, label, options, value, onChange) {
    const id = `seg-${key}`;
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
              name: key,
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

  function switchRow({ key, title, desc, checked, onToggle, extra = null }) {
    const tid = `sw-${key}-t`;
    const did = `sw-${key}-d`;
    return h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row__text' },
        h('div', { class: 'switch-row__title', id: tid, text: title }),
        desc ? h('div', { class: 'switch-row__desc', id: did, text: desc }) : null,
        extra,
      ),
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(Boolean(checked)),
        'aria-labelledby': tid,
        'aria-describedby': desc ? did : null,
        'data-key': `switch-${key}`,
        onclick: (e) => onToggle(e.currentTarget),
      }),
    );
  }

  const fieldError = (key) => (st.errors[key] ? h('p', { class: 'field__error', role: 'alert', text: st.errors[key] }) : null);

  // ---------------------------------------------------------------- steps

  const RENDER = {
    welcome() {
      const requests = bridge.siteRequests();
      return h(
        'section',
        { class: 'step' },
        h('img', { class: 'welcome-mark', src: 'assets/icon.svg', alt: '', width: 72, height: 72 }),
        head(
          'Welcome to CloverEye',
          'A desktop client for reading 4chan: boards and threads in a clean layout, a thread watcher, filters, and Clip, which fits a video to the board you are posting to.',
          'First-time setup',
        ),
        h(
          'div',
          { class: 'callout callout--warn' },
          icon('info'),
          h(
            'div',
            {},
            h('strong', { text: 'Unofficial. ' }),
            'CloverEye is not affiliated with or endorsed by 4chan. The site’s rules apply to everything you read and post. ',
            h('a', {
              href: RULES_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              'data-key': 'rules',
              onclick: (e) => {
                e.preventDefault();
                bridge.openExternal(RULES_URL);
              },
              text: 'Read the site’s rules',
            }),
            '.',
          ),
        ),
        h(
          'div',
          { class: 'facts' },
          h(
            'div',
            { class: 'fact' },
            h('div', { class: 'fact__title' }, icon('wifiOff'), 'Nothing sent yet'),
            requests === 0
              ? `No request to the site has been made. The first one is the board list, in step ${indexOf('boards') + 1}.`
              : requests === 1
                ? `${requests} request to the site so far this session.`
                : `${requests} requests to the site so far this session.`,
          ),
          h(
            'div',
            { class: 'fact' },
            h('div', { class: 'fact__title' }, icon('shield'), 'Polite by design'),
            'At most one request a second, threads at most every 10 s, and only what you open.',
          ),
          h(
            'div',
            { class: 'fact' },
            h('div', { class: 'fact__title' }, icon('settings'), 'About a minute'),
            `${st.steps.length} short steps. Every answer can be changed later in Settings.`,
          ),
        ),
      );
    },

    look() {
      const d = st.draft;
      // The radios already show the choice; only the look is re-applied, so
      // the sample thread is not rebuilt on every click.
      const set = (fn) => {
        fn(st.draft);
        applyLook(st.draft);
      };
      const preview = h('div', { class: 'preview__body', 'aria-label': 'Sample thread preview' });
      const bar = h(
        'div',
        { class: 'preview__bar' },
        h('span', { class: 'board-tag', style: { '--hue': M.boardHue('diy') }, text: '/diy/' }),
        h('span', { text: 'Sample thread · local data' }),
      );
      for (let i = 0; i < 3; i++) preview.append(h('div', { class: 'skeleton', style: { height: '84px' } }));
      loadSample()
        .then((t) => {
          clear(preview);
          const refs = backlinks(t.posts);
          const jump = (no) => {
            const el = preview.querySelector(`#sample-p${no}`);
            if (el) {
              el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
              el.querySelector('.seg-quotelink, button')?.focus({ preventScroll: true });
            }
          };
          for (const p of t.posts) preview.append(renderPost(p, { backrefs: refs.get(p.no) || [], onQuote: jump }));
        })
        .catch(() => {
          clear(preview);
          preview.append(h('p', { class: 'field__hint', text: 'The sample thread could not be loaded.' }));
        });
      return h(
        'section',
        { class: 'step step--wide' },
        head('Make it yours', 'Pick a theme, density and text size. The sample thread changes as you go.'),
        h(
          'div',
          { class: 'look' },
          h(
            'div',
            { class: 'stack' },
            themePicker({ value: d.theme, onChange: (v) => set((s) => (s.theme = v)) }),
            segmented(
              'density',
              'Density',
              [
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ],
              d.density,
              (v) => set((s) => (s.density = v)),
            ),
            segmented('text', 'Text size', M.TEXT_SCALES, d.textScale, (v) => set((s) => (s.textScale = v))),
            h('p', { class: 'field__hint', text: 'System follows your desktop’s light or dark setting.' }),
          ),
          h('div', { class: 'preview' }, bar, preview),
        ),
      );
    },

    boards() {
      const b = st.boards;
      const body = [];
      if (b.status === 'idle' || b.status === 'loading') {
        body.push(
          h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Loading the board list…'),
          h(
            'div',
            { class: 'board-grid board-grid--skeleton', 'aria-busy': 'true', 'aria-hidden': 'true' },
            Array.from({ length: 12 }, () => h('div', { class: 'skeleton' })),
          ),
        );
      } else if (b.status === 'error') {
        body.push(
          h(
            'div',
            { class: 'callout callout--danger', role: 'alert' },
            icon('wifiOff'),
            h('div', {}, h('strong', { text: 'Couldn’t load the board list. ' }), b.error, ' You can retry, or skip this step and pick favourites later.'),
          ),
          h(
            'div',
            { class: 'inline' },
            h('button', { type: 'button', class: 'btn', 'data-key': 'retry', onclick: () => loadBoards() }, icon('refresh'), 'Retry'),
            h('button', { type: 'button', class: 'btn btn--ghost', 'data-key': 'skip-step', onclick: () => go(st.index + 1, 'forward') }, 'Skip this step'),
          ),
        );
      } else {
        const visible = M.visibleBoards(b.list, st.draft);
        const shown = M.filterBoards(visible, st.query);
        const hidden = M.hiddenBoardCount(b.list, st.draft);
        const count = h('span', { class: 'pill', 'aria-live': 'polite', text: `${st.draft.favourites.length} selected` });
        const grid = h('div', {
          class: 'board-grid',
          role: 'group',
          'aria-label': 'Boards',
          'data-grid': '',
          onkeydown: gridKeys,
        });
        const fillGrid = (list) => {
          clear(grid);
          if (!list.length) grid.append(h('p', { class: 'field__hint', text: 'No board matches that.' }));
          for (const bd of list) {
            const checked = st.draft.favourites.includes(bd.board);
            grid.append(
              h(
                'button',
                {
                  type: 'button',
                  class: 'board-tile',
                  role: 'checkbox',
                  'aria-checked': String(checked),
                  'data-key': `board-${bd.board}`,
                  'data-board': bd.board,
                  title: bd.title,
                  tabindex: '-1',
                  style: { '--hue': M.boardHue(bd.board) },
                  onfocus: (e) => {
                    st.gridFocus = bd.board;
                    rove(grid, e.currentTarget);
                  },
                  onclick: (e) => {
                    const before = st.draft.favourites.length;
                    st.draft = M.toggleFavourite(st.draft, bd.board);
                    if (st.draft.favourites.length === before && !st.draft.favourites.includes(bd.board)) {
                      toast(`At most ${M.MAX_FAVOURITES} favourites`);
                    }
                    e.currentTarget.setAttribute('aria-checked', String(st.draft.favourites.includes(bd.board)));
                    count.textContent = `${st.draft.favourites.length} selected`;
                    renderActions();
                  },
                },
                h('span', { class: 'board-tile__code', text: `/${bd.board}/` }),
                h('span', { class: 'board-tile__title', text: bd.title }),
                h('span', { class: 'board-tile__check', 'aria-hidden': 'true' }, icon('check')),
              ),
            );
          }
          // One Tab stop for the whole grid: the last focused tile if it is
          // still shown, else the first selected one, else the first.
          const tiles = [...grid.querySelectorAll('.board-tile')];
          rove(
            grid,
            tiles.find((t) => t.dataset.board === st.gridFocus) ||
              tiles.find((t) => t.getAttribute('aria-checked') === 'true') ||
              tiles[0],
          );
        };
        fillGrid(shown);
        body.push(
          h(
            'div',
            { class: 'boards-tools' },
            h('input', {
              type: 'search',
              class: 'input',
              placeholder: 'Filter boards: code or name',
              'aria-label': 'Filter boards',
              value: st.query,
              'data-key': 'board-filter',
              oninput: (e) => {
                st.query = e.target.value;
                fillGrid(M.filterBoards(visible, st.query));
              },
            }),
            count,
          ),
          hidden > 0
            ? h(
                'p',
                { class: 'field__hint' },
                `${hidden} NSFW boards are hidden. `,
                'Settings → Content can show them.',
              )
            : null,
          grid,
          fieldError('favourites'),
        );
      }
      return h(
        'section',
        { class: 'step step--wide' },
        head(
          'Pick favourite boards',
          'Favourites sit in the left rail. Opening this step made CloverEye’s first request to the site: the board list.',
        ),
        ...body,
      );
    },

    video() {
      const f = st.ffmpeg;
      const body = [];
      if (f.status !== 'done') {
        body.push(
          h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Checking ffmpeg on this computer…'),
          h('div', { class: 'skeleton', style: { height: '260px' }, 'aria-hidden': 'true' }),
        );
      } else {
        const r = M.clipReadiness(f.check);
        const hint = M.installHint({ os: f.check?.os, distro: f.check?.distro, package: f.check?.package });
        const pkg = M.packageLabel(f.check?.package);
        body.push(
          h(
            'ul',
            { class: 'checks', 'aria-label': 'ffmpeg check' },
            r.rows.map((row) => {
              const detail =
                row.id === 'ffmpeg' && f.check?.found
                  ? [f.check.version || 'unknown version', pkg ? `from ${pkg}` : '', f.check.path || ''].filter(Boolean).join(' · ')
                  : row.detail;
              return h(
                'li',
                { class: 'check', 'data-ok': String(row.ok), 'data-required': String(row.required) },
                h('span', { class: 'check__mark', 'aria-hidden': 'true', text: row.ok ? '✓' : '✗' }),
                h('div', {}, h('div', { class: 'check__name', text: row.label }), h('div', { class: 'check__detail', text: detail })),
                h('span', { class: 'check__state', text: row.ok ? 'found' : row.required ? 'missing' : 'missing, optional' }),
              );
            }),
          ),
          r.ready
            ? h(
                'div',
                { class: 'callout callout--ok', role: 'status' },
                icon('check'),
                h('div', {}, h('strong', { text: 'Clip is ready. ' }), r.missingOptional.length ? 'Some extras are missing; Clip works without them.' : 'Everything it can use is here.'),
              )
            : h('div', { class: 'callout callout--warn', role: 'status' }, icon('info'), h('div', { text: r.reason })),
        );
        if (r.missingRequired.length || r.missingOptional.length) {
          body.push(
            h(
              'div',
              { class: 'field' },
              h('div', { class: 'field__label', text: 'Install command for this computer' }),
              hint.command
                ? h(
                    'div',
                    { class: 'command' },
                    h('code', { text: hint.command }),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn--sm',
                        'data-key': 'copy-install',
                        onclick: async () => toast((await copyText(hint.command)) ? 'Command copied' : 'Copy failed: select the text instead'),
                      },
                      icon('copy'),
                      'Copy',
                    ),
                  )
                : null,
              h('p', {
                class: 'field__hint',
                text: `${hint.note ? `${hint.note} ` : ''}CloverEye never runs this and never asks for admin rights: paste it into a terminal yourself, then re-check.`,
              }),
            ),
          );
        }
        body.push(
          h(
            'div',
            { class: 'inline' },
            h('button', { type: 'button', class: 'btn', 'data-key': 'recheck', onclick: () => checkFfmpeg() }, icon('refresh'), 'Re-check'),
          ),
        );
      }
      return h(
        'section',
        { class: 'step' },
        head('Video (Clip)', 'Clip fits a video to the board you are posting to, using ffmpeg on this computer. This step only checks what is installed.'),
        ...body,
      );
    },

    watching() {
      const w = st.draft.watch;
      const perm = st.notifyPermission;
      const permText =
        perm === 'granted'
          ? 'System permission: allowed.'
          : perm === 'denied'
            ? 'Your system blocked notifications. Unread counts still show in the watcher.'
            : perm === 'later'
              ? 'CloverEye asks the system for permission when notifications arrive in a later version.'
              : perm === 'unsupported'
                ? 'This environment has no system notifications.'
                : null;
      const presetLabel = (n) => (n < 60 ? `${n} s` : `${n / 60} min`);
      return h(
        'section',
        { class: 'step' },
        head('Watching threads', 'How CloverEye keeps an eye on the threads you watch.'),
        switchRow({
          key: 'notify',
          title: 'Notify me about replies to my posts',
          desc: 'The system is asked for permission only if you turn this on.',
          checked: w.notifyReplies,
          extra: w.notifyReplies && permText ? h('div', { class: 'switch-row__desc', role: 'status', text: permText }) : null,
          onToggle: async () => {
            const turnOn = !st.draft.watch.notifyReplies;
            update((s) => {
              s.watch.notifyReplies = turnOn;
              return s;
            });
            if (turnOn) {
              st.notifyPermission = await bridge.requestNotificationPermission();
              if (step().id === 'watching') render('keep');
            }
          },
        }),
        switchRow({
          key: 'tray',
          title: 'Keep running in the tray when the window closes',
          desc: 'Watched threads keep updating in the background. Off means closing the window quits CloverEye.',
          checked: w.keepInTray,
          onToggle: () =>
            update((s) => {
              s.watch.keepInTray = !s.watch.keepInTray;
              return s;
            }),
        }),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'intervalInput', text: 'Update watched threads every' }),
          h(
            'div',
            { class: 'inline' },
            h('input', {
              id: 'intervalInput',
              class: 'input input--short',
              type: 'number',
              inputmode: 'numeric',
              min: M.MIN_WATCH_INTERVAL,
              max: M.MAX_WATCH_INTERVAL,
              step: 1,
              value: Number.isFinite(w.intervalSec) ? w.intervalSec : '',
              'aria-invalid': st.errors.intervalSec ? 'true' : null,
              'aria-describedby': 'intervalHint',
              'data-key': 'interval',
              oninput: (e) => {
                const v = e.target.value.trim();
                st.draft.watch.intervalSec = v === '' ? NaN : Number(v);
                for (const b of e.target.closest('.field').querySelectorAll('.presets [data-n]')) {
                  b.setAttribute('aria-pressed', String(Number(b.dataset.n) === st.draft.watch.intervalSec));
                }
                if (st.errors.intervalSec) {
                  delete st.errors.intervalSec;
                  e.target.removeAttribute('aria-invalid');
                  e.target.closest('.field').querySelector('.field__error')?.remove();
                }
              },
            }),
            h('span', { class: 'field__hint', text: 'seconds' }),
          ),
          h(
            'div',
            { class: 'presets', role: 'group', 'aria-label': 'Presets' },
            M.WATCH_PRESETS.map((n) =>
              h('button', {
                type: 'button',
                class: 'btn btn--sm',
                'aria-pressed': String(w.intervalSec === n),
                'data-key': `preset-${n}`,
                'data-n': n,
                onclick: () =>
                  update((s) => {
                    s.watch.intervalSec = n;
                    return s;
                  }),
                text: presetLabel(n),
              }),
            ),
          ),
          h('p', {
            class: 'field__hint',
            id: 'intervalHint',
            text: `${M.MIN_WATCH_INTERVAL} seconds is the minimum: the site’s API rules ask clients not to update a thread more often. Quiet threads are checked less often on their own.`,
          }),
          fieldError('intervalSec'),
        ),
      );
    },

    files() {
      const f = st.draft.files;
      return h(
        'section',
        { class: 'step' },
        head('Files and privacy', 'Where downloads go, what leaves your computer with an image, and what is kept while you browse.'),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'downloadDir', text: 'Download folder' }),
          h('input', {
            id: 'downloadDir',
            class: 'input',
            type: 'text',
            placeholder: 'Downloads/CloverEye',
            value: f.downloadDir,
            spellcheck: 'false',
            autocomplete: 'off',
            'aria-invalid': st.errors.downloadDir ? 'true' : null,
            'data-key': 'downloadDir',
            oninput: (e) => {
              st.draft.files.downloadDir = e.target.value;
            },
          }),
          h('p', { class: 'field__hint', text: 'Files reach your disk only when you download them. Leave empty to use Downloads/CloverEye.' }),
          fieldError('downloadDir'),
        ),
        switchRow({
          key: 'strip',
          title: 'Strip location and camera data from images before posting',
          desc: 'Removes EXIF and GPS from JPEG and text chunks from PNG, with a one-line report each time. On by default.',
          checked: f.stripMetadata,
          onToggle: () =>
            update((s) => {
              s.files.stripMetadata = !s.files.stripMetadata;
              return s;
            }),
        }),
        segmented(
          'cache',
          'Media cache',
          [
            { value: 'memory', label: 'Memory only' },
            { value: 'temp', label: 'Temporary cache' },
          ],
          f.cache,
          (v) =>
            update((s) => {
              s.files.cache = v;
              return s;
            }),
        ),
        f.cache === 'temp'
          ? h(
              'div',
              { class: 'field' },
              h('label', { class: 'field__label', for: 'cacheCap', text: 'Cache size limit' }),
              h(
                'select',
                {
                  id: 'cacheCap',
                  class: 'input',
                  'data-key': 'cacheCap',
                  onchange: (e) => {
                    st.draft.files.cacheCapMB = Number(e.target.value);
                  },
                },
                M.CACHE_CAPS_MB.map((n) => h('option', { value: n, selected: n === f.cacheCapMB, text: n >= 1024 ? `${n / 1024} GB` : `${n} MB` })),
              ),
              h('p', { class: 'field__hint', text: 'A temporary folder, emptied when CloverEye quits.' }),
              fieldError('cacheCapMB'),
            )
          : h('p', { class: 'field__hint', text: 'Thumbnails and media are kept in memory while CloverEye runs and nothing is written to disk.' }),
      );
    },

    done() {
      const clip = st.ffmpeg.status === 'done' ? M.clipReadiness(st.ffmpeg.check) : null;
      const rows = M.summary(st.draft, { clip });
      const requests = bridge.siteRequests();
      return h(
        'section',
        { class: 'step' },
        head('All set', 'Here is what you chose. Change anything now, or later in Settings.'),
        h(
          'dl',
          { class: 'summary' },
          rows.map((r) => {
            const i = indexOf(r.step);
            return h(
              'div',
              { class: 'summary__row' },
              h('dt', { text: r.label }),
              h('dd', { text: r.value }),
              i >= 0
                ? h('button', { type: 'button', class: 'link-btn', 'data-key': `change-${r.step}`, onclick: () => go(i, 'back'), text: 'Change', 'aria-label': `Change ${r.label}` })
                : h('span'),
            );
          }),
        ),
        h(
          'div',
          { class: 'callout' },
          icon('shield'),
          h('div', {
            text:
              requests === 0
                ? 'No request to the site was made during setup.'
                : `Requests to the site during setup: ${requests} (the board list).`,
          }),
        ),
      );
    },
  };

  /** Roving tabindex: only `tile` is in the Tab order. */
  function rove(grid, tile) {
    for (const t of grid.querySelectorAll('.board-tile')) t.tabIndex = t === tile ? 0 : -1;
  }

  // Arrow keys move between tiles in the board grid (one Tab stop).
  function gridKeys(e) {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tiles = [...e.currentTarget.querySelectorAll('.board-tile')];
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = getComputedStyle(e.currentTarget).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    let j = i;
    if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowDown') j = i + cols;
    else if (e.key === 'ArrowUp') j = i - cols;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tiles.length - 1;
    j = Math.max(0, Math.min(tiles.length - 1, j));
    e.preventDefault();
    tiles[j].focus();
  }

  function onKey(e) {
    if (root.hidden) return;
    const action = M.keyAction({
      key: e.key,
      target: targetKind(e.target),
      dialogOpen: Boolean(document.querySelector('dialog[open]')),
      mods: e.ctrlKey || e.metaKey || e.altKey || e.shiftKey,
      composing: e.isComposing,
    });
    if (!action || action === 'close-dialog') return; // <dialog> closes itself on Esc
    e.preventDefault();
    if (action === 'next') next();
    else if (action === 'back') back();
    else if (action === 'skip' && !skipBtn.hidden) openDialog('skipDialog', document.activeElement);
  }

  on(document, 'keydown', onKey);
  on(nextBtn, 'click', () => next());
  on(backBtn, 'click', () => back());
  on(skipBtn, 'click', () => openDialog('skipDialog', skipBtn));

  const api = {
    finish,
    state: st,
  };
  active = api;
  root.hidden = false;
  render('heading');
  enter(step().id);
  return api;
}
