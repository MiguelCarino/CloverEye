// The Ask pane: questions about what is loaded, answered by a model on this
// computer (ai-model.js chooses the posts, ai-prompt.js words the question,
// src-tauri/src/ai.rs talks to the server). Answers stream in; every post
// they cite is a button that opens it. A conversation lives as long as its
// pane (nothing is saved).

import { h, icon, clear } from './dom.js';
import * as A from './ai-model.js';
import { buildMessages, scopeText } from './ai-prompt.js';
import { currentLang } from './i18n.js';

let seq = 0;

/** A pane's conversation: { turns, scope, draft }. */
export function newAsk() {
  return { turns: [], scope: 'thread', draft: '' };
}

const busy = (ask) => ask.turns.some((t) => t.status === 'streaming');

/**
 * @param {object} o
 * @param {object} o.ask              the pane's conversation (newAsk), changed in place
 * @param {object} o.ai               settings.ai
 * @param {object} o.bridge
 * @param {string} o.keyPrefix
 * @param {{board: string, no: number, title: string} | null} o.thread  the thread "This thread" means
 * @param {(scope: 'thread'|'all') => Array} o.sources  what a question reads (ai-model.js corpus input)
 * @param {(ref: {board: string, thread: number, no: number}) => void} o.onCite
 * @param {() => void} o.onSettings   opens Settings at Assistant
 * @param {() => void} o.redraw       draws the pane again
 */
export function askView(o) {
  const { ask, ai, keyPrefix: k, thread } = o;
  const ready = A.aiReady(ai);
  // "This thread" stays chosen while no thread is open (or still loading)
  const scope = effectiveScope(o);

  if (!ready) {
    return h(
      'div',
      { class: 'ask' },
      h(
        'div',
        { class: 'callout' },
        icon('sparkle'),
        h(
          'div',
          {},
          h('strong', { text: ai?.enabled ? 'Choose a model for the assistant' : 'The assistant is off' }),
          h('p', { text: 'Ask questions about the threads and catalogs you have open, answered by an AI model running on this computer. Turn it on and pick a model in Settings → Assistant.' }),
        ),
      ),
      h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn btn--primary', 'data-key': `${k}ask-settings`, onclick: () => o.onSettings() }, icon('settings'), 'Open Settings')),
    );
  }

  const list = h('ol', { class: 'ask__turns', 'aria-label': 'Questions and answers' }, ask.turns.map((t, i) => turnEl(t, i, o)));
  const box = h('textarea', {
    class: 'input ask__input',
    rows: 2,
    maxlength: 1000,
    'aria-label': 'Your question',
    placeholder: scope === 'thread' ? 'Ask about this thread…' : 'Ask about what is loaded…',
    'data-key': `${k}ask-input`,
    oninput: (e) => {
      ask.draft = e.target.value;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    },
  });
  box.value = ask.draft;

  function send(text = box.value) {
    const question = String(text).trim();
    if (!question || busy(ask)) return;
    ask.draft = '';
    askQuestion(o, question);
  }

  const streaming = busy(ask);
  const scopeSeg = thread
    ? h(
        'div',
        { class: 'segmented ask__scope', role: 'radiogroup', 'aria-label': 'What to search' },
        [
          { v: 'thread', label: 'This thread' },
          { v: 'all', label: 'Everything loaded' },
        ].map((x) =>
          h(
            'label',
            {},
            h('input', {
              type: 'radio',
              name: `${k}ask-scope`,
              value: x.v,
              checked: scope === x.v,
              'data-key': `${k}ask-scope-${x.v}`,
              onchange: () => {
                ask.scope = x.v;
                o.redraw();
              },
            }),
            h('span', { text: x.label }),
          ),
        ),
      )
    : null;

  const suggestions = ask.turns.length
    ? null
    : h(
        'div',
        { class: 'ask__empty' },
        h('p', { class: 'field__hint', text: thread ? `Questions about “${thread.title}” or everything you have open.` : 'Questions about the catalogs and threads you have open. Open a thread to ask about it alone.' }),
        h(
          'div',
          { class: 'ask__chips' },
          (scope === 'thread' ? ['Summarise this thread', 'What are the main points of disagreement?', 'Which posts link to sources?'] : ['Which threads are about Linux?', 'What are people recommending?', 'Summarise what is open']).map((q, i) =>
            h('button', { type: 'button', class: 'chip', 'data-key': `${k}ask-suggest-${i}`, onclick: () => send(q), text: q }),
          ),
        ),
      );

  return h(
    'div',
    { class: 'ask' },
    h(
      'div',
      { class: 'ask__bar' },
      scopeSeg,
      h(
        'button',
        { type: 'button', class: 'link-btn ask__model', 'data-key': `${k}ask-model`, onclick: () => o.onSettings(), title: 'Settings → Assistant' },
        icon('sparkle'),
        h('span', { translate: 'no', text: ai.model }),
      ),
    ),
    suggestions,
    list,
    h(
      'div',
      { class: 'ask__composer' },
      box,
      streaming
        ? h('button', { type: 'button', class: 'btn', 'data-key': `${k}ask-stop`, onclick: () => stopAll(o) }, icon('square'), 'Stop')
        : h('button', { type: 'button', class: 'btn btn--primary', 'data-key': `${k}ask-send`, onclick: () => send() }, icon('search'), 'Ask'),
    ),
    h('p', { class: 'ask__note', text: 'Answers come from a model on this computer and can be wrong: check the posts they cite.' }),
  );
}

