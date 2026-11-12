// Languages: the UI in English, Spanish, Portuguese (Brazil), Japanese and
// Russian. The English text IS the key
// (ui/i18n/<code>.json), so anything without an entry stays English.
//
// The UI is drawn by many small renderers, so translation happens on the
// drawn page: text nodes and the aria-label, aria-description, title, placeholder and alt
// attributes are looked up as they appear (a MutationObserver), and a
// language change redraws nothing: every translated node keeps its English
// original and is translated again. Keys may hold {0}, {1}… for parts that
// vary (numbers, board codes, names): "Reply to /{0}/ No. {1}".
//
// What comes from the site (posts, names, titles, file names) is never
// translated: such parts carry translate="no" and are skipped with
// everything inside them.

export const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ja', name: '日本語' },
  { code: 'ru', name: 'Русский' },
];

const CODES = new Set(LANGS.map((l) => l.code));
const ATTRS = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

let lang = 'en';
let exact = new Map(); // English → translation
let patterns = []; // [{ re, out }] for keys with {n}
const cache = new Map();
const original = new WeakMap(); // text node → English
const shown = new WeakMap(); // text node → what we put there
const originalAttr = new WeakMap(); // element → { attr: English }
let observer = null;

/** "system", or a code, to the language used. */
export function resolveLang(setting, languages = globalThis.navigator?.languages || []) {
  if (CODES.has(setting)) return setting;
  for (const l of languages) {
    const s = String(l).toLowerCase();
    if (s.startsWith('pt')) return 'pt-BR';
    for (const c of ['es', 'ja', 'ru', 'en']) if (s === c || s.startsWith(`${c}-`)) return c;
  }
  return 'en';
}

export const currentLang = () => lang;

/** Builds the lookup from a { English: translation } table. */
export function compile(table) {
  exact = new Map();
  patterns = [];
  cache.clear();
  for (const [k, v] of Object.entries(table || {})) {
    if (typeof v !== 'string' || !v) continue;
    if (/\{\d+\}/.test(k)) {
      const src = k
        .split(/(\{\d+\})/)
        .map((part) => (/^\{\d+\}$/.test(part) ? `(?<p${part.slice(1, -1)}>.+?)` : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/[{}]/g, '\\$&')))
        .join('');
      patterns.push({ re: new RegExp(`^${src}$`, 's'), out: v, weight: k.replace(/\{\d+\}/g, '').length });
    } else {
      exact.set(k, v);
    }
  }
  // the most specific pattern first
  patterns.sort((a, b) => b.weight - a.weight);
}

/** One string in the current language (English when there is no entry). */
export function tr(text) {
  if (lang === 'en' || typeof text !== 'string') return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m[2];
  if (!core || !/\p{L}/u.test(core)) return text;
  if (cache.has(core)) return m[1] + cache.get(core) + m[3];
  let out = exact.get(core);
  if (out === undefined) {
    for (const p of patterns) {
      const hit = p.re.exec(core);
      if (hit) {
        out = p.out.replace(/\{(\d+)\}/g, (_, n) => {
          const v = hit.groups?.[`p${n}`];
          return v === undefined ? '' : tr(v); // a part may itself be a known phrase
        });
        break;
      }
    }
  }
  if (out === undefined) out = core;
  cache.set(core, out);
  return m[1] + out + m[3];
}

/** A pattern string with its parts filled in, then translated: t('Saved: {0}', path). */
export function t(key, ...args) {
  const filled = key.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? ''));
  return tr(filled);
}

function skipped(el) {
  return !el || el.closest?.('[translate="no"]') || SKIP_TAGS.has(el.tagName);
}

function doText(node) {
  const el = node.parentElement;
  if (skipped(el)) return;
  const current = node.data;
  // new text from the page (not what we wrote last time) is the English
  if (shown.get(node) !== current) original.set(node, current);
  const en = original.get(node) ?? current;
  const next = tr(en);
  shown.set(node, next);
  if (next !== current) node.data = next;
}

function doAttrs(el) {
  if (skipped(el)) return;
  let orig = originalAttr.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const v = el.getAttribute(a);
    if (!orig) originalAttr.set(el, (orig = {}));
    // a value we did not write is new English from the page
    if (!orig[a] || orig[a].out !== v) orig[a] = { en: v, out: v };
    const next = tr(orig[a].en);
    orig[a].out = next;
    if (next !== v) el.setAttribute(a, next);
  }
}

/** Translates everything under `root` (the whole page by default). */
export function translateTree(root = document.body) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) return doText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (skipped(root)) return;
  doAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n.getAttribute('translate') === 'no' || SKIP_TAGS.has(n.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n);
    else doAttrs(n);
  }
}

function watch() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') for (const n of m.addedNodes) translateTree(n);
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/**
 * Sets the language ("system" or a code): loads its table, translates the
 * page and keeps translating what is drawn after. English needs no table.
 */
export async function setLanguage(setting, { load = (code) => fetch(`i18n/${code}.json`).then((r) => (r.ok ? r.json() : {})) } = {}) {
  const code = resolveLang(setting);
  let table = {};
  if (code !== 'en') {
    try {
      table = await load(code);
    } catch (_) {
      table = {};
    }
  }
  lang = code;
  compile(table);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code;
    translateTree(document.body);
    watch();
  }
  return code;
}
