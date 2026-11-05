// Applies theme, density, text size and hover preview to the document.

export function applyLook(s, root = document.documentElement) {
  root.dataset.theme = s.theme || 'system';
  root.dataset.density = s.density || 'comfortable';
  root.dataset.hoverPreview = s.ui?.hoverPreview === false ? 'off' : 'on';
  root.style.setProperty('--text-scale', String(s.textScale || 1));
}