/** Stops a conversation's answer under way (Stop, or its pane closing). */
export function stopAsk(ask, bridge) {
  for (const t of ask?.turns || []) {
    if (t.status !== 'streaming') continue;
    t.status = 'stopped';
    bridge?.aiStop?.(t.id);
  }
}

function stopAll(o) {
  stopAsk(o.ask, o.bridge);
  o.redraw();
}

const effectiveScope = (o) => (o.thread && o.ask.scope === 'thread' ? 'thread' : 'all');

function scopeLabel(o) {
  return scopeText(effectiveScope(o) === 'thread' ? o.thread : null);
}

function askQuestion(o, question) {
  const { ask, ai } = o;
  const docs = A.corpus(o.sources(effectiveScope(o)));
  const hits = A.search(docs, question, { limit: 80 });
  const chosen = A.fit(hits, docs, A.AI_REACH[ai.reach] || A.AI_REACH.normal);
  const history = ask.turns.filter((t) => t.status === 'done' && t.answer).map((t) => ({ question: t.question, answer: t.answer }));
  const turn = {
    id: `ask-${Date.now()}-${++seq}`,
    question,
    answer: '',
    status: 'streaming',
    error: '',
    posts: chosen.posts,
    read: { posts: chosen.posts.length, threads: chosen.threads, of: docs.length },
  };
  ask.turns.push(turn);
  o.redraw();
  if (!docs.length) {
    turn.status = 'error';
    turn.error = 'Nothing is loaded to search yet. Open a catalog or a thread first.';
    o.redraw();
    return;
  }
  const messages = buildMessages({ question, posts: chosen.posts, scope: scopeLabel(o), history, lang: currentLang() });
  const numCtx = A.AI_CTX[ai.reach] || A.AI_CTX.normal;
  const onEvent = (ev) => {
    if (turn.status !== 'streaming') return;
    if (ev?.type === 'text') {
      turn.answer += String(ev.text || '');
      refreshAnswer(turn, o);
    } else if (ev?.type === 'done') {
      turn.status = 'done';
      o.redraw();
    } else if (ev?.type === 'error') {
      turn.status = 'error';
      turn.error = A.aiErrorText(ev.message, ai);
      o.redraw();
    }
  };
  Promise.resolve(o.bridge.aiChat({ id: turn.id, kind: ai.kind, port: ai.port, model: ai.model, messages, numCtx }, onEvent)).catch((e) => onEvent({ type: 'error', message: e?.message || e }));
}

/** The answer drawn again while it streams, without redrawing the pane. */
function refreshAnswer(turn, o) {
  for (const el of document.querySelectorAll(`[data-ask-answer="${CSS.escape(turn.id)}"]`)) {
    const body = el.closest('.centre__body');
    const atEnd = body && body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    clear(el).append(...answerNodes(turn, o));
    if (atEnd) body.scrollTop = body.scrollHeight;
  }
}

function answerNodes(turn, o) {
  const parts = A.citeParts(turn.answer, turn.posts);
  return parts.map((p, i) =>
    p.type === 'text'
      ? p.text
      : h('button', {
          type: 'button',
          class: 'ask__cite',
          'data-key': `${o.keyPrefix}ask-cite-${turn.id}-${i}`,
          title: `Open /${p.board}/ No.${p.no}`,
          onclick: () => o.onCite({ board: p.board, thread: p.thread, no: p.no }),
          text: p.text,
        }),
  );
}

function turnEl(turn, i, o) {
  const k = o.keyPrefix;
  const parts = A.citeParts(turn.answer, turn.posts);
  const sources = turn.status === 'done' ? A.cited(parts) : [];
  const byKey = new Map(turn.posts.map((d) => [`${d.board}/${d.no}`, d]));
  return h(
    'li',
    { class: 'ask__turn', 'data-key': `${k}ask-turn-${i}` },
    h('p', { class: 'ask__q', translate: 'no', text: turn.question }),
    h('p', { class: 'ask__read' }, icon('search'), h('span', { text: turn.read.threads === 1 ? `Read ${turn.read.posts} of ${turn.read.of} posts, from one thread` : `Read ${turn.read.posts} of ${turn.read.of} posts, from ${turn.read.threads} threads` })),
    h(
      'div',
      { class: 'ask__a', translate: 'no', 'data-ask-answer': turn.id, 'aria-live': turn.status === 'streaming' ? 'polite' : null, 'aria-busy': String(turn.status === 'streaming') },
      answerNodes(turn, o),
    ),
    turn.status === 'streaming' && !turn.answer ? h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Waiting for the model… (the first answer can take a while as it loads)') : null,
    turn.status === 'stopped' ? h('p', { class: 'field__hint', text: 'Stopped.' }) : null,
    turn.status === 'error' ? h('div', { class: 'callout callout--warn', role: 'alert' }, icon('info'), h('div', { text: turn.error })) : null,
    turn.status === 'done' && !sources.length && turn.answer
      ? h('p', { class: 'field__hint', text: 'This answer cites no post: treat it with care.' })
      : null,
    sources.length
      ? h(
          'ul',
          { class: 'ask__sources', 'aria-label': 'Posts cited' },
          sources.map((s, j) => {
            const d = byKey.get(`${s.board}/${s.no}`);
            const line = (d?.sub || d?.text || '').replace(/\s+/g, ' ').slice(0, 120);
            return h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'ask__source', 'data-key': `${k}ask-source-${i}-${j}`, onclick: () => o.onCite({ board: s.board, thread: s.thread, no: s.no }) },
                h('span', { class: 'ask__source-no', translate: 'no', text: `/${s.board}/ ${s.no}` }),
                h('span', { class: 'ask__source-text', translate: 'no', text: line }),
              ),
            );
          }),
        )
      : null,
  );
}
