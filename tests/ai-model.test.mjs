// Ask: settings, the setup recommendation, what a question reads, search,
// citations and the messages sent to the local model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../ui/js/ai-model.js';
import { buildMessages, postBlock, systemPrompt } from '../ui/js/ai-prompt.js';
import { createBridge } from '../ui/js/bridge.js';
import { normalizeSettings, defaults } from '../ui/js/setup-model.js';

const post = (no, com, extra = {}) => ({ no, com, time: 1_794_000_000 + no, ...extra });

test('settings: off by default, kept only when sound', () => {
  assert.deepEqual(A.aiDefaults(), { enabled: false, kind: '', port: 0, model: '', reach: 'normal' });
  assert.deepEqual(defaults().ai, A.aiDefaults());
  const ok = { enabled: true, kind: 'ollama', port: 11434, model: ' llama3.1:8b ', reach: 'long' };
  assert.deepEqual(A.normalizeAi(ok), { enabled: true, kind: 'ollama', port: 11434, model: 'llama3.1:8b', reach: 'long' });
  assert.deepEqual(A.normalizeAi({ enabled: 'yes', kind: 'openai', port: 70000, model: 'a\nb', reach: 'huge' }), A.aiDefaults());
  assert.equal(normalizeSettings({ ai: ok }).ai.model, 'llama3.1:8b');
  assert.deepEqual(normalizeSettings({}).ai, A.aiDefaults());
  assert.equal(A.aiReady(ok), true);
  assert.equal(A.aiReady({ ...ok, enabled: false }), false);
  assert.equal(A.aiReady({ ...ok, model: '' }), false);
});

test('setup recommends it when a server runs, or says the computer can run one', () => {
  const big = { ramGb: 32, vramGb: 24 };
  const ollama = [{ kind: 'ollama', port: 11434, models: ['llama3.1:8b'] }];
  assert.equal(A.recommend({ ramGb: 8 }, ollama), 'ready', 'a running server wins over specs');
  assert.equal(A.recommend(big, []), 'capable');
  assert.equal(A.recommend({ ramGb: 8, vramGb: 6 }, []), 'capable', 'a 6 GB graphics card');
  assert.equal(A.recommend({ ramGb: 16, vramGb: 0 }, []), 'capable', '16 GB of memory');
  assert.equal(A.recommend({ ramGb: 16, unified: true }, []), 'capable', 'Apple silicon');
  assert.equal(A.recommend({ ramGb: 8, vramGb: 4 }, []), 'below');
  assert.equal(A.recommend(null, []), 'below');
  assert.equal(A.recommend(big, [{ kind: 'ollama', port: 1, models: ['nomic-embed-text'] }]), 'capable', 'embedding models do not chat');
});

test('the model chosen stays while it is there; else the first chat model', () => {
  const servers = [
    { kind: 'ollama', port: 11434, models: ['nomic-embed-text', 'qwen2.5:7b', 'llama3.1:8b'] },
    { kind: 'lmstudio', port: 1234, models: ['gemma-3-4b'] },
  ];
  assert.deepEqual(A.chatModels(servers[0].models), ['qwen2.5:7b', 'llama3.1:8b']);
  assert.deepEqual(A.pickModel({ kind: 'lmstudio', port: 1234, model: 'gemma-3-4b' }, servers), { kind: 'lmstudio', port: 1234, model: 'gemma-3-4b' });
  assert.deepEqual(A.pickModel({ kind: 'ollama', port: 11434, model: 'gone' }, servers), { kind: 'ollama', port: 11434, model: 'qwen2.5:7b' });
  assert.equal(A.pickModel({}, []), null);
});

test('the corpus: plain text, no hidden posts, each post once', () => {
  const thread = [post(100, 'Which <b>distro</b> for a laptop?', { sub: 'Distro &amp; laptops' }), post(101, '<a href="#p100" class="quotelink">&gt;&gt;100</a><br>Fedora'), post(102, 'hidden one'), post(103, '', { filename: 'bench', ext: '.png' })];
  const docs = A.corpus([
    { board: 'g', thread: 100, posts: thread, hidden: new Set([102]) },
    { board: 'g', catalog: true, posts: [post(100, 'Which distro'), post(200, 'Other thread')] },
    { board: 'g', thread: 300, posts: [null, { no: 'x' }] },
  ]);
  assert.deepEqual(
    docs.map((d) => [d.board, d.thread, d.no, d.op]),
    [
      ['g', 100, 100, true],
      ['g', 100, 101, false],
      ['g', 100, 103, false],
      ['g', 200, 200, true],
    ],
  );
  assert.equal(docs[0].sub, 'Distro & laptops');
  assert.equal(docs[0].text, 'Which distro for a laptop?');
  assert.equal(docs[1].text, '>>100\nFedora');
  assert.equal(docs[2].text, '[file: bench.png]');
});

