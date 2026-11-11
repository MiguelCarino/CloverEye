// The reply form (quick reply): floats over the window, outside the shell's
// redraws, so a thread updating itself never wipes what is being typed.
// The captcha is the site's own; the person solves it here. The post goes
// out through the bridge (the post helper in the desktop app).

import * as C from './compose-model.js';
import { h, icon, toast } from './dom.js';

/**
 * @param {object} o
 * @param {object} o.bridge
 * @param {() => object} o.getSettings
 * @param {(next: object) => void} o.saveSettings
 * @param {(board: string) => Promise<object|null>} o.getBoard   boards.json entry
 * @param {(p: {board: string, thread: number, no: number}) => void} o.onPosted
 * @param {(board: string, thread: number, quote: number) => void} [o.onSitePage]
 */
const DRAFTS_KEY = 'clovereye-drafts';
const SIZE_KEY = 'clovereye-composer-size';
const MIN_W = 300;
const MIN_H = 240;

/** The size the person gave the form, kept for next time ({ w, h } or null). */
function loadSize() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    return s && Number.isFinite(s.w) && Number.isFinite(s.h) ? { w: s.w, h: s.h } : null;
  } catch (_) {
    return null;
  }
}

function saveSize(size) {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch (_) {
    /* no storage: the size lasts until the app closes */
  }
}

/** Keeps a size inside the window (the form sits 16 px from its corner). */
function fitSize(size) {
  if (!size) return null;
  const maxW = Math.max(MIN_W, innerWidth - 32);
  const maxH = Math.max(MIN_H, innerHeight - 80);
  return { w: Math.round(Math.min(maxW, Math.max(MIN_W, size.w))), h: Math.round(Math.min(maxH, Math.max(MIN_H, size.h))) };
}
const MAX_DRAFTS = 50;

/** Drafts saved by an earlier run (see persistDrafts). */
function loadDrafts() {
  const out = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
    for (const [k, d] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!/^[a-z0-9]{1,10}\/\d{1,12}$/.test(k) || !d || typeof d !== 'object') continue;
      out.set(k, { com: String(d.com || ''), sub: String(d.sub || ''), email: String(d.email || ''), at: Number(d.at) || 0 });
    }
  } catch (_) {
    /* nothing saved, or no storage */
  }
  return out;
}

/** "1 min 05 s", "42 s". */
function formatLeft(s) {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** The text selected inside one post card's own comment (not in quoted
 *  copies opened inside it), one line per line of the post; '' when the
 *  selection is elsewhere or empty. Read as the post's No. is pressed. */
export function postSelection(post) {
  const sel = globalThis.getSelection?.();
  if (!post || !sel || sel.isCollapsed || !sel.rangeCount) return '';
  const com = [...post.querySelectorAll('.post__com')].find((c) => c.closest('.post') === post);
  if (!com) return '';
  try {
    const r = sel.getRangeAt(0);
    const part = document.createRange();
    part.selectNodeContents(com);
    const a = part.comparePoint(r.startContainer, r.startOffset);
    const b = part.comparePoint(r.endContainer, r.endOffset);
    if (a > 0 || b < 0) return ''; // wholly before or after the comment
    if (a === 0) part.setStart(r.startContainer, r.startOffset);
    if (b === 0) part.setEnd(r.endContainer, r.endOffset);
    const box = document.createElement('div');
    box.append(part.cloneContents());
    return C.selectionText(box);
  } catch (_) {
    return ''; // a selection in another document (a frame): nothing to quote
  }
}

