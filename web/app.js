// SPDX-License-Identifier: AGPL-3.0-only
// clover.carino.systems: dialogs, the Fedora version switch and the copy
// buttons. No network requests: every link and command is written in the page.
(() => {
  'use strict';

  // Chips and the Linux button open their dialog; focus goes back on close.
  for (const opener of document.querySelectorAll('[data-dialog]')) {
    opener.addEventListener('click', (e) => {
      const d = document.getElementById(opener.dataset.dialog);
      if (!d || typeof d.showModal !== 'function') return; // no <dialog>: follow the link
      e.preventDefault();
      d.showModal();
      d.addEventListener('close', () => opener.focus(), { once: true });
    });
  }
  // A click on the backdrop closes a dialog.
  for (const d of document.querySelectorAll('dialog.modal')) {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  }

  // Fedora 44 / 45: the same command with the matching package.
  const VERSION = '0.1.0';
  const cmd = document.getElementById('dnfCmd');
  const radios = [...document.querySelectorAll('[data-fedora]')];
  function pick(btn) {
    for (const r of radios) r.setAttribute('aria-checked', String(r === btn));
    cmd.textContent = `sudo dnf install https://github.com/MiguelCarino/CloverEye/releases/download/v${VERSION}/clovereye-${VERSION}-1.${btn.dataset.fedora}.x86_64.rpm`;
  }
  radios.forEach((r, i) => {
    r.addEventListener('click', () => pick(r));
    r.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = radios[(i + (e.key === 'ArrowRight' ? 1 : radios.length - 1)) % radios.length];
      pick(next);
      next.focus();
    });
  });

  // Copy: the command text only, never the prompt.
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = document.getElementById(btn.dataset.copy)?.textContent || '';
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
      btn.textContent = ok ? 'Copied' : 'Select it';
      btn.classList.toggle('done', ok);
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('done');
      }, 1600);
    });
  }
})();