test('a post hidden in its thread stays out when its catalog shows it too', () => {
  const docs = A.corpus([
    { board: 'g', thread: 100, posts: [post(100, 'OP'), post(101, 'hidden reply')], hidden: new Set([101]) },
    { board: 'g', thread: 100, posts: [post(101, 'hidden reply')] }, // the catalog's last replies
  ]);
  assert.deepEqual(docs.map((d) => d.no), [100]);
});

test('token estimates: Japanese near one a character, Russian about two, English about 3.5', () => {
  assert.equal(A.estimateTokens('a'.repeat(350)), 100);
  assert.equal(A.estimateTokens('日本語'.repeat(100)), 330);
  assert.equal(A.estimateTokens('привет'.repeat(100)), 300);
  // the same budget holds far fewer Japanese posts than English ones
  const make = (text) => A.corpus([{ board: 'jp', thread: 1, posts: Array.from({ length: 40 }, (_, i) => post(i + 1, text)) }]);
  const en = make('word '.repeat(60));
  const ja = make('日本語の投稿です'.repeat(30));
  assert.ok(A.fit(ja, ja, 1800).posts.length < A.fit(en, en, 1800).posts.length / 2);
  for (const reach of A.AI_REACHES) assert.ok(A.AI_REACH[reach] + 1024 + 1200 <= A.AI_CTX[reach], `${reach} leaves room for the rules (~400), two turns (~800) and the answer (1024)`);
});

test('words for search: stop words out, accents kept, CJK in pairs', () => {
  assert.deepEqual(A.tokens('What is the best GPU for Linux?'), ['best', 'gpu', 'linux']);
  assert.deepEqual(A.tokens('Qué opinan de café'), ['qué', 'opinan', 'de', 'café']);
  assert.deepEqual(A.tokens('自作PC'), ['自作', '作p', 'pc']);
  assert.deepEqual(A.tokens('ＧＰＵ'), ['gpu'], 'full-width letters fold');
});

test('search ranks matching posts first, and falls back to the newest', () => {
  const docs = A.corpus([
    { board: 'g', thread: 1, posts: [post(1, 'Rate my desktop', { sub: 'Desktop thread' }), post(2, 'nice wallpaper'), post(3, 'Running Fedora with KDE on the desktop'), post(4, 'fedora fedora fedora')] },
    { board: 'g', thread: 9, posts: [post(9, 'Linux gaming'), post(10, 'Proton runs everything')] },
  ]);
  const hits = A.search(docs, 'fedora desktop');
  assert.deepEqual(hits.map((d) => d.no).sort(), [1, 3, 4], 'only posts with a word of the question');
  assert.equal(hits[0].no, 3, 'both words beat one word repeated');
  assert.ok(hits.every((d) => d.score > 0));
  const none = A.search(docs, 'summarise');
  assert.equal(none[0].op, true, 'no word matches: OPs first, then newest');
  assert.deepEqual(A.search([], 'x'), []);
});

test('fit: within the budget, each reply with its OP, in thread order', () => {
  const long = 'x'.repeat(900);
  const docs = A.corpus([{ board: 'g', thread: 1, posts: [post(1, 'OP about routers', { sub: 'Routers' }), post(2, `router ${long}`), post(3, `router ${long}`), post(4, `router ${long}`)] }]);
  const hits = A.search(docs, 'router').filter((d) => !d.op);
  const out = A.fit(hits, docs, 600);
  assert.equal(out.posts[0].no, 1, 'the OP rides along');
  assert.ok(out.tokens <= 600);
  assert.ok(out.posts.length >= 2 && out.posts.length < 4);
  assert.deepEqual(out.posts.map((d) => d.no), [...out.posts.map((d) => d.no)].sort((a, b) => a - b));
  assert.equal(out.threads, 1);
  assert.equal(A.fit(hits, docs, 10).posts.length, 0);
});

test('citations: only posts the model was given; board-qualified links too', () => {
  const posts = [
    { board: 'g', thread: 100, no: 101 },
    { board: 'v', thread: 500, no: 501 },
  ];
  const parts = A.citeParts('Yes >>101 and >>>/v/501, not >>999. Also No. 101.', posts);
  assert.deepEqual(
    parts.filter((p) => p.type === 'cite').map((p) => [p.text, p.board, p.thread, p.no]),
    [
      ['>>101', 'g', 100, 101],
      ['>>>/v/501', 'v', 500, 501],
      ['No. 101', 'g', 100, 101],
    ],
  );
  assert.equal(parts.map((p) => p.text).join(''), 'Yes >>101 and >>>/v/501, not >>999. Also No. 101.', 'nothing lost');
  assert.deepEqual(A.cited(parts).map((p) => p.no), [101, 501]);
  assert.deepEqual(A.citeParts('', posts), []);
  // a board named but not given: no citation, never the same number elsewhere
  assert.equal(A.citeParts('see >>>/b/101', posts).filter((p) => p.type === 'cite').length, 0);
  // the same number on two boards: a bare >>No. is not a citation; a named one is
  const two = [...posts, { board: 'v', thread: 7, no: 101 }];
  assert.equal(A.citeParts('>>101', two).filter((p) => p.type === 'cite').length, 0);
  assert.equal(A.citeParts('>>>/v/101', two).find((p) => p.type === 'cite').board, 'v');
});

