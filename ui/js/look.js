// Applies theme, density and text size to the document.

export function applyLook(s, root = document.documentElement) {
  root.dataset.theme = s.theme || 'system';
  root.dataset.density = s.density || 'comfortable';
  root.style.setProperty('--text-scale', String(s.textScale || 1));
}
