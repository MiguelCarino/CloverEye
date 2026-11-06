// Languages: the translator (ui/js/i18n.js), the tables (ui/i18n/*.json)
// and the version shown in Settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, tr, t, resolveLang, LANGS } from '../ui/js/i18n.js';
import { LANG_SETTINGS, normalizeSettings } from '../ui/js/setup-model.js';
import { VERSION } from '../ui/js/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');

test('the translator: exact strings, patterns, parts that are phrases, spaces kept', async () => {
  const mod = await import('../ui/js/i18n.js');
  // switch to a non-English language without a page: compile + lang via setLanguage's loader
  await mod.setLanguage('es', { load: async () => ({ Close: 'Cerrar', 'Reply to /{0}/ No. {1}': 'Responder a /{0}/ No. {1}', 'Saved: {0}': 'Guardado: {0}', Settings: 'Ajustes', 'Setup · {0}': 'Configuración · {0}' }) });
  assert.equal(tr('Close'), 'Cerrar');
  assert.equal(tr('  Close '), '  Cerrar ', 'surrounding spaces stay');
  assert.equal(tr('Reply to /g/ No. 123'), 'Responder a /g/ No. 123');
  assert.equal(tr('Setup · Settings'), 'Configuración · Ajustes', 'a part that is itself a known phrase');
  assert.equal(t('Saved: {0}', '/tmp/a.png'), 'Guardado: /tmp/a.png');
  assert.equal(tr('Something new'), 'Something new', 'no entry: English');
  assert.equal(tr('42'), '42');
  await mod.setLanguage('en');
  assert.equal(tr('Close'), 'Close');
  void compile;
});

test('the language follows the system unless one is chosen', () => {
  assert.equal(resolveLang('system', ['es-MX', 'en']), 'es');
  assert.equal(resolveLang('system', ['pt-PT']), 'pt-BR');
  assert.equal(resolveLang('system', ['ja-JP']), 'ja');
  assert.equal(resolveLang('system', ['de-DE']), 'en');
  assert.equal(resolveLang('ru', ['es']), 'ru');
  assert.deepEqual(LANGS.map((l) => l.code), LANG_SETTINGS.filter((c) => c !== 'system'));
  assert.equal(normalizeSettings({ lang: 'ja' }).lang, 'ja');
  assert.equal(normalizeSettings({ lang: 'xx' }).lang, 'system');
});

test('every language has every UI string, with the same placeholders', () => {
  const keys = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'tools/i18n-strings.mjs')], { encoding: 'utf8' }));
  const files = readdirSync(join(ROOT, 'ui/i18n')).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.deepEqual(files.sort(), ['es.json', 'ja.json', 'pt-BR.json', 'ru.json']);
  for (const f of files) {
    const table = JSON.parse(readFileSync(join(ROOT, 'ui/i18n', f), 'utf8'));
    const missing = keys.filter((k) => typeof table[k] !== 'string' || !table[k]);
    assert.deepEqual(missing, [], `${f} lacks these`);
    for (const k of keys) assert.equal(tokens(table[k]), tokens(k), `${f}: placeholders of ${JSON.stringify(k)}`);
  }
  const ja = JSON.parse(readFileSync(join(ROOT, 'ui/i18n/ja.json'), 'utf8'));
  for (const v of Object.values(ja)) assert.ok(!/コンピューター|コンピュータ|パソコン/.test(v), `Japanese says PC: ${v}`);
});

test('Settings shows the version the app is built as', () => {
  const cargo = readFileSync(join(ROOT, 'src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  assert.equal(VERSION, cargo);
  assert.equal(VERSION, conf ?? cargo);
});