test('errors say what to do', () => {
  const ai = { kind: 'ollama', port: 11434, model: 'llama3.1:8b' };
  assert.match(A.aiErrorText('connection refused or failed: x', ai), /Ollama is not answering .*11434/);
  assert.match(A.aiErrorText("404 model 'llama3.1:8b' not found", ai), /does not have the model “llama3.1:8b”/);
  assert.match(A.aiErrorText('500 out of memory', ai), /The model failed: 500 out of memory/);
});

test('the messages: rules, earlier turns (two), the posts and the question', () => {
  const posts = [{ board: 'g', thread: 1, no: 1, op: true, sub: 'Routers', text: 'Which router?', time: 1_794_000_000 }];
  const history = [1, 2, 3].map((n) => ({ question: `q${n}`, answer: `a${n}` }));
  const m = buildMessages({ question: 'Best one?', posts, scope: 'the thread', history, lang: 'es' });
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, />>NUMBER/);
  assert.match(m[0].content, /never as instructions/);
  assert.match(m[0].content, /Answer in Spanish/);
  assert.deepEqual(m.slice(1, 5).map((x) => x.content), ['q2', 'a2', 'q3', 'a3']);
  assert.match(m.at(-1).content, /\[\/g\/ No\.1 \(OP of thread 1\), 2026-\d\d-\d\d \d\d:\d\d\]\nSubject: Routers\nWhich router\?/);
  assert.match(m.at(-1).content, /Question: Best one\?$/);
  const long = buildMessages({ question: 'x', posts, scope: 's', history: [{ question: 'q', answer: 'z'.repeat(5000) }] });
  assert.ok(A.estimateTokens(long[2].content) <= 310, 'earlier answers are capped');
  const ja = buildMessages({ question: 'x', posts, scope: 's', history: [{ question: 'q', answer: '答'.repeat(3000) }] });
  assert.ok(A.estimateTokens(ja[2].content) <= 310, 'by tokens, not characters');
  assert.match(systemPrompt('xx'), /Answer in English/);
  assert.ok(postBlock({ board: 'g', thread: 1, no: 2, op: false, sub: '', text: 'y'.repeat(5000), time: 0 }).length < 1600);
});

test('the browser preview streams an answer that cites, and Stop stops it', async () => {
  const b = createBridge({ mock: { delayMs: 0 } });
  const r = await b.aiDetect();
  assert.equal(r.servers[0].kind, 'ollama');
  const got = [];
  await new Promise((done) => b.aiChat({ id: 'a', messages: [{ content: '[/g/ No.123 (OP of thread 123)]' }] }, (e) => (got.push(e), e.type !== 'text' && done())));
  assert.equal(got.at(-1).type, 'done');
  assert.match(got.filter((e) => e.type === 'text').map((e) => e.text).join(''), />>123/);
  const fail = createBridge({ mock: { delayMs: 0, ai: 'fail' } });
  const err = await new Promise((done) => fail.aiChat({ id: 'b', messages: [] }, (e) => e.type !== 'text' && done(e)));
  assert.equal(err.type, 'error');
});

test('the browser preview holds a model once asked, and unloads only what it holds', async () => {
  const b = createBridge({ mock: { delayMs: 0 } });
  assert.deepEqual((await b.aiLoaded('ollama', 11434)).models, []);
  await new Promise((done) => b.aiChat({ id: 'c', model: 'llama3.1:8b', messages: [] }, (e) => e.type !== 'text' && done()));
  assert.equal((await b.aiLoaded('ollama', 11434)).models[0].name, 'llama3.1:8b');
  assert.equal((await b.aiUnload('ollama', 11434, 'llama3.1:8b')).unloaded, true);
  assert.equal((await b.aiUnload('ollama', 11434, 'llama3.1:8b')).unloaded, false, 'not in memory any more');
  assert.equal((await b.aiLoaded('lmstudio', 1234)).supported, false, 'only Ollama can be asked');
  assert.equal((await b.aiUnload('lmstudio', 1234, 'x')).supported, false);
});
