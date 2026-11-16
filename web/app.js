// SPDX-License-Identifier: AGPL-3.0-only
// clover.carino.systems: dialogs, the download choices (architecture, Fedora
// version), the copy buttons, and the boards drifting behind the hero. No
// network requests: every link and command is written in the page.
(() => {
  'use strict';

  // Chips and the download buttons open their dialog; focus goes back on close.
  for (const opener of document.querySelectorAll('[data-dialog]')) {
    opener.addEventListener('click', (e) => {
      const d = document.getElementById(opener.dataset.dialog);
      if (!d || typeof d.showModal !== 'function') return; // no <dialog>: follow the link
      e.preventDefault();
      d.showModal();
      d.addEventListener('close', () => opener.focus(), { once: true });
    });
  }
  // Closing plays the dialog's way out first (style.css .modal.is-closing):
  // the ✕, Esc and a click on the backdrop all go through here.
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function shut(d) {
    if (!d.open || d.classList.contains('is-closing')) return;
    if (still()) return d.close();
    d.classList.add('is-closing');
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      d.classList.remove('is-closing');
      d.close();
    };
    d.addEventListener('animationend', end, { once: true });
    setTimeout(end, 300); // a page in the background may not animate
  }
  for (const d of document.querySelectorAll('dialog.modal')) {
    d.addEventListener('click', (e) => {
      if (e.target === d) shut(d);
    });
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      shut(d);
    });
    for (const x of d.querySelectorAll('.modal-x')) {
      x.addEventListener('click', (e) => {
        e.preventDefault();
        shut(d);
      });
    }
  }

  // Downloads: each dialog ([data-pkg]) asks for the platform, then the
  // architecture, and shows the command for a terminal and the package
  // itself. The page holds the first choice for browsers without scripts.
  const V = '0.1.4';
  const R = `https://github.com/MiguelCarino/CloverEye/releases/download/v${V}`;
  const PKG = {
    linux: {
      platforms: [['fc44', 'Fedora 44'], ['fc45', 'Fedora 45'], ['deb', 'Debian / Ubuntu'], ['appimage', 'Generic']],
      archs: [['x86_64', 'x86_64'], ['aarch64', 'ARM (aarch64)']],
      only: { appimage: ['x86_64'] }, // no ARM AppImage yet
      build(p, a) {
        if (p === 'deb') {
          const deb = a === 'aarch64' ? 'arm64' : 'amd64';
          const f = `clovereye_${V}_${deb}.deb`;
          return { cmd: `curl -LO ${R}/${f}\nsudo apt install ./${f}`, file: f, label: 'Download the .deb', fmt: `Ubuntu 22.04+ · Debian 12+ · ${deb}`, note: 'Open it with your software centre, or apt install it.' };
        }
        if (p === 'appimage') {
          const f = `CloverEye-${V}-x86_64.AppImage`;
          return { cmd: `curl -LO ${R}/${f}\nchmod +x ${f}\n./${f}`, file: f, label: 'Download the AppImage', fmt: 'any Linux · x86_64 · 134 MB', note: 'Nothing to install: make it executable and run it. Needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 and later). Posting from the AppImage does not work yet.' };
        }
        const f = `clovereye-${V}-1.${p}.${a}.rpm`;
        return { cmd: `sudo dnf install ${R}/${f}`, file: f, label: 'Download the .rpm', fmt: `${p === 'fc44' ? 'Fedora 44' : 'Fedora 45'} · ${a}`, note: 'dnf downloads it from the release and installs what it needs. For Clip (coming), add Fedora’s ffmpeg-free or RPM Fusion’s ffmpeg.' };
      },
    },
    windows: {
      platforms: [['exe', 'Installer (.exe)'], ['msi', 'MSI']],
      archs: [['x64', 'x64'], ['arm64', 'ARM64']],
      only: { msi: ['x64'] }, // the MSI is built for x64 only
      build(p, a) {
        const f = p === 'msi' ? `CloverEye-${V}-x64.msi` : `CloverEye-${V}-${a}-setup.exe`;
        const run = p === 'msi' ? `msiexec /i ${f}` : `.\\${f}`;
        return { cmd: `curl.exe -LO ${R}/${f}\n${run}`, file: f, label: p === 'msi' ? 'Download the MSI' : 'Download the installer', fmt: `Windows 10 · 11 · ${a}`, note: p === 'msi' ? 'For managed PCs and silent installs.' : 'Adds WebView2 if the PC lacks it. Not sure which? Settings → System → About → System type says x64 or ARM-based.' };
      },
    },
    mac: {
      platforms: [['dmg', 'macOS 10.13+']],
      archs: [['aarch64', 'Apple silicon'], ['x86_64', 'Intel']],
      only: {},
      build(p, a) {
        const f = `CloverEye-${V}-${a}.dmg`;
        return {
          cmd: `curl -LO ${R}/${f}\nhdiutil attach -nobrowse -mountpoint /tmp/clovereye ${f}\ncp -R /tmp/clovereye/CloverEye.app /Applications/\nhdiutil detach /tmp/clovereye\nxattr -dr com.apple.quarantine /Applications/CloverEye.app`,
          file: f,
          label: 'Download the .dmg',
          fmt: `${a === 'aarch64' ? 'Apple silicon' : 'Intel'} · open it, drag CloverEye to Applications`,
          note: 'Not sure which? Apple menu → About This Mac: “Chip: Apple M…” is Apple silicon, “Processor: Intel” is Intel.',
        };
      },
    },
  };

  const boxes = {}; // dialog key → { pick(platform, arch) }, for the detection below
  for (const box of document.querySelectorAll('[data-pkg]')) {
    const pkg = PKG[box.dataset.pkg];
    if (!pkg) continue;
    const segs = { platform: box.querySelector('.seg[data-var="platform"]'), arch: box.querySelector('.seg[data-var="arch"]') };
    const chosen = (k) => segs[k].querySelector('[aria-checked="true"]')?.dataset.val;
    const set = (k, val) => {
      for (const r of segs[k].querySelectorAll('[role="radio"]')) {
        r.setAttribute('aria-checked', String(r.dataset.val === val));
        r.tabIndex = r.dataset.val === val ? 0 : -1;
      }
    };
    const update = () => {
      const p = chosen('platform');
      const allowed = pkg.only[p] || pkg.archs.map(([v]) => v);
      // an architecture this platform does not have: greyed out, and left
      for (const r of segs.arch.querySelectorAll('[role="radio"]')) {
        const ok = allowed.includes(r.dataset.val);
        r.disabled = !ok;
        r.title = ok ? '' : 'Not made for this platform yet';
      }
      if (!allowed.includes(chosen('arch'))) set('arch', allowed[0]);
      const b = pkg.build(p, chosen('arch'));
      box.querySelector('[data-cmd]').textContent = b.cmd;
      const link = box.querySelector('[data-file]');
      link.href = `${R}/${b.file}`;
      link.querySelector('b').textContent = b.label;
      link.querySelector('.fmt').textContent = `${b.file} · ${b.fmt}`;
      box.querySelector('[data-note]').textContent = b.note;
    };
    for (const k of ['platform', 'arch']) {
      const radios = () => [...segs[k].querySelectorAll('[role="radio"]')].filter((r) => !r.disabled);
      for (const r of segs[k].querySelectorAll('[role="radio"]')) {
        r.tabIndex = r.getAttribute('aria-checked') === 'true' ? 0 : -1;
        r.addEventListener('click', () => {
          if (r.disabled) return;
          set(k, r.dataset.val);
          update();
        });
        r.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const list = radios();
          const i = list.indexOf(r);
          const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
          set(k, next.dataset.val);
          update();
          next.focus();
        });
      }
    }
    update();
    boxes[box.dataset.pkg] = {
      pick(platform, arch) {
        if (platform && segs.platform.querySelector(`[data-val="${platform}"]`)) set('platform', platform);
        update();
        const btn = arch && segs.arch.querySelector(`[data-val="${arch}"]`);
        if (btn && !btn.disabled) set('arch', arch);
        update();
      },
    };
  }

  // This computer: its system (and Linux distribution) and architecture,
  // from what the browser tells; nothing leaves the page. Its download
  // button gets the highlight, and its dialog starts on the right choices.
  // Phones and tablets get no highlight: the app is for desktops.
  (async () => {
    const ua = navigator.userAgent || '';
    const uad = navigator.userAgentData;
    const plat = (uad?.platform || navigator.platform || '').toLowerCase();
    if (/android|iphone|ipad|ipod/i.test(ua) || uad?.mobile || (/mac/.test(plat) && navigator.maxTouchPoints > 1)) return;
    const os = /win/.test(plat) || /Windows/.test(ua) ? 'windows' : /mac/.test(plat) || /Mac OS X/.test(ua) ? 'mac' : /linux|x11|bsd/.test(plat) || /Linux|X11/.test(ua) ? 'linux' : null;
    if (!os) return;
    // the architecture: Chromium says it outright; others in their user agent
    let arch = null;
    try {
      const hi = await uad?.getHighEntropyValues?.(['architecture', 'bitness']);
      if (hi?.architecture) arch = /arm/i.test(hi.architecture) ? 'arm' : 'x86';
    } catch {
      /* not given */
    }
    if (!arch) {
      if (/aarch64|arm64|armv8|ARM;/i.test(ua) || /aarch64|arm/.test(plat)) arch = 'arm';
      else if (/x86_64|x64|Win64|WOW64|amd64|i686/i.test(ua + plat)) arch = 'x86';
    }
    // every Mac's browser says "Intel": its graphics name the chip instead
    if (os === 'mac' && arch !== 'arm') {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        const gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) || '');
        if (/apple m\d|apple gpu/i.test(gpu)) arch = 'arm';
        else if (/intel|amd|radeon|nvidia/i.test(gpu)) arch = 'x86';
      } catch {
        /* no graphics to ask */
      }
    }
    const distro = /Fedora/i.test(ua) ? 'fc44' : /Ubuntu|Debian|Mint|Pop!_OS/i.test(ua) ? 'deb' : null;

    const key = { linux: 'linuxDialog', windows: 'windowsDialog', mac: 'macDialog' }[os];
    for (const b of document.querySelectorAll('.downloads .dl-btn')) b.classList.toggle('recommended', b.dataset.dialog === key);
    const btn = document.querySelector(`.downloads [data-dialog="${key}"]`);
    if (btn && !btn.querySelector('.rec')) {
      const rec = document.createElement('span');
      rec.className = 'rec';
      rec.textContent = 'For this computer';
      btn.prepend(rec);
    }
    const archOf = {
      linux: arch === 'arm' ? 'aarch64' : 'x86_64',
      windows: arch === 'arm' ? 'arm64' : 'x64',
      mac: arch === 'x86' ? 'x86_64' : 'aarch64',
    }[os];
    boxes[{ windows: 'windows', mac: 'mac', linux: 'linux' }[os]]?.pick(os === 'linux' ? distro : null, arch ? archOf : null);
  })();

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

  // Behind the hero: board cards drifting up, like the app's own board list.
  // Worksafe boards only. Decorative (aria-hidden); still with reduced motion.
  const sky = document.querySelector('.board-sky');
  if (sky) {
    const BOARDS = [
      ['g', 'Technology'], ['diy', 'Do It Yourself'], ['ck', 'Food & Cooking'], ['sci', 'Science & Math'], ['tv', 'Television & Film'],
      ['v', 'Video Games'], ['a', 'Anime & Manga'], ['lit', 'Literature'], ['mu', 'Music'], ['fit', 'Fitness'], ['out', 'Outdoors'],
      ['an', 'Animals & Nature'], ['tg', 'Traditional Games'], ['p', 'Photography'], ['wg', 'Wallpapers'], ['3', '3DCG'],
      ['o', 'Auto'], ['n', 'Transportation'], ['his', 'History & Humanities'], ['gd', 'Graphic Design'], ['wsg', 'Worksafe GIF'],
      ['trv', 'Travel'], ['toy', 'Toys'], ['po', 'Papercraft & Origami'], ['jp', 'Otaku Culture'], ['sp', 'Sports'], ['int', 'International'],
    ];
    // the same board gets the same colour every visit
    const hue = (code) => [...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lanes = 9;
    BOARDS.forEach(([code, title], i) => {
      const card = document.createElement('span');
      card.className = 'sky-card';
      card.innerHTML = '<b></b><span></span>';
      card.querySelector('b').textContent = `/${code}/`;
      card.querySelector('span').textContent = title;
      const lane = i % lanes;
      const dur = 38 + ((i * 7) % 17);
      card.style.setProperty('--hue', String(hue(code)));
      card.style.setProperty('--x', `${(lane + 0.15 + ((i * 37) % 70) / 100) * (100 / lanes)}%`);
      card.style.setProperty('--dur', `${dur}s`);
      // spread over the whole climb from the start, not all at the bottom
      card.style.setProperty('--delay', `${-((i * 13) % dur)}s`);
      card.style.setProperty('--tilt', `${((i * 5) % 9) - 4}deg`);
      card.style.setProperty('--scale', String(0.8 + ((i * 3) % 5) / 10));
      if (still) card.style.setProperty('--y', `${(i * 29) % 100}%`);
      sky.append(card);
    });
  }
})();
