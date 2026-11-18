// ui/js/log.js: batching, the per-area rate cap, the field sanitiser,
// debug gating and the timer; and the log dialog's filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, sanitizeFields, contentKey, CONTENT_KEYS, AREAS, formatLine, detailFromSettings, log as appLog } from '../ui/js/log.js';
import { parseLine, filterLines, areasIn } from '../ui/js/log-dialog.js';
import { createBridge } from '../ui/js/bridge.js';

/** A logger on a fake clock and fake timers, with a sink that records. */
function rig(opts = {}) {
  let t = 1_000_000;
  let mono = 0;
  const timers = [];
  const batches = [];
  const told = [];
  const logger = createLogger({
    now: () => t,
    mono: () => mono,
    setTimer: (f, ms) => {
      const id = { f, ms };
      timers.push(id);
      return id;
    },
    clearTimer: (id) => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
    ...opts,
  });
  const sink = {
    detailed: false,
    logBatch(lines) {
      batches.push(lines);
      return Promise.resolve(sink.detailed);
    },
    setLogDetail(on) {
      told.push(on);
      return Promise.resolve(on);
    },
  };
  logger.setSink(sink);
  return {
    logger,
    sink,
    batches,
    told,
    timers,
    advance: (ms) => (t += ms),
    tick: (ms) => (mono += ms),
    fire: () => timers.splice(0).forEach((x) => x.f()),
  };
}

test('lines go out in one batch after the window, not one invoke each', () => {
  const r = rig();
  r.logger.info('tabs', 'tab.opened', { tabs: 2 });
  r.logger.warn('net', 'catalog.slow', { ms: 900 });
  r.logger.error('post', 'post.failed', { status: 403 });
  assert.equal(r.batches.length, 0, 'nothing sent yet');
  assert.equal(r.timers.length, 1, 'one timer for the batch');
  assert.equal(r.timers[0].ms, 500);
  r.fire();
  assert.equal(r.batches.length, 1);
  assert.deepEqual(r.batches[0], [
    { level: 'info', area: 'tabs', msg: 'tab.opened', fields: { tabs: 2 } },
    { level: 'warn', area: 'net', msg: 'catalog.slow', fields: { ms: 900 } },
    { level: 'error', area: 'post', msg: 'post.failed', fields: { status: 403 } },
  ]);
  assert.deepEqual(r.logger.pending(), []);
});

test('a full batch (50 lines) goes at once; flush sends the rest', () => {
  const r = rig();
  for (let i = 0; i < 120; i++) r.logger.info('thread', 'line', { i });
  assert.equal(r.batches.length, 2);
  assert.equal(r.batches[0].length, 50);
  assert.equal(r.batches[1].length, 50);
  r.logger.flush();
  assert.equal(r.batches.length, 3);
  assert.equal(r.batches[2].length, 20);
  r.logger.flush();
  assert.equal(r.batches.length, 3, 'an empty flush sends nothing');
});

test('lines logged before the bridge is there wait for it', () => {
  const logger = createLogger({ setTimer: () => 1, clearTimer: () => {} });
  logger.info('app', 'early');
  const got = [];
  logger.setSink({ logBatch: (l) => (got.push(l), Promise.resolve(false)) });
  logger.flush();
  assert.equal(got.length, 1);
  assert.equal(got[0][0].msg, 'early');
});

test('each area is capped a minute, then one line says how many were dropped', () => {
  const r = rig({ perAreaPerMin: 5, maxBatch: 1000 });
  for (let i = 0; i < 12; i++) r.logger.info('gallery', 'frame', { i });
  r.logger.info('tabs', 'other.area'); // another area is not held back
  r.logger.flush();
  const sent = r.batches.flat();
  assert.equal(sent.filter((l) => l.area === 'gallery').length, 5);
  assert.equal(sent.filter((l) => l.area === 'tabs').length, 1);
  r.advance(60_000);
  r.logger.info('gallery', 'frame', { i: 99 });
  r.logger.flush();
  const later = r.batches.at(-1);
  assert.deepEqual(later[0], { level: 'warn', area: 'gallery', msg: 'log.dropped', fields: { n: 7, perMin: 5 } });
  assert.equal(later[1].fields.i, 99);
});

