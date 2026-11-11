// SPDX-License-Identifier: AGPL-3.0-only
// The post helper: runs inside CloverEye's hidden helper window, on the
// site's own pages only. It does what the site's own reply form does, from
// the site's own origin with the browser's own cookies: loads the site's
// captcha, and sends a post to the site's post endpoint. It never solves a
// captcha or a check: the person does, in CloverEye's reply form (the
// captcha) or in this window (the site's human check).
// Results go back through the one command this window may call.
(function () {
  'use strict';
  if (location.protocol !== 'https:' || window.top !== window) return;
  const HOST = location.hostname;
  if (HOST !== 'boards.4chan.org' && HOST !== 'sys.4chan.org') return;
  if (window.__ceAgent) return;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  const reply = (id, ok, data) => internals.invoke('post_agent_reply', { id: String(id), ok, data });
  const log = (text) => reply('log', true, String(text));
  const BOARD = /^[a-z0-9]{1,10}$/;
  const TICKET = '4chan-tc-ticket';
  const SYS = 'https://sys.4chan.org';
  // How long the captcha frame may stay silent before the captcha page is
  // opened as the window's own page instead (where the site's human check
  // works the way it is meant to).
  const FRAME_WAIT_MS = window.__ceCaptchaPage ? 0 : 3500;

  const getTicket = () => {
    try {
      return localStorage.getItem(TICKET);
    } catch (_) {
      return null;
    }
  };
  const putTicket = (t) => {
    try {
      if (t) localStorage.setItem(TICKET, t);
      else if (t === false) localStorage.removeItem(TICKET);
    } catch (_) {
      /* no storage: the next request goes without a ticket */
    }
  };
  const captchaUrl = (board, thread) => {
    const q = [`board=${board}`];
    if (thread > 0) q.push(`thread_id=${thread}`);
    const ticket = getTicket();
    if (ticket) q.push(`ticket=${encodeURIComponent(ticket)}`);
    return `${SYS}/captcha?${q.join('&')}`;
  };

  // ---------------------------------------------------------- sys.4chan.org
  // The captcha page as the window's own page. It may first be the site's
  // human check; the window is shown for the person to pass it. The captcha
  // page hands its challenge to its parent (itself, here) with postMessage,
  // which is caught, sent to CloverEye, and the window goes back to the
  // board page with the new ticket.
  if (HOST === 'sys.4chan.org') {
    if (!location.pathname.startsWith('/captcha')) return;
    const hash = new URLSearchParams(location.hash.slice(1));
    let req = null;
    try {
      if (hash.get('ce')) sessionStorage.setItem('ce-req', JSON.stringify({ id: hash.get('ce'), board: hash.get('b') || '' }));
      req = JSON.parse(sessionStorage.getItem('ce-req') || 'null');
    } catch (_) {
      req = hash.get('ce') ? { id: hash.get('ce'), board: hash.get('b') || '' } : null;
    }
    if (!req || !req.id || !BOARD.test(req.board)) return;
    let sent = false;
    // A newer request while this page waits on the check (the person pressed
    // New captcha, say): this page answers that one instead. A post has to
    // wait for the captcha.
    window.__ceAgent = {
      run(r) {
        if (r && r.op === 'captcha' && !sent) {
          if (req.id !== String(r.id)) reply(req.id, false, 'replaced by a newer captcha request');
          req = { id: String(r.id), board: req.board };
          try {
            sessionStorage.setItem('ce-req', JSON.stringify(req));
          } catch (_) {
            /* the hash still carries the first one */
          }
          reply('show', true, '');
        } else {
          reply(r && r.id, false, 'Complete the site’s check in the CloverEye window first, then post.');
        }
      },
    };
    const back = (ticket) => {
      const t = ticket ? encodeURIComponent(ticket) : ticket === false ? '-' : '';
      location.replace(`https://boards.4chan.org/${req.board}/${t ? `#ce-ticket=${t}` : ''}`);
    };
    const take = (data) => {
      const d = data && typeof data === 'object' ? data.twister : null;
      if (!d || sent) return;
      sent = true;
      try {
        sessionStorage.removeItem('ce-req');
      } catch (_) {
        /* gone with the tab anyway */
      }
      log('captcha arrived (own page): ' + Object.keys(d).join(','));
      // Leave only once CloverEye has the answer: navigating away cuts off
      // a message still on its way.
      const leave = () => back(d.ticket);
      Promise.resolve(reply(req.id, true, d)).then(leave, leave);
    };
    // Top-level, the page's parent is itself: catch the hand-over directly.
    const post = window.postMessage;
    window.postMessage = function (msg, ...rest) {
      take(msg);
      return post.call(this, msg, ...rest);
    };
    addEventListener('message', (e) => take(e.data));
    const check = () => {
      if (sent) return;
      // Some answers come as plain JSON rather than a page.
      const text = (document.body && document.body.innerText) || '';
      if (/^\s*\{/.test(text)) {
        try {
          const d = JSON.parse(text);
          if (d && typeof d === 'object' && ('challenge' in d || 'tasks' in d || 'pcd' in d || 'error' in d)) return take({ twister: d });
        } catch (_) {
          /* not JSON after all */
        }
      }
      log('captcha page is waiting (the site check?): ' + document.title);
      reply('show', true, '');
      const bar = document.createElement('div');
      bar.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#1d1d24;color:#f3f3f6;font:14px/1.45 system-ui,sans-serif;padding:10px 16px;text-align:center';
      bar.textContent = 'CloverEye: complete the site’s check above. The captcha then appears in CloverEye’s reply form and this window closes by itself.';
      (document.body || document.documentElement).appendChild(bar);
    };
    const later = () => setTimeout(check, 1500);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later, { once: true });
    else later();
    log('captcha page opened: ' + location.pathname);
    if (window.__ceDebug) {
      // what the page loads, what fails, and what it complains about
      addEventListener(
        'error',
        (e) => {
          const t = e.target;
          if (t && t !== window && (t.src || t.href)) log('debug: failed to load ' + (t.src || t.href));
          else if (e.message) log('debug: page error: ' + e.message);
        },
        true,
      );
      addEventListener('unhandledrejection', (e) => log('debug: unhandled rejection: ' + String(e.reason && (e.reason.message || e.reason))));
      const ce = console.error.bind(console);
      console.error = (...a) => {
        log('debug: console.error: ' + a.map(String).join(' ').slice(0, 300));
        ce(...a);
      };
      const cw = console.warn.bind(console);
      console.warn = (...a) => {
        log('debug: console.warn: ' + a.map(String).join(' ').slice(0, 300));
        cw(...a);
      };
      try {
        new PerformanceObserver((list) => {
          for (const r of list.getEntries()) {
            log(`debug: resource ${r.initiatorType} ${r.name.slice(0, 160)} status=${r.responseStatus ?? '?'} bytes=${r.transferSize} ms=${Math.round(r.duration)}`);
          }
        }).observe({ type: 'resource', buffered: true });
      } catch (e) {
        log('debug: no PerformanceObserver: ' + e);
      }
      log('debug: ua=' + navigator.userAgent + ' webdriver=' + navigator.webdriver + ' wasm=' + (typeof WebAssembly) + ' subtle=' + Boolean(crypto && crypto.subtle));
      setTimeout(() => log('debug: page text: ' + ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 400)), 6000);
    }
    reply('waiting', true, '');
    return;
  }

  // ------------------------------------------------------- boards.4chan.org
  // Debug only: the frames' reports (frame_debug.js) go to the terminal.
  if (window.__ceDebug) addEventListener('message', (e) => e.data && typeof e.data.ceLog === 'string' && log('frame: ' + e.data.ceLog));

  // A ticket brought back from the captcha page.
  if (location.hash.startsWith('#ce-ticket=')) {
    const t = decodeURIComponent(location.hash.slice('#ce-ticket='.length));
    putTicket(t === '-' ? false : t);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let current = null; // ends the captcha request in flight, if any

  const OPS = {
    // The site's captcha frame posts its challenge to the page that holds
    // it, as { twister: {...} }. Like the site's own script (tcaptcha.js),
    // the request carries the saved ticket, and the answer's ticket is saved
    // for next time. A silent frame is almost always the site's human
    // check: the captcha page is then opened as this window's own page.
    captcha(args, id) {
      const board = String(args.board || '');
      const thread = Number(args.thread) || 0;
      if (!BOARD.test(board)) return Promise.reject(new Error('not a board code'));
      // One captcha at a time: a newer request replaces an older one.
      if (current) current('replaced by a newer captcha request');
      return new Promise((resolve, reject) => {
        current = (why) => {
          clearTimeout(silent);
          removeEventListener('message', onMessage);
          frame.remove();
          current = null;
          reject(new Error(why));
        };
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0';
        frame.addEventListener('load', () => log('captcha frame loaded'));
        frame.src = captchaUrl(board, thread);
        // Opens the captcha page as this window's own page; it answers this
        // request from there.
        const ownPage = (why) => {
          clearTimeout(silent);
          removeEventListener('message', onMessage);
          current = null;
          const go = () => location.assign(`${frame.src}#ce=${encodeURIComponent(id)}&b=${board}`);
          Promise.resolve(log(why)).then(go, go);
        };
        const silent = setTimeout(() => ownPage('captcha frame silent: opening the captcha page itself'), FRAME_WAIT_MS);
        function onMessage(e) {
          if (e.origin !== SYS) return;
          const d = e.data && typeof e.data === 'object' ? e.data.twister : null;
          if (!d) return;
          // An error ("Please unblock spur.us and mcl.io", say) goes to the
          // reply form as it is. Opening the captcha page itself does not get
          // past it: there the site's abuse check fails the same way, and
          // every retry is one more request the check counts.
          if (d.error) log('captcha frame answered an error: ' + String(d.error).slice(0, 120));
          clearTimeout(silent);
          removeEventListener('message', onMessage);
          frame.remove();
          current = null;
          putTicket(d.ticket);
          log('captcha arrived (frame): ' + Object.keys(d).join(','));
          resolve(d);
        }
        addEventListener('message', onMessage);
        (document.body || document.documentElement).appendChild(frame);
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
      const res = await fetch(`${SYS}/${board}/post`, { method: 'POST', body: form, credentials: 'include' });
      const text = await res.text();
      log(`post answered ${res.status}`);
      if (res.status === 403 && /challenge-platform|cf-turnstile|Just a moment/i.test(text)) {
        throw new Error('The site wants its human check again. Get a new captcha (the check comes up), then post.');
      }
      return { status: res.status, text };
    },
  };

  window.__ceAgent = {
    async run(req) {
      try {
        const op = OPS[req && req.op];
        if (!op) throw new Error('unknown request');
        reply(req.id, true, await op(req.args || {}, req.id));
      } catch (e) {
        reply(req && req.id, false, String((e && e.message) || e));
      }
    },
  };
  const ready = () => {
    log('page ready: ' + location.pathname);
    if (window.__ceDebug) {
      const has = (name) => {
        try {
          return typeof window[name] !== 'undefined';
        } catch (_) {
          return false;
        }
      };
      const feats = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebAssembly', 'Worker', 'SharedArrayBuffer', 'OffscreenCanvas', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'AudioContext', 'OfflineAudioContext', 'MediaSource', 'IntersectionObserver', 'BroadcastChannel', 'PublicKeyCredential', 'Notification', 'indexedDB', 'caches'];
      log('debug: features: ' + feats.map((f) => f + '=' + (has(f) ? 'yes' : 'NO')).join(' '));
      let gl = 'none';
      try {
        const c = document.createElement('canvas').getContext('webgl');
        gl = c ? String(c.getParameter(c.VERSION)) : 'none';
      } catch (e) {
        gl = 'error ' + e;
      }
      log('debug: webgl=' + gl + ' cores=' + navigator.hardwareConcurrency + ' mem=' + navigator.deviceMemory + ' langs=' + navigator.languages + ' platform=' + navigator.platform + ' cookies=' + navigator.cookieEnabled + ' dnt=' + navigator.doNotTrack);
    }
    reply('ready', true, location.href);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
