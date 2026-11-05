// SPDX-License-Identifier: AGPL-3.0-only
// The post helper: runs inside CloverEye's hidden helper window, on the
// site's own board pages only. It does what the site's own reply form does,
// from the site's own origin with the browser's own cookies: loads the
// site's captcha frame, and sends a post to the site's post endpoint. It
// never solves a captcha: the person does, in CloverEye's reply form.
// Results go back through the one command this window may call.
(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== 'boards.4chan.org') return;
  if (window.__ceAgent) return;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  const reply = (id, ok, data) => internals.invoke('post_agent_reply', { id: String(id), ok, data });
  const BOARD = /^[a-z0-9]{1,10}$/;

  const OPS = {
    // The site's captcha frame posts its challenge to the page that holds
    // it, as { twister: {...} }. Like the site's own script (tcaptcha.js),
    // the request carries the saved ticket, and the answer's ticket is
    // saved for next time (localStorage "4chan-tc-ticket" on this origin).
    captcha(args) {
      const board = String(args.board || '');
      const thread = Number(args.thread) || 0;
      if (!BOARD.test(board)) return Promise.reject(new Error('not a board code'));
      const TICKET = '4chan-tc-ticket';
      return new Promise((resolve, reject) => {
        // The frame sits on top of the page, with a line saying why: when
        // the site puts its human check in front of the captcha, this window
        // is shown and the person passes the check right here.
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;background:#fff;color:#111;font:16px/1.5 system-ui,sans-serif;padding:16px;display:flex;flex-direction:column;gap:12px;align-items:center';
        const note = document.createElement('p');
        note.style.cssText = 'margin:0;max-width:560px;text-align:center';
        note.textContent =
          'CloverEye is loading the site’s captcha. If the site shows a check below, complete it here; CloverEye continues by itself and this window closes.';
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:min(560px,100%);height:420px;border:1px solid #ccc;border-radius:8px;background:#fff';
        box.append(note, frame);
        const q = [`board=${board}`];
        if (thread > 0) q.push(`thread_id=${thread}`);
        let ticket = null;
        try {
          ticket = localStorage.getItem(TICKET);
        } catch (_) {
          ticket = null;
        }
        if (ticket) q.push(`ticket=${encodeURIComponent(ticket)}`);
        frame.src = `https://sys.4chan.org/captcha?${q.join('&')}`;
        // No answer after a few seconds: almost always the site's human check.
        // Show this window so the person can pass it; give them time.
        const shown = setTimeout(() => reply('show', true, ''), 4000);
        const timer = setTimeout(() => done(new Error('The captcha did not load. If the site showed a check, it was not completed in time.')), 180000);
        function onMessage(e) {
          if (e.origin !== 'https://sys.4chan.org') return;
          const d = e.data && typeof e.data === 'object' ? e.data.twister : null;
          if (!d) return;
          try {
            if (d.ticket) localStorage.setItem(TICKET, d.ticket);
            else if (d.ticket === false) localStorage.removeItem(TICKET);
          } catch (_) {
            /* no storage: the next request goes without a ticket */
          }
          done(null, d);
        }
        function done(err, data) {
          clearTimeout(timer);
          clearTimeout(shown);
          removeEventListener('message', onMessage);
          box.remove();
          if (err) reject(err);
          else resolve(data);
        }
        addEventListener('message', onMessage);
        (document.body || document.documentElement).appendChild(box);
      });
    },

    // A post, as the site's form sends it.
    async post(args) {
      const board = String(args.board || '');
      if (!BOARD.test(board)) throw new Error('not a board code');
      const form = new FormData();
      for (const [k, v] of Object.entries(args.fields || {})) form.append(k, String(v));
      if (args.file && args.file.b64) {
        const bin = atob(args.file.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        form.append('upfile', new File([bytes], String(args.file.name || 'file'), { type: String(args.file.type || 'application/octet-stream') }));
      }
      const res = await fetch(`https://sys.4chan.org/${board}/post`, { method: 'POST', body: form, credentials: 'include' });
      return { status: res.status, text: await res.text() };
    },
  };

  window.__ceAgent = {
    async run(req) {
      try {
        const op = OPS[req && req.op];
        if (!op) throw new Error('unknown request');
        reply(req.id, true, await op(req.args || {}));
      } catch (e) {
        reply(req && req.id, false, String((e && e.message) || e));
      }
    },
  };
  const ready = () => reply('ready', true, location.href);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