export function createComposer({ bridge, getSettings, saveSettings, getBoard, onPosted, onSitePage = null }) {
  const drafts = loadDrafts(); // "board/thread" → { com, sub, email, at }
  const cooldowns = new Map(); // board → time the next post may go
  let st = null; // the open form
  let el = null;
  let tick = null;
  let saveTimer = 0;
  let size = loadSize(); // set by dragging the corner grip

  function applySize(node) {
    const s = fitSize(size);
    if (!node || !s || st?.min) return;
    node.style.width = `${s.w}px`;
    node.style.height = `${s.h}px`;
    node.style.maxHeight = 'none';
  }

  // The grip in the top-left corner (the form is anchored bottom-right):
  // drag it, or use the arrow keys on it; double-click puts the size back.
  function grip() {
    const start = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev) => {
        size = fitSize({ w: box.width - (ev.clientX - x0), h: box.height - (ev.clientY - y0) });
        applySize(el);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        el?.classList.remove('composer--resizing');
        saveSize(size);
      };
      el.classList.add('composer--resizing');
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
    const keys = (e) => {
      const step = e.shiftKey ? 60 : 20;
      const box = el.getBoundingClientRect();
      const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (!d) return;
      e.preventDefault();
      size = fitSize({ w: box.width + d[0], h: box.height + d[1] });
      applySize(el);
      saveSize(size);
    };
    const reset = () => {
      size = null;
      saveSize(null);
      draw('keep');
    };
    return h('button', {
      type: 'button',
      class: 'composer__grip',
      'aria-label': 'Resize the reply form: drag, or arrow keys (double-click: default size)',
      title: 'Drag to resize · double-click: default size',
      'data-key': 'compose-grip',
      onpointerdown: start,
      onkeydown: keys,
      ondblclick: reset,
    });
  }

  const key = (board, thread) => `${board}/${thread || 0}`;

  // Drafts outlive the app: kept in this app's own storage as they are
  // typed, so closing CloverEye (or a crash) loses nothing. The attached
  // file is not kept, only the text.
  function persistDrafts() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      const list = [...drafts.entries()].filter(([, d]) => d.com || d.sub || d.email);
      list.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(list.slice(0, MAX_DRAFTS))));
    } catch (_) {
      /* no storage: drafts last until the app closes */
    }
  }

  function typed() {
    if (!st) return;
    drafts.set(key(st.board, st.thread), { com: st.com, sub: st.sub, email: st.email, at: Date.now() });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistDrafts, 400);
  }

  addEventListener('pagehide', () => {
    stash();
    persistDrafts();
  });

  function pwd(settings) {
    if (settings.post?.pwd) return settings.post.pwd;
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const made = Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
    saveSettings({ ...settings, post: { ...(settings.post || {}), pwd: made } });
    return made;
  }

  function stash() {
    if (!st) return;
    drafts.set(key(st.board, st.thread), { com: st.com, sub: st.sub, email: st.email, at: Date.now() });
    persistDrafts();
  }

  function setMin(on) {
    if (!st) return;
    st.min = on;
    draw('none');
    if (!on) el?.querySelector('[data-key="compose-com"]')?.focus({ preventScroll: true });
    else el?.querySelector('[data-key="compose-restore"]')?.focus({ preventScroll: true });
  }

  function close() {
    stash();
    clearInterval(tick);
    tick = null;
    el?.remove();
    el = null;
    st = null;
  }

  async function open({ board, thread = 0, quote = 0, selection = '' }) {
    const same = st && st.board === board && st.thread === thread;
    // An open form takes the quote at its caret; a form opened now, at the end.
    const ta0 = same ? el?.querySelector('[data-key="compose-com"]') : null;
    const caret = ta0 && document.activeElement === ta0 ? ta0.selectionStart : same ? st.caret : null;
    if (!same) {
      stash();
      const d = drafts.get(key(board, thread)) || {};
      const s = getSettings();
      st = {
        board,
        thread,
        com: d.com || '',
        sub: d.sub || '',
        email: d.email || '',
        name: s.post?.name || '',
        file: null, // { name, size, type, bytes, randomName }
        spoiler: false,
        randomName: s.post?.randomName === true, // send the file under its random name
        caret: null, // where the comment's caret was when it lost the focus
        strip: s.files?.stripMetadata !== false,
        captcha: { state: 'idle' },
        busy: false,
        problems: [],
        message: '',
        info: null,
        min: false, // folded down to its title bar
      };
    }
    st.min = false;
    const picked = String(selection || '').trim() ? String(selection) : '';
    // The selection comes in as greentext under the >>N; a bare >>N only
    // when the comment does not quote that post yet.
    if (picked || (quote && !st.com.includes(`>>${quote}`))) {
      const r = C.insertAtCaret(st.com, Number.isFinite(caret) ? caret : st.com.length, C.quoteText(quote, picked));
      st.com = r.text;
      st.caret = r.caret;
    } else if (Number.isFinite(caret)) st.caret = caret;
    draw();
    const ta = el.querySelector('[data-key="compose-com"]');
    ta?.focus();
    if (ta) ta.selectionStart = ta.selectionEnd = Number.isFinite(st.caret) ? Math.min(st.caret, ta.value.length) : ta.value.length;
    if (!same) {
      st.info = await getBoard(board).catch(() => null);
      if (st && st.board === board) draw('keep');
      loadCaptcha();
    }
  }

  async function loadCaptcha() {
    if (!st) return;
    const mine = st;
    const seq = (mine.captchaSeq = (mine.captchaSeq || 0) + 1);
    const stale = () => st !== mine || mine.captchaSeq !== seq; // a newer request took over
    st.captcha = { state: 'loading' };
    draw('keep');
    let data;
    try {
      data = await bridge.captcha(mine.board, mine.thread);
    } catch (e) {
      const msg = String(e?.message || e);
      data = null;
      if (stale()) return;
      st.captcha =
        msg === 'check-needed'
          ? { state: 'error', message: 'The site wants a quick browser check. A CloverEye window with the site opened: complete it there, then press New captcha.' }
          : { state: 'error', message: msg };
      draw('keep');
      return;
    }
    if (stale()) return;
    st.captcha = C.captchaState(data);
    draw('keep');
    if (st.captcha.state === 'ready') el?.querySelector('[data-key="compose-slider"]')?.focus({ preventScroll: true });
  }

  async function pickFile(file) {
    if (!st || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name || 'pasted.png';
    st.file = { name, size: bytes.length, type: file.type || '', bytes, randomName: C.randomFileName(name) };
    draw('keep');
  }

  async function submit() {
    if (!st || st.busy) return;
    const s = getSettings();
    const isThread = !st.thread;
    st.problems = C.preflight({
      board: st.info,
      isThread,
      com: st.com,
      sub: st.sub,
      file: st.file,
      captcha: st.captcha,
      cooldownUntil: cooldowns.get(st.board) || 0,
    });
    if (st.problems.length) {
      draw('keep');
      el?.querySelector('.composer__problems')?.focus?.();
      return;
    }
    const mine = st;
    st.busy = true;
    st.message = 'Posting…';
    draw('keep');
    let file = null;
    let cleaned = 0;
    if (mine.file) {
      let bytes = mine.file.bytes;
      if (mine.strip) {
        const r = C.stripMetadata(bytes, mine.file.name);
        bytes = r.bytes;
        cleaned = r.removed;
      }
      file = { name: C.uploadName(mine.file, mine.randomName), type: mine.file.type, b64: C.toBase64(bytes) };
    }
    const fields = C.postFields({
      isThread,
      thread: mine.thread,
      name: mine.name,
      email: mine.email,
      sub: mine.sub,
      com: mine.com,
      spoiler: mine.spoiler,
      challenge: mine.captcha.challenge || '',
      response: C.captchaAnswer(mine.captcha),
      pwd: pwd(s),
    });
    let result;
    try {
      const res = await bridge.submitPost(mine.board, fields, file);
      result = C.parsePostResponse(res?.text, res?.status);
    } catch (e) {
      const msg = String(e?.message || e);
      result = { ok: false, message: msg === 'check-needed' ? 'The site wants a quick browser check: complete it in the window that opened, then post again.' : msg };
    }
    if (st !== mine) return;
    mine.busy = false;
    if (!result.ok) {
      mine.message = result.message;
      // A used captcha is gone either way: fetch the next one.
      if (mine.captcha.state === 'ready') loadCaptcha();
      else draw('keep');
      return;
    }
    const wait = C.cooldownSeconds(mine.info, { isThread, hasFile: Boolean(file) });
    if (wait) cooldowns.set(mine.board, Date.now() + wait * 1000);
    const next = C.addYou({ ...getSettings(), post: { ...(getSettings().post || {}), name: mine.name } }, mine.board, result.no);
    saveSettings(next);
    drafts.delete(key(mine.board, mine.thread));
    persistDrafts();
    toast(`Posted: No. ${result.no}${cleaned ? ' · location and camera data removed' : ''}`);
    st = null;
    el?.remove();
    el = null;
    clearInterval(tick);
    onPosted({ board: mine.board, thread: result.thread, no: result.no });
  }

  // ------------------------------------------------------------------ draw

  function field(label, input) {
    return h('label', { class: 'composer__field' }, h('span', { class: 'composer__label', text: label }), input);
  }

  function captchaBlock() {
    const c = st.captcha;
    if (c.state === 'loading' || c.state === 'idle') {
      return h(
        'div',
        { class: 'state-line composer__loading', role: 'status' },
        icon('refresh'),
        h(
          'div',
          {},
          'Loading the site’s captcha… If the site wants its human check, a CloverEye “Site check” window comes forward: complete it there; this form continues by itself. ',
          bridge.showSiteWindow
            ? h(
                'button',
                { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-site-window', onclick: () => bridge.showSiteWindow().catch(() => {}) },
                icon('external'),
                'Show the site window',
              )
            : null,
        ),
      );
    }
    if (c.state === 'none') return h('p', { class: 'state-line', role: 'status' }, icon('check'), 'No captcha needed this time.');
    const again = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-captcha-new', onclick: loadCaptcha }, icon('refresh'), 'New captcha');
    if (c.state !== 'ready') {
      const left = c.until ? Math.max(0, Math.ceil((c.until - Date.now()) / 1000)) : 0;
      // The site's wait, or the abuse check's: asking now only counts against you.
      again.disabled = left > 0;
      return h(
        'div',
        { class: `callout ${c.state === 'wait' ? 'callout--warn' : 'callout--danger'}`, role: 'status' },
        icon('info'),
        h(
          'div',
          {},
          c.message,
          c.until ? h('span', { class: 'composer__wait', 'data-captcha-wait': '', text: waitText(left, c.state) }) : null,
          ' ',
          again,
        ),
      );
    }
    const left = Math.max(0, Math.ceil((c.expires - Date.now()) / 1000));
    const progress = h(
      'ol',
      { class: 'captcha__steps', 'aria-label': 'Captcha steps' },
      c.tasks.map((_, i) => h('li', { class: i < c.picks.length ? 'done' : i === c.step ? 'now' : '', text: String(i + 1) })),
    );
    if (C.captchaDone(c)) {
      return h(
        'div',
        { class: 'captcha' },
        progress,
        h('p', { class: 'state-line', role: 'status' }, icon('check'), 'Captcha answered. Post when ready.'),
        h('div', { class: 'captcha__row' }, again),
      );
    }
    const task = c.tasks[c.step];
    const shown = c.current === 0 ? task.promptImg : task.items[c.current - 1];
    const set = (n) => {
      st.captcha = C.captchaShow(st.captcha, n);
      draw('keep');
    };
    const next = () => {
      st.captcha = C.captchaNext(st.captcha);
      draw('none');
      (el.querySelector('[data-key="compose-slider"]') || el.querySelector('[data-key="compose-submit"]'))?.focus();
    };
    return h(
      'div',
      { class: 'captcha' },
      progress,
      task.prompt ? h('p', { class: 'captcha__prompt', text: task.prompt }) : null,
      h(
        'div',
        { class: 'captcha__view' },
        h(
          'div',
          { class: 'captcha__stage' },
          shown ? h('img', { class: 'captcha__img', src: shown, alt: c.current === 0 ? 'The captcha’s question' : `Choice ${c.current} of ${task.items.length}` }) : h('span', { class: 'field__hint', text: 'Slide to see the choices.' }),
        ),
        task.target
          ? h(
              'figure',
              { class: 'captcha__target', 'data-key': 'compose-target' },
              h('img', { src: task.target, alt: 'The object to find' }),
              h('figcaption', { text: 'Find this' }),
            )
          : null,
      ),
      h('input', {
        type: 'range',
        min: '0',
        max: String(task.items.length),
        value: String(c.current),
        class: 'captcha__slider',
        'aria-label': `Step ${c.step + 1} of ${c.tasks.length}: slide through the ${task.items.length} choices`,
        'aria-valuetext': c.current === 0 ? 'the question' : `choice ${c.current} of ${task.items.length}`,
        'data-key': 'compose-slider',
        oninput: (e) => set(e.target.value),
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && st.captcha.current > 0) {
            e.preventDefault();
            next();
          }
        },
      }),
      h(
        'div',
        { class: 'captcha__row' },
        h(
          'button',
          { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': 'compose-captcha-next', disabled: c.current < 1, onclick: next },
          c.step + 1 < c.tasks.length ? `This one · next (${c.step + 1}/${c.tasks.length})` : 'This one · done',
        ),
        again,
      ),
      h('p', { class: 'field__hint', 'data-captcha-left': '', text: left ? `Expires in ${left} s. Slide (or ←/→), then Enter to keep a choice.` : 'Expired: get a new one.' }),
    );
  }

  /** Draws the form. 'keep' keeps focus and caret where they were. */
  function draw(focus = 'none') {
    if (!st) return;
    const active = document.activeElement;
    const focusKey = el && el.contains(active) ? active?.dataset?.key : null;
    const caret = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const info = st.info;
    const isThread = !st.thread;
    const max = info?.max_comment_chars || 2000;
    const fileLimit = st.file && /\.(webm|mp4)$/i.test(st.file.name) ? info?.max_webm_filesize : info?.max_filesize;
    const next = h(
      'section',
      {
        class: `composer${st.min ? ' composer--min' : ''}`,
        role: 'dialog',
        'aria-label': isThread ? `New thread on /${st.board}/` : `Reply to No. ${st.thread}`,
        'data-key': 'composer',
      },
      h(
        'div',
        { class: 'composer__head' },
        st.min ? null : grip(),
        st.min
          ? h(
              'button',
              { type: 'button', class: 'composer__title composer__title--btn', 'data-key': 'compose-restore', 'aria-expanded': 'false', onclick: () => setMin(false) },
              h('strong', { text: isThread ? `New thread on /${st.board}/` : `Reply to /${st.board}/ No. ${st.thread}` }),
            )
          : h('strong', { class: 'composer__title', text: isThread ? `New thread on /${st.board}/` : `Reply to /${st.board}/ No. ${st.thread}` }),
        st.min ? h('span', { class: 'composer__note', 'data-compose-note': '', text: headNote() }) : null,
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn icon-btn--sm composer__fold',
            'aria-label': st.min ? 'Open the reply form again' : 'Minimise the reply form (it keeps everything)',
            'aria-expanded': String(!st.min),
            'data-key': 'compose-min',
            onclick: () => setMin(!st.min),
          },
          icon(st.min ? 'maximize' : 'minus'),
        ),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close the reply form (the draft is kept)', 'data-key': 'compose-close', onclick: close }, icon('x')),
      ),
      h(
        'div',
        {
          class: 'composer__body',
          ondragover: (e) => e.preventDefault(),
          ondrop: (e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files?.[0];
            if (f) pickFile(f);
          },
        },
        h(
          'div',
          { class: 'composer__row' },
          field('Name', h('input', { class: 'input', value: st.name, placeholder: 'Anonymous', maxlength: '100', 'data-key': 'compose-name', oninput: (e) => (st.name = e.target.value) })),
          field('Options', h('input', { class: 'input', value: st.email, placeholder: 'sage', maxlength: '100', 'data-key': 'compose-email', oninput: (e) => ((st.email = e.target.value), typed()) })),
        ),
        isThread || info?.require_subject
          ? field('Subject', h('input', { class: 'input', value: st.sub, maxlength: '100', 'data-key': 'compose-sub', oninput: (e) => ((st.sub = e.target.value), typed()) }))
          : null,
        field(
          'Comment',
          h('textarea', {
            class: 'input composer__com',
            rows: '6',
            'data-key': 'compose-com',
            onblur: (e) => (st.caret = e.target.selectionStart),
            oninput: (e) => {
              st.com = e.target.value;
              st.caret = e.target.selectionStart;
              typed();
              const n = el.querySelector('[data-com-count]');
              if (n) {
                n.textContent = `${st.com.length} / ${max}`;
                n.classList.toggle('over', st.com.length > max);
              }
            },
            onpaste: (e) => {
              const f = [...(e.clipboardData?.files || [])][0];
              if (f) {
                e.preventDefault();
                pickFile(f);
              }
            },
            onkeydown: (e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            },
          }),
        ),
        h('div', { class: 'composer__count', 'data-com-count': '', text: `${st.com.length} / ${max}` }),
        h(
          'div',
          { class: 'composer__file' },
          h(
            'label',
            { class: 'btn btn--sm' },
            icon('folder'),
            st.file ? 'Change file' : 'Attach file',
            h('input', {
              type: 'file',
              class: 'visually-hidden',
              accept: 'image/jpeg,image/png,image/gif,video/webm,video/mp4,application/pdf,.jpg,.jpeg,.png,.gif,.webm,.mp4,.pdf',
              'data-key': 'compose-file',
              onchange: (e) => pickFile(e.target.files?.[0]),
            }),
          ),
          st.file
            ? h(
                'span',
                { class: 'composer__filename' },
                `${C.uploadName(st.file, st.randomName)} · ${(st.file.size / 1024 / 1024).toFixed(2)} MB${fileLimit ? ` of ${(fileLimit / 1024 / 1024).toFixed(0)} MB` : ''}`,
                st.randomName ? h('span', { class: 'composer__origname', translate: 'no', title: 'The file’s own name, not sent', text: st.file.name }) : null,
                h('button', { type: 'button', class: 'link-btn', 'data-key': 'compose-file-remove', onclick: () => ((st.file = null), draw('keep')), text: 'Remove' }),
              )
            : h('span', { class: 'field__hint', text: 'or drop / paste one here' }),
          st.file
            ? h(
                'label',
                { class: 'checkline composer__random' },
                h('input', { type: 'checkbox', checked: st.randomName, 'data-key': 'compose-random', onchange: (e) => ((st.randomName = e.target.checked), draw('keep')) }),
                h('span', { text: 'Random name' }),
              )
            : null,
        ),
        h(
          'div',
          { class: 'composer__checks' },
          h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: st.strip, 'data-key': 'compose-strip', onchange: (e) => (st.strip = e.target.checked) }), h('span', { text: 'Remove location and camera data from images' })),
          info?.spoilers
            ? h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: st.spoiler, 'data-key': 'compose-spoiler', onchange: (e) => (st.spoiler = e.target.checked) }), h('span', { text: 'Spoiler the image' }))
            : null,
        ),
        h('div', { class: 'composer__captcha' }, captchaBlock()),
        st.problems.length
          ? h('ul', { class: 'composer__problems', role: 'alert', tabindex: '-1' }, st.problems.map((p) => h('li', { text: p.message })))
          : null,
        st.message ? h('p', { class: `state-line${st.busy ? '' : ' composer__msg'}`, role: 'status', text: st.message }) : null,
      ),
      h(
        'div',
        { class: 'composer__foot' },
        onSitePage
          ? h('button', { type: 'button', class: 'link-btn', 'data-key': 'compose-site', onclick: () => onSitePage(st.board, st.thread, 0), text: 'Post on the site’s page instead' })
          : null,
        h('button', { type: 'button', class: 'btn btn--primary', 'data-key': 'compose-submit', disabled: st.busy, onclick: submit }, icon('reply'), st.busy ? 'Posting…' : 'Post'),
      ),
    );
    applySize(next);
    if (el) el.replaceWith(next);
    else document.body.append(next);
    el = next;
    const ta = el.querySelector('[data-key="compose-com"]');
    if (ta) {
      ta.value = st.com;
      // the caret stays where it was, for a quote added while the form is open
      if (Number.isFinite(st.caret)) ta.setSelectionRange(Math.min(st.caret, ta.value.length), Math.min(st.caret, ta.value.length));
    }
    if (focus === 'keep' && focusKey) {
      const f = el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      f?.focus({ preventScroll: true });
      if (f && caret && typeof f.setSelectionRange === 'function') f.setSelectionRange(caret[0], caret[1]);
    }
    if (!tick) tick = setInterval(onTick, 250);
  }

  // Four times a second, so each second turns on time: the captcha's time
  // left, and a wait the site asked for, counted down live. When the wait is
  // over, the next captcha is fetched.
  function onTick() {
    const c = st?.captcha;
    if (!c || !el) return;
    if (c.state === 'ready') {
      const left = el.querySelector('[data-captcha-left]');
      const s = Math.max(0, Math.ceil((c.expires - Date.now()) / 1000));
      if (left) left.textContent = s ? `Expires in ${s} s. Slide (or ←/→), then Enter to keep a choice.` : 'Expired: get a new one.';
      return;
    }
    if (!c.until) return;
    const s = Math.max(0, Math.ceil((c.until - Date.now()) / 1000));
    const span = el.querySelector('[data-captcha-wait]');
    if (span) span.textContent = waitText(s, c.state);
    const again = el.querySelector('[data-key="compose-captcha-new"]');
    if (again && again.disabled && s === 0) again.disabled = false;
    if (st.min) drawHeadNote();
    if (s === 0 && c.state === 'wait' && !c.retried) {
      c.retried = true;
      loadCaptcha();
    }
  }

  function waitText(s, state) {
    if (s > 0) return ` ${formatLeft(s)} left.`;
    return state === 'wait' ? ' Getting a new captcha…' : '';
  }

  // The title bar of a folded form says what is going on underneath.
  function headNote() {
    const c = st.captcha;
    if (st.busy) return 'Posting…';
    if (c.state === 'loading' || c.state === 'idle') return 'Loading captcha…';
    if (c.state === 'wait' && c.until) return `Wait ${formatLeft(Math.max(0, Math.ceil((c.until - Date.now()) / 1000)))}`;
    if (C.captchaDone(c)) return 'Ready to post';
    if (c.state === 'ready') return 'Captcha to solve';
    return c.state === 'error' || c.state === 'blocked' ? 'Captcha problem' : '';
  }

  function drawHeadNote() {
    const n = el?.querySelector('[data-compose-note]');
    if (n) n.textContent = headNote();
  }

  return {
    open,
    close,
    isOpen: () => Boolean(st),
    state: () => st,
  };
}