test('the dropped count also comes out on a later flush with no new line', () => {
  const r = rig({ perAreaPerMin: 2, maxBatch: 1000 });
  for (let i = 0; i < 5; i++) r.logger.info('ai', 'piece');
  r.logger.flush();
  r.advance(61_000);
  r.logger.flush();
  assert.deepEqual(r.batches.at(-1), [{ level: 'warn', area: 'ai', msg: 'log.dropped', fields: { n: 3, perMin: 2 } }]);
});

test('warnings and errors have their own budget: a busy minute of debug lines never drops them', () => {
  const r = rig({ perAreaPerMin: 200, perAreaWarnPerMin: 3, maxBatch: 10_000 });
  r.logger.setDetailed(true);
  for (let i = 0; i < 200; i++) r.logger.debug('thread', 'poll.scheduled');
  r.logger.error('thread', 'thread.failed', { status: 500 });
  r.logger.warn('thread', 'thread.slow');
  r.logger.debug('thread', 'one.too.many');
  r.logger.flush();
  const sent = r.batches.flat();
  assert.equal(sent.filter((l) => l.level === 'debug').length, 200);
  assert.deepEqual(sent.filter((l) => l.level !== 'debug').map((l) => l.msg), ['thread.failed', 'thread.slow']);
  // their own cap still holds
  for (let i = 0; i < 5; i++) r.logger.warn('thread', 'w');
  r.logger.flush();
  assert.equal(r.batches.flat().filter((l) => l.msg === 'w').length, 1);
  r.advance(60_000);
  r.logger.flush();
  assert.deepEqual(r.batches.at(-1), [{ level: 'warn', area: 'thread', msg: 'log.dropped', fields: { n: 5, perMin: 200 } }]);
});

test('settings saves never turn off Detailed logs the environment switched on', async () => {
  const r = rig();
  r.sink.detailed = true; // CLOVEREYE_LOG_DETAIL=1, the setting off
  r.logger.info('app', 'start');
  r.logger.flush();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.logger.isDetailed(), true);
  r.logger.setDetailed(false); // a grouped settings save (read marks...)
  assert.equal(r.logger.isDetailed(), true);
  r.logger.debug('settings', 'settings.saved', { keys: 1 });
  r.logger.flush();
  assert.equal(r.batches.at(-1)[0].msg, 'settings.saved');
  // the environment off: the app says so
  r.sink.detailed = false;
  r.logger.info('app', 'x');
  r.logger.flush();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.logger.isDetailed(), false);
});

test('the sanitiser refuses content keys, whatever their value', () => {
  for (const k of ['text', 'com', 'name', 'sub', 'prompt', 'answer', 'title', 'file', 'filename', 'terms', 'query', 'pasta', 'captcha', 'token', 'cookie', 'password', 'email', 'trip']) {
    assert.equal(sanitizeFields({ [k]: 'secret' }), null, k);
    assert.ok(contentKey(k));
  }
  for (const k of ['replyText', 'fileName', 'threadTitle', 'userPrompt', 'tagTerms', 'postComment', 'searchQuery']) assert.ok(contentKey(k), k);
  for (const k of ['count', 'ms', 'board', 'thread', 'no', 'status', 'model', 'chars', 'bytes', 'kind', 'error', 'url', 'tabs']) assert.ok(!contentKey(k), k);
  assert.ok(CONTENT_KEYS.includes('com') && AREAS.includes('ai') && AREAS.includes('pasta'));
  const f = sanitizeFields({
    board: 'g',
    thread: 123,
    chars: 42,
    ok: true,
    text: 'my post',
    replyText: 'x',
    'bad key': 1,
    win: 'w-2',
    nested: { a: 1 },
    list: [1, 2],
    nan: NaN,
    nothing: null,
    err: new Error('Request failed'),
    url: 'https://example.org/a/b?token=abc#frag',
    where: 'https://sys.4chan.org/captcha?board=g',
    long: 'x'.repeat(500),
    ms: 12.34567,
  });
  assert.deepEqual(Object.keys(f), ['board', 'thread', 'chars', 'ok', 'err', 'url', 'where', 'long', 'ms']);
  assert.equal(f.err, 'Request failed');
  assert.equal(f.url, 'https://example.org/a/b?…');
  assert.equal(f.where, 'https://sys.4chan.org/captcha?…');
  assert.equal(f.long.length, 120);
  assert.equal(f.ms, 12.346);
  assert.equal(sanitizeFields('text'), null);
  assert.equal(sanitizeFields([1, 2]), null);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));
  assert.equal(Object.keys(sanitizeFields(many)).length, 16);
});

