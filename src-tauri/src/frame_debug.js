// SPDX-License-Identifier: AGPL-3.0-only
// Only with CLOVEREYE_HELPER_DEBUG=1: inside the helper window's frames (the
// site's captcha frame, and the frames it holds), report what loads, what
// fails and what the page complains about to the top page, which prints it
// to the terminal. Reads nothing from the pages but resource names, errors
// and the visible text.
(function () {
  'use strict';
  if (window.top === window) return;
  const host = location.hostname;
  if (!/(^|\.)(4chan\.org|spur\.us|mcl\.io|cloudflare\.com)$/.test(host)) return;
  const send = (text) => {
    try {
      window.top.postMessage({ ceLog: `[${host}${location.pathname.slice(0, 40)}] ${String(text).slice(0, 400)}` }, '*');
    } catch (_) {
      /* nothing to do */
    }
  };
  addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t && t !== window && (t.src || t.href)) send('failed to load ' + (t.src || t.href));
      else if (e.message) send('page error: ' + e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || ''));
    },
    true,
  );
  addEventListener('unhandledrejection', (e) => send('unhandled rejection: ' + String(e.reason && (e.reason.stack || e.reason.message || e.reason))));
  for (const k of ['error', 'warn', 'log']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      send(`console.${k}: ` + a.map((x) => (x && x.stack) || String(x)).join(' '));
      orig(...a);
    };
  }
  try {
    new PerformanceObserver((list) => {
      for (const r of list.getEntries()) send(`resource ${r.initiatorType} ${r.name.slice(0, 160)} status=${r.responseStatus ?? '?'} bytes=${r.transferSize} ms=${Math.round(r.duration)}`);
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {
    send('no PerformanceObserver: ' + e);
  }
  send('frame opened; ua=' + navigator.userAgent);
  addEventListener('load', () => setTimeout(() => send('text: ' + ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 300)), 1500));
})();
