// SPDX-License-Identifier: AGPL-3.0-only
// Lists the UI's English strings (the translation keys) from the source:
// string and template literals in ui/js and the Rust commands' messages,
// plus the text of ui/index.html. Template parts become {0}, {1}…
//
//   node tools/i18n-strings.mjs            → JSON list on stdout
//   node tools/i18n-strings.mjs --missing  → keys missing from each ui/i18n/*.json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const JS = readdirSync(join(root, 'ui/js'))
  .filter((f) => f.endsWith('.js') && !['i18n.js', 'look.js', 'render.js', 'hover.js'].includes(f))
  .map((f) => join(root, 'ui/js', f));
const RUST = ['src-tauri/src/main.rs', 'src-tauri/src/extra.rs', 'src-tauri/src/links.rs', 'src-tauri/src/offline.rs', 'src-tauri/src/stats.rs'].map((f) => join(root, f));

function literals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
      if (i < 2) break;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let s = '';
      let n = 0;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e;
          j += 2;
          continue;
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < src.length && depth) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          s += `{${n++}}`;
          continue;
        }
        s += src[j];
        j++;
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

const looksLikeText = (s) => {
  const bare = s.replace(/\{\d+\}/g, '').trim();
  if (bare.length < 2 || !/\p{L}{2}/u.test(bare)) return false;
  if (/^[a-z0-9_.:#[\]=>*-]+$/i.test(bare) && !/^[A-Z][a-z]+$/.test(bare)) return false; // keys, classes, selectors
  if (/^[a-z][a-zA-Z0-9]*$/.test(bare)) return false; // identifiers
  if (/(=>|\bfunction\b|\.js$|:\/\/|^data:|^#|^\.|^M\d|^<|\/>$|^[a-z-]+:\s)/.test(bare)) return false;
  if (/^(GET|POST|https?|image\/|video\/|application\/|text\/)/.test(bare)) return false;
  if (/^[\w-]+(\s[\w-]+)*$/.test(bare) && /-/.test(bare) && !/\s/.test(bare)) return false; // kebab-case
  if (/^[a-z]/.test(bare) && !/\s/.test(bare)) return false; // single lower-case words: keys
  if (/__|--|\[|\]|^\(|^\/|\.field__|, \.|^[a-z-]+(\s[a-z_-]+)+$/.test(bare) && !/\s[a-z]+\s/.test(bare.replace(/^[a-z-]+\s/, ''))) return false; // classes, selectors, paths
  if (/^(brew|sudo|dnf|apt|noopener)\b/.test(bare)) return false; // commands
  return true;
};

const keys = new Set();
for (const f of JS) for (const s of literals(readFileSync(f, 'utf8'))) if (looksLikeText(s)) keys.add(s.trim());
for (const f of RUST) {
  for (const m of readFileSync(f, 'utf8').matchAll(/Err\((?:format!\()?"([^"]+)"/g)) {
    let n = 0;
    const s = m[1].replace(/\{[^}]*\}/g, () => `{${n++}}`);
    if (looksLikeText(s) && /\s/.test(s)) keys.add(s);
  }
}
const html = readFileSync(join(root, 'ui/index.html'), 'utf8').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
for (const m of html.matchAll(/>([^<>]*\p{L}[^<>]*)</gu)) {
  const s = m[1].replace(/\s+/g, ' ').trim();
  if (s && looksLikeText(s)) keys.add(s);
}
for (const m of html.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]+)"/g)) if (looksLikeText(m[1])) keys.add(m[1]);

const list = [...keys].sort();
if (process.argv.includes('--missing')) {
  for (const f of readdirSync(join(root, 'ui/i18n')).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const t = JSON.parse(readFileSync(join(root, 'ui/i18n', f), 'utf8'));
    const miss = list.filter((k) => !(k in t));
    console.log(`${f}: ${list.length - miss.length}/${list.length}${miss.length ? `, missing: ${JSON.stringify(miss.slice(0, 20))}` : ''}`);
  }
} else {
  console.log(JSON.stringify(list, null, 1));
}
void existsSync;