test('a line with only content fields goes without fields; bad areas and messages are tidied', () => {
  const r = rig();
  r.logger.info('compose', 'post.drafted', { text: 'hello', com: 'x' });
  r.logger.info('Not An Area!', 'two\nlines');
  r.logger.info('ui', '');
  r.logger.flush();
  assert.deepEqual(r.batches[0], [
    { level: 'info', area: 'compose', msg: 'post.drafted' },
    { level: 'info', area: 'ui', msg: 'two lines' },
    { level: 'info', area: 'ui', msg: 'event' },
  ]);
});

test('debug lines are made only with Detailed logs on, and cost nothing when off', () => {
  const r = rig();
  let built = 0;
  const fields = () => (built++, { n: 1 });
  assert.equal(r.logger.enabled('debug'), false);
  assert.equal(r.logger.enabled('info'), true);
  r.logger.debug('thread', 'redraw', r.logger.enabled('debug') ? fields() : undefined);
  r.logger.flush();
  assert.equal(r.batches.length, 0);
  assert.equal(built, 0);
  r.logger.setDetailed(true);
  r.logger.debug('thread', 'redraw', { posts: 3 });
  r.logger.flush();
  assert.deepEqual(r.batches[0], [{ level: 'debug', area: 'thread', msg: 'redraw', fields: { posts: 3 } }]);
  assert.deepEqual(r.told, [], 'only told the app when asked to');
  r.logger.setDetailed(false, { tell: true });
  assert.deepEqual(r.told, [false]);
});

test('the app’s answer to a batch sets Detailed logs (the environment switch)', async () => {
  const r = rig();
  r.sink.detailed = true;
  r.logger.info('app', 'x');
  r.logger.flush();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.logger.isDetailed(), true);
});

test('time() logs the duration with its fields; at debug it needs Detailed logs', () => {
  const r = rig();
  const off = r.logger.time('catalog', 'catalog.render');
  r.tick(40);
  assert.equal(off({ threads: 10 }), 0, 'debug off: nothing measured or logged');
  const end = r.logger.time('catalog', 'catalog.load', 'info');
  r.tick(123.4);
  assert.equal(end({ threads: 150, board: 'g' }), 123);
  r.logger.setDetailed(true);
  const dbg = r.logger.time('thread', 'thread.render');
  r.tick(7);
  dbg({ posts: 3 }, 'warn');
  r.logger.flush();
  assert.deepEqual(r.batches[0], [
    { level: 'info', area: 'catalog', msg: 'catalog.load', fields: { threads: 150, board: 'g', ms: 123 } },
    { level: 'warn', area: 'thread', msg: 'thread.render', fields: { posts: 3, ms: 7 } },
  ]);
});

test('a sink that throws or rejects never breaks the page', () => {
  const logger = createLogger({ setTimer: () => 1, clearTimer: () => {} });
  logger.setSink({
    logBatch() {
      throw new Error('gone');
    },
  });
  logger.info('ui', 'x');
  assert.doesNotThrow(() => logger.flush());
  logger.setSink({ logBatch: () => Promise.reject(new Error('gone')) });
  logger.info('ui', 'y');
  assert.doesNotThrow(() => logger.flush());
});

test('lines read like the app’s', () => {
  const at = new Date(Date.UTC(2026, 10, 17, 10, 4, 12, 345));
  assert.equal(formatLine({ level: 'info', area: 'tabs', msg: 'tab.opened', fields: { kind: 'thread', why: 'two words' } }, at), '2026-11-17 10:04:12.345 INFO  tabs: tab.opened kind=thread why="two words"');
  assert.equal(formatLine({ level: 'debug', area: 'ai', msg: 'x' }, at), '2026-11-17 10:04:12.345 DEBUG ai: x');
});

