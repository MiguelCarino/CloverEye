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
export function createComposer({ bridge, getSettings, saveSettings, getBoard, onPosted, onSitePage = null }) {
  const drafts = new Map(); // "board/thread" → { com, sub, email }
  const cooldowns = new Map(); // board → time the next post may go
  let st = null; // the open form
  let el = null;
  let tick = null;

  const key = (board, thread) => `${board}/${thread || 0}`;

  function pwd(settings) {
    if (settings.post?.pwd) return settings.post.pwd;
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const made = Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
    saveSettings({ ...settings, post: { ...(settings.post || {}), pwd: made } });
    return made;
  }

  function stash() {
    if (!st) return;
    drafts.set(key(st.board, st.thread), { com: st.com, sub: st.sub, email: st.email });
  }

  function close() {
    stash();
    clearInterval(tick);
    tick = null;
    el?.remove();
    el = null;
    st = null;
  }

  async function open({ board, thread = 0, quote = 0 }) {
    const same = st && st.board === board && st.thread === thread;
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
        file: null, // { name, size, type, bytes }
        spoiler: false,
        strip: s.files?.stripMetadata !== false,
        captcha: { state: 'idle' },
        busy: false,
        problems: [],
        message: '',
        info: null,
      };
    }
    if (quote) {
      const line = `>>${quote}\n`;
      if (!st.com.includes(`>>${quote}`)) st.com = st.com && !st.com.endsWith('\n') ? `${st.com}\n${line}` : `${st.com}${line}`;
    }
    draw();
    el.querySelector('[data-key="compose-com"]')?.focus();
    const ta = el.querySelector('[data-key="compose-com"]');
    if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
    if (!same) {
      st.info = await getBoard(board).catch(() => null);
      if (st && st.board === board) draw('keep');
      loadCaptcha();
    }
  }

  async function loadCaptcha() {
    if (!st) return;
    const mine = st;
    st.captcha = { state: 'loading' };
    draw('keep');
    let data;
    try {
      data = await bridge.captcha(mine.board, mine.thread);
    } catch (e) {
      const msg = String(e?.message || e);
      data = null;
      if (st !== mine) return;
      st.captcha =
        msg === 'check-needed'
          ? { state: 'error', message: 'The site wants a quick browser check. A CloverEye window with the site opened: complete it there, then press New captcha.' }
          : { state: 'error', message: msg };
      draw('keep');
      return;
    }
    if (st !== mine) return;
    st.captcha = C.captchaState(data);
    draw('keep');
    if (st.captcha.state === 'ready') el?.querySelector('[data-key="compose-slider"]')?.focus({ preventScroll: true });
  }

  async function pickFile(file) {
    if (!st || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    st.file = { name: file.name || 'pasted.png', size: bytes.length, type: file.type || '', bytes };
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
      file = { name: mine.file.name, type: mine.file.type, b64: C.toBase64(bytes) };
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
        'p',
        { class: 'state-line', role: 'status' },
        icon('refresh'),
        'Loading the site’s captcha… If a CloverEye window with the site’s check opens, complete the check there; this form continues by itself.',
      );
    }
    if (c.state === 'none') return h('p', { class: 'state-line', role: 'status' }, icon('check'), 'No captcha needed this time.');
    const again = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-captcha-new', onclick: loadCaptcha }, icon('refresh'), 'New captcha');
    if (c.state !== 'ready') {
      const left = c.until ? Math.max(0, Math.ceil((c.until - Date.now()) / 1000)) : 0;
      return h(
        'div',
        { class: `callout ${c.state === 'wait' ? 'callout--warn' : 'callout--danger'}`, role: 'status' },
        icon('info'),
        h('div', {}, c.message, left ? ` (${left} s)` : '', ' ', again),
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
        { class: 'captcha__stage' },
        shown ? h('img', { class: 'captcha__img', src: shown, alt: c.current === 0 ? 'The captcha’s question' : `Choice ${c.current} of ${task.items.length}` }) : h('span', { class: 'field__hint', text: 'Slide to see the choices.' }),
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
      { class: 'composer', role: 'dialog', 'aria-label': isThread ? `New thread on /${st.board}/` : `Reply to No. ${st.thread}`, 'data-key': 'composer' },
      h(
        'div',
        { class: 'composer__head' },
        h('strong', { text: isThread ? `New thread on /${st.board}/` : `Reply to /${st.board}/ No. ${st.thread}` }),
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
          field('Options', h('input', { class: 'input', value: st.email, placeholder: 'sage', maxlength: '100', 'data-key': 'compose-email', oninput: (e) => (st.email = e.target.value) })),
        ),
        isThread || info?.require_subject
          ? field('Subject', h('input', { class: 'input', value: st.sub, maxlength: '100', 'data-key': 'compose-sub', oninput: (e) => (st.sub = e.target.value) }))
          : null,
        field(
          'Comment',
          h('textarea', {
            class: 'input composer__com',
            rows: '6',
            'data-key': 'compose-com',
            oninput: (e) => {
              st.com = e.target.value;
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
                `${st.file.name} · ${(st.file.size / 1024 / 1024).toFixed(2)} MB${fileLimit ? ` of ${(fileLimit / 1024 / 1024).toFixed(0)} MB` : ''}`,
                h('button', { type: 'button', class: 'link-btn', 'data-key': 'compose-file-remove', onclick: () => ((st.file = null), draw('keep')), text: 'Remove' }),
              )
            : h('span', { class: 'field__hint', text: 'or drop / paste one here' }),
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
    if (el) el.replaceWith(next);
    else document.body.append(next);
    el = next;
    const ta = el.querySelector('[data-key="compose-com"]');
    if (ta) ta.value = st.com;
    if (focus === 'keep' && focusKey) {
      const f = el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      f?.focus({ preventScroll: true });
      if (f && caret && typeof f.setSelectionRange === 'function') f.setSelectionRange(caret[0], caret[1]);
    }
    if (!tick) {
      tick = setInterval(() => {
        const left = el?.querySelector('[data-captcha-left]');
        if (left && st?.captcha?.state === 'ready') {
          const s = Math.max(0, Math.ceil((st.captcha.expires - Date.now()) / 1000));
          left.textContent = s ? `Expires in ${s} s. Slide (or ←/→), then Enter to keep a choice.` : 'Expired: get a new one.';
        }
      }, 1000);
    }
  }

  return {
    open,
    close,
    isOpen: () => Boolean(st),
    state: () => st,
  };
}
