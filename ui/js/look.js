// Applies theme, density, text size, hover and quote previews, revealed
// spoilers and language to the document.

import { setLanguage } from './i18n.js';

let langSetting = null;

export function applyLook(s, root = document.documentElement) {
  root.dataset.theme = s.theme || 'system';
  root.dataset.density = s.density || 'comfortable';
  root.dataset.hoverPreview = s.ui?.hoverPreview === false ? 'off' : 'on';
  root.dataset.quotePreview = s.quotes?.preview === false ? 'off' : 'on';
  // spoiler text shown (still marked): Settings → Posts
  root.dataset.revealSpoilers = s.display?.revealSpoilers ? 'on' : 'off';
  root.style.setProperty('--text-scale', String(s.textScale || 1));
  if (root === document.documentElement && (s.lang || 'system') !== langSetting) {
    langSetting = s.lang || 'system';
    return setLanguage(langSetting);
  }
  return Promise.resolve();
}
