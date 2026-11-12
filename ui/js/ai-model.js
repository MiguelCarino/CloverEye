// Ask: a local model answers questions about what is loaded in CloverEye
// (open catalogs and threads, saved threads). DOM-free.
//
// Only a model server on this computer (localhost) is ever asked: the Rust
// side (src-tauri/src/ai.rs) refuses any other address. Nothing is fetched
// from the site for a question: the posts are the ones already loaded, minus
// hidden and filtered ones and boards the person has hidden. CloverEye
// searches them itself and hands the best matches to the model with the
// question ("search first"), so any chat model works, small ones included.

import { commentText, decodeEntities } from './render.js';
import { STOP_WORDS, postBlock, estimateTokens } from './ai-prompt.js';

export { estimateTokens };

/** Model servers CloverEye looks for on this computer, by kind. */
export const AI_KINDS = Object.freeze(['ollama', 'lmstudio', 'llamacpp', 'jan', 'custom']);
export const AI_KIND_LABELS = Object.freeze({ ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', jan: 'Jan', custom: 'Other local server' });

/** How much of what is loaded one question may read: posts handed to the
 *  model, in tokens (estimateTokens), leaving room in AI_CTX for the rules,
 *  two earlier turns and a 1,024-token answer. */
export const AI_REACH = Object.freeze({ short: 1800, normal: 4800, long: 12000 });
export const AI_REACHES = Object.freeze(Object.keys(AI_REACH));
/** Ollama's context (tokens) for each reach: room for the posts (≈3.5
 *  characters a token), the rules, earlier turns and the answer. Fixed per
 *  reach, since Ollama loads the model again whenever it changes. */
export const AI_CTX = Object.freeze({ short: 4096, normal: 8192, long: 16384 });

/** Specs for a local model (a 7–8B model at 4-bit, ~5 GB): GPU memory, or
 *  memory the GPU shares (Apple silicon), or enough RAM to run on the CPU. */
export const MIN_VRAM_GB = 6;
export const MIN_RAM_GB = 16;

export function aiDefaults() {
  return { enabled: false, kind: '', port: 0, model: '', reach: 'normal' };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function normalizeAi(raw) {
  const d = aiDefaults();
  if (!isObj(raw)) return d;
  const model = typeof raw.model === 'string' && raw.model.length <= 200 && !/[\0\n]/.test(raw.model) ? raw.model.trim() : '';
  return {
    enabled: raw.enabled === true,
    kind: AI_KINDS.includes(raw.kind) ? raw.kind : '',
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : 0,
    model,
    reach: AI_REACHES.includes(raw.reach) ? raw.reach : d.reach,
  };
}

/** Whether the assistant can be used now: switched on with a server and a
 *  model chosen. */
export const aiReady = (ai) => Boolean(ai?.enabled && ai.kind && ai.port && ai.model);

/**
 * What setup recommends, from the computer's specs and the servers found
 * (ai_detect): 'ready' (a local server with a chat model is running),
 * 'capable' (none found, but this computer can run one), 'below' (not
 * enough memory for a local model).
 * @param {{ramGb?: number, vramGb?: number, unified?: boolean}} specs
 * @param {Array<{models: string[]}>} servers
 */
export function recommend(specs, servers) {
  if ((servers || []).some((s) => chatModels(s.models).length)) return 'ready';
  const ram = Number(specs?.ramGb) || 0;
  const vram = Number(specs?.vramGb) || 0;
  if (vram >= MIN_VRAM_GB || ram >= MIN_RAM_GB || (specs?.unified && ram >= MIN_RAM_GB)) return 'capable';
  return 'below';
}

/** Models that can chat: embedding models are left out. */
export function chatModels(models) {
  return (Array.isArray(models) ? models : []).filter((m) => typeof m === 'string' && m && !/embed|bge-|e5-|minilm|rerank/i.test(m));
}

/** The first server and model to use: the one already chosen if it is
 *  still there, else the first chat model found. */
export function pickModel(ai, servers) {
  const list = (servers || []).flatMap((s) => chatModels(s.models).map((model) => ({ kind: s.kind, port: s.port, model })));
  return list.find((x) => x.kind === ai?.kind && x.port === ai?.port && x.model === ai?.model) || list[0] || null;
}

// ----------------------------------------------------------------- corpus

/**
 * Every post a question may read, as plain text.
 * @param {Array<{board: string, thread: number, posts: object[], hidden?: Set<number>, saved?: boolean, catalog?: boolean}>} sources
 *   a thread's posts (OP first), or a catalog's threads (`catalog`: each is its OP)
 * @returns {Array<{board: string, thread: number, no: number, op: boolean, sub: string, text: string, time: number, saved: boolean}>}
 */
export function corpus(sources) {
  const seen = new Set();
  const out = [];
  for (const src of sources || []) {
    if (!src || !Array.isArray(src.posts)) continue;
    for (const p of src.posts) {
      if (!p || !Number.isSafeInteger(p.no)) continue;
      const thread = src.catalog ? p.no : src.thread;
      const key = `${src.board}/${p.no}`;
      // a thread both open and in its catalog: once; and a post hidden in one
      // place (its thread) stays out when it shows up in another (the catalog)
      if (seen.has(key)) continue;
      seen.add(key);
      if (src.hidden?.has(p.no)) continue;
      const sub = p.sub ? decodeEntities(p.sub).trim() : '';
      const text = commentText(p.com || '').replace(/\n{3,}/g, '\n\n').trim();
      const file = p.filename ? `${decodeEntities(p.filename)}${p.ext || ''}` : '';
      if (!sub && !text && !file) continue;
      out.push({ board: src.board, thread, no: p.no, op: p.no === thread, sub, text: file && !text ? `[file: ${file}]` : text, file, time: p.time || 0, saved: Boolean(src.saved) });
    }
  }
  return out;
}

// ----------------------------------------------------------------- search

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

/** Words for search: lower case, accents kept; Japanese, Chinese and
 *  Korean text as overlapping pairs of characters. */
export function tokens(text) {
  const out = [];
  for (const w of String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (CJK.test(w)) {
      const chars = [...w];
      if (chars.length === 1) out.push(w);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
    } else if (w.length > 1 && !STOP_WORDS.has(w)) {
      out.push(w);
    }
  }
  return out;
}

/**
 * The posts that best match a question (BM25 over subject + comment). A
 * question with no word that matches anything gets the newest posts, so
 * "summarise this thread" still reads the thread.
 * @returns {Array<object>} corpus entries, best first, with `score`
 */
export function search(docs, question, { limit = 60 } = {}) {
  const q = [...new Set(tokens(question))];
  const N = docs.length;
  if (!N) return [];
  const toks = docs.map((d) => tokens(`${d.sub} ${d.text} ${d.file}`));
  const avg = toks.reduce((n, t) => n + t.length, 0) / N || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) if (q.includes(w)) df.set(w, (df.get(w) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    if (df.size) {
      const tf = new Map();
      for (const w of toks[i]) if (df.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
      for (const [w, f] of tf) {
        const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg));
      }
      if (score && d.op) score *= 1.15; // a thread's subject and OP set its topic
    }
    return { ...d, score };
  });
  const hits = scored.filter((d) => d.score > 0).sort((a, b2) => b2.score - a.score || b2.time - a.time);
  if (hits.length) return hits.slice(0, limit);
  return scored.sort((a, b2) => (b2.op ? 1 : 0) - (a.op ? 1 : 0) || b2.time - a.time).slice(0, limit);
}

/** The hits that fit in `budget` tokens, OPs of the threads they come from
 *  first (their subject says what a reply is about), then in thread order. */
export function fit(hits, docs, budget) {
  const byKey = new Map(docs.map((d) => [`${d.board}/${d.no}`, d]));
  const chosen = [];
  const have = new Set();
  let used = 0;
  const take = (d) => {
    const key = `${d.board}/${d.no}`;
    if (have.has(key)) return true;
    const size = estimateTokens(postBlock(d)) + 2;
    if (used + size > budget) return false;
    used += size;
    have.add(key);
    chosen.push(d);
    return true;
  };
  for (const d of hits) {
    const op = byKey.get(`${d.board}/${d.thread}`);
    if (op && !have.has(`${op.board}/${op.no}`) && !take(op)) break;
    if (!take(d)) break;
  }
  chosen.sort((a, b) => a.board.localeCompare(b.board) || a.thread - b.thread || a.no - b.no);
  return { posts: chosen, tokens: used, threads: new Set(chosen.map((d) => `${d.board}/${d.thread}`)).size };
}

// -------------------------------------------------------------- citations

/**
 * Splits an answer into text and the posts it cites: >>123 or >>>/g/123.
 * Only posts that were handed to the model count as citations; any other
 * number stays text.
 * @returns {Array<{type: 'text', text: string} | {type: 'cite', text: string, board: string, thread: number, no: number}>}
 */
export function citeParts(answer, posts) {
  const byNo = new Map();
  for (const d of posts || []) {
    byNo.set(`${d.board}/${d.no}`, d);
    const bare = String(d.no);
    // the same number on two boards: a bare >>No. could be either
    byNo.set(bare, byNo.has(bare) && byNo.get(bare)?.board !== d.board ? null : d);
  }
  const out = [];
  let last = 0;
  // >>>/board/123 (another board), >>123, or "No. 123" as models also write
  const re = />>>\/([a-z0-9]{1,10})\/(\d{1,12})|>>(\d{1,12})|\bNo\.\s?(\d{3,12})/g;
  const text = String(answer);
  for (let m; (m = re.exec(text)); ) {
    const no = m[2] || m[3] || m[4];
    const d = m[1] ? byNo.get(`${m[1]}/${no}`) : byNo.get(no);
    if (!d) continue;
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'cite', text: m[0], board: d.board, thread: d.thread, no: d.no });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** The distinct posts an answer cites, in the order cited. */
export function cited(parts) {
  const seen = new Set();
  return parts.filter((p) => p.type === 'cite' && !seen.has(`${p.board}/${p.no}`) && seen.add(`${p.board}/${p.no}`));
}

/** What a failed question shows: the server's own words are kept. */
export function aiErrorText(e, ai) {
  const msg = String(e?.message ?? e ?? '');
  const label = AI_KIND_LABELS[ai?.kind] || 'The model server';
  if (/refused|connect|unreachable|timed out connecting/i.test(msg)) return `${label} is not answering on this computer (port ${ai?.port}). Is it running?`;
  if (/not found|404|no such model|model .* not/i.test(msg)) return `${label} does not have the model “${ai?.model}”. Pick another in Settings → Assistant.`;
  return `The model failed: ${msg || 'no answer'}`;
}