test('the bridge hands its lines to the app in one invoke and reads the switch from settings', async () => {
  const calls = [];
  const tauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'get_settings') return { diagnostics: { detailed: true } };
        if (cmd === 'diagnostics_log') return true;
        return null;
      },
    },
  };
  const b = createBridge({ tauri });
  assert.equal(calls.length, 0, 'making the bridge invokes nothing');
  await b.getSettings();
  assert.equal(appLog.isDetailed(), true);
  appLog.debug('thread', 'probe', { n: 1 });
  appLog.info('thread', 'probe2', { text: 'never' });
  appLog.flush();
  const sent = calls.filter(([c]) => c === 'diagnostics_log');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].lines.slice(-2), [
    { level: 'debug', area: 'thread', msg: 'probe', fields: { n: 1 } },
    { level: 'info', area: 'thread', msg: 'probe2' },
  ]);
  await b.setLogDetail(false);
  assert.deepEqual(calls.at(-1), ['set_log_detail', { on: false }]);
  await b.setSettings({ diagnostics: { detailed: false } });
  assert.equal(appLog.isDetailed(), false);
  detailFromSettings(null); // not settings: left as it is
  assert.equal(appLog.isDetailed(), false);
});

test('the mock keeps the lines in memory and writes them into its report', async () => {
  const b = createBridge({ mock: { delayMs: 0 } });
  await b.setSettings({ diagnostics: { detailed: true } });
  appLog.info('pasta', 'pasta.saved', { chars: 12 });
  appLog.debug('pasta', 'pasta.grid', { cards: 4 });
  appLog.flush();
  await new Promise((res) => setTimeout(res, 0));
  const kept = globalThis.__ceLogs.filter((l) => l.area === 'pasta');
  assert.deepEqual(kept.map((l) => l.msg), ['pasta.saved', 'pasta.grid']);
  const text = await b.diagnosticsText();
  assert.match(text, /INFO {2}pasta: pasta\.saved chars=12/);
  assert.match(text, /DEBUG pasta: pasta\.grid cards=4/);
  assert.match(text, /Log: detailed logs on;/);
  await b.setSettings({ diagnostics: { detailed: false } });
});

// ------------------------------------------------------------ the dialog

const REPORT = [
  'CloverEye diagnostics',
  'Switches: none',
  '',
  "== This session's log",
  '2026-11-17 10:00:00.001 INFO  app: started CloverEye version=0.1.5',
  '2026-11-17 10:00:01.002 DEBUG net: request kind=catalog board=g status=200',
  '2026-11-17 10:00:02.003 WARN  net: request failed kind=thread board=g',
  '2026-11-17 10:00:03.004 ERROR ui: Uncaught TypeError at shell.js:10',
  '2026-11-17 10:00:04.005 INFO  ai: answered model=llama3.1:8b tok_per_s=40',
  '',
  '== The session before (clovereye.old.log, last 500 lines)',
  '2026-11-16 09:00:00 post helper: request 3: captcha',
];

test('report lines are read for their level and area; others are not log lines', () => {
  assert.deepEqual(parseLine(REPORT[5]), { level: 'debug', area: 'net' });
  assert.deepEqual(parseLine(REPORT[6]), { level: 'warn', area: 'net' });
  assert.equal(parseLine(REPORT[0]), null);
  assert.equal(parseLine(REPORT.at(-1)), null, 'an older session’s free text');
  assert.deepEqual(areasIn(REPORT), ['ai', 'app', 'net', 'ui']);
});

test('the dialog’s filters: level, area and search', () => {
  assert.equal(filterLines(REPORT, {}), REPORT, 'no filter: the whole report');
  assert.deepEqual(filterLines(REPORT, { level: 'problems' }), [REPORT[6], REPORT[7]]);
  assert.deepEqual(filterLines(REPORT, { level: 'errors' }), [REPORT[7]]);
  assert.deepEqual(filterLines(REPORT, { area: 'net' }), [REPORT[5], REPORT[6]]);
  assert.deepEqual(filterLines(REPORT, { area: 'net', level: 'problems' }), [REPORT[6]]);
  assert.deepEqual(filterLines(REPORT, { query: 'LLAMA' }), [REPORT[8]]);
  assert.deepEqual(filterLines(REPORT, { query: 'captcha' }), [REPORT.at(-1)], 'search covers every line');
  assert.deepEqual(filterLines(REPORT, { area: 'post' }), []);
});
