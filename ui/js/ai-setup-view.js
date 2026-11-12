// The assistant's controls, in setup (its own step) and Settings →
// Assistant: what was found on this computer, whether it is recommended,
// the switch, the model, and in Settings how much a question reads and a
// server on another port. Nothing is installed: when no server runs, the
// step says how to get one.

import { h, icon, toast, copyText } from './dom.js';
import * as A from './ai-model.js';
import { t } from './i18n.js';

const PULL = 'ollama pull llama3.1:8b';

/** The detection state both places keep: { status, servers, specs, error,
 *  memory }; memory is what the chosen server holds now ({ status,
 *  supported, models }). */
export const idleDetect = () => ({ status: 'idle', servers: [], specs: null, error: '', memory: { status: 'idle', supported: false, models: [] } });

/** Asks the chosen server what it holds in memory (Ollama only can say). */
export async function runMemory(bridge, detect, ai, after) {
  if (!bridge?.aiLoaded || !ai?.kind || !ai.port) return;
  detect.memory = { ...detect.memory, status: 'checking' };
  try {
    const r = await bridge.aiLoaded(ai.kind, ai.port);
    detect.memory = { status: 'done', supported: Boolean(r?.supported), models: Array.isArray(r?.models) ? r.models : [] };
  } catch {
    detect.memory = { status: 'error', supported: false, models: [] };
  }
  after();
}

const sameModel = (a, b) => (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`);

/** Frees the memory the chosen model holds. Only Ollama can be asked; the
 *  others are unloaded in their own app. { result: 'unloaded' | 'absent' |
 *  'unsupported' | 'error' | 'none', text } */
export async function unloadModel(bridge, ai) {
  const label = A.AI_KIND_LABELS[ai?.kind] || 'The model server';
  if (!bridge?.aiUnload || !ai?.kind || !ai.port || !ai.model) return { result: 'none', text: '' };
  try {
    const r = await bridge.aiUnload(ai.kind, ai.port, ai.model);
    if (!r?.supported) return { result: 'unsupported', text: t('{0} keeps its models itself: unload it there.', label) };
    return r.unloaded
      ? { result: 'unloaded', text: t('Unloaded {0}: its memory is free again.', r.name || ai.model) }
      : { result: 'absent', text: t('{0} was not in memory.', ai.model) };
  } catch (e) {
    return { result: 'error', text: A.aiErrorText(e?.message ?? e, ai) };
  }
}

function memoryEl(ai, detect, onUnload) {
  if (!ai.kind || !ai.model) return null;
  const label = A.AI_KIND_LABELS[ai.kind] || ai.kind;
  const m = detect.memory || {};
  if (ai.kind !== 'ollama') {
    return h('p', { class: 'field__hint', 'data-key': 'ai-memory', text: ai.kind === 'llamacpp' ? 'llama.cpp’s server keeps its model in memory until the server is stopped.' : `${label} keeps the model in memory. To free it, unload the model in ${label}.` });
  }
  const here = (m.models || []).find((x) => sameModel(x.name, ai.model));
  const line =
    m.status === 'checking' || m.status === 'idle'
      ? 'Checking what Ollama holds in memory…'
      : m.status === 'error'
        ? 'Couldn’t ask Ollama what it holds in memory.'
        : here
          ? here.vramGb
            ? `${here.name} is in memory: ${here.gb} GB, ${here.vramGb} GB of it on the graphics card.`
            : `${here.name} is in memory: ${here.gb} GB.`
          : 'The model is not in memory. Ollama loads it when you ask, and frees it by itself after 5 minutes unused.';
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field__label', text: 'Memory' }),
    h('p', { class: 'field__hint', 'data-key': 'ai-memory', role: 'status', text: line }),
    h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn', 'data-key': 'ai-unload', disabled: !here, onclick: () => onUnload(ai) }, icon('x'), 'Unload the model')),
  );
}

/** Runs ai_detect into `detect` (changed in place); `after` redraws. */
export async function runDetect(bridge, detect, port, after) {
  if (!bridge?.aiDetect || detect.status === 'checking') return;
  detect.status = 'checking';
  after();
  try {
    const r = await bridge.aiDetect(port || 0);
    detect.servers = Array.isArray(r?.servers) ? r.servers : [];
    detect.specs = r?.specs || null;
    detect.status = 'done';
    detect.error = '';
  } catch (e) {
    detect.status = 'error';
    detect.error = String(e?.message || e);
  }
  after();
}

const fmtGb = (n) => (Number(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

function verdictEl(detect, servers) {
  if (detect.status === 'checking' || detect.status === 'idle') {
    return h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Looking for a model server on this computer…');
  }
  if (detect.status === 'error') return h('div', { class: 'callout callout--warn' }, icon('info'), h('div', { text: `Couldn’t check this computer: ${detect.error}` }));
  const v = A.recommend(detect.specs, servers);
  const sp = detect.specs || {};
  if (v === 'ready') {
    const names = [...new Set(servers.filter((s) => A.chatModels(s.models).length).map((s) => A.AI_KIND_LABELS[s.kind] || s.kind))].join(', ');
    const n = servers.reduce((c, s) => c + A.chatModels(s.models).length, 0);
    const line = n === 1 ? `${names} is running with one model to choose from.` : `${names} is running with ${n} models to choose from.`;
    return h('div', { class: 'callout callout--ok', 'data-key': 'ai-verdict', 'data-verdict': v }, icon('check'), h('div', {}, h('strong', { text: 'Recommended for this computer' }), h('p', { text: line })));
  }
  const ram = fmtGb(sp.ramGb);
  const vram = fmtGb(sp.vramGb);
  const specText = sp.unified ? `${ram} GB of memory shared with the graphics` : sp.vramGb ? `${ram} GB of memory and ${vram} GB on the graphics card` : `${ram} GB of memory`;
  if (v === 'capable') {
    return h(
      'div',
      { class: 'callout', 'data-key': 'ai-verdict', 'data-verdict': v },
      icon('info'),
      h(
        'div',
        {},
        h('strong', { text: 'This computer can run a local model' }),
        h('p', { text: `It has ${specText}, but no model server is running. To use the assistant, install Ollama (ollama.com) and download a model, then press Look again:` }),
        h(
          'div',
          { class: 'command' },
          h('code', { translate: 'no', text: PULL }),
          h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'ai-copy-pull', onclick: async () => toast((await copyText(PULL)) ? 'Command copied' : 'Copy failed: select the text instead') }, icon('copy'), 'Copy'),
        ),
      ),
    );
  }
  return h(
    'div',
    { class: 'callout callout--warn', 'data-key': 'ai-verdict', 'data-verdict': v },
    icon('info'),
    h('div', {}, h('strong', { text: 'Not recommended for this computer' }), h('p', { text: `A local model needs about ${A.MIN_RAM_GB} GB of memory or a graphics card with ${A.MIN_VRAM_GB} GB. This computer has ${specText}.` })),
  );
}

/**
 * @param {object} o
 * @param {object} o.ai             settings.ai
 * @param {object} o.detect         idleDetect() state
 * @param {(next: object) => void} o.onChange  a new settings.ai
 * @param {(port?: number) => void} o.onDetect  look again
 * @param {(ai: object) => void} [o.onUnload]  frees the model's memory (also when switched off)
 * @param {boolean} [o.full]        Settings: how much a question reads, another port, memory
 */
export function assistantControls({ ai, detect, onChange, onDetect, onUnload = null, full = false }) {
  const servers = detect.status === 'done' ? detect.servers : [];
  const options = servers.flatMap((s) => A.chatModels(s.models).map((model) => ({ kind: s.kind, port: s.port, model })));
  const current = options.find((x) => x.kind === ai.kind && x.port === ai.port && x.model === ai.model);
  const canTurnOn = options.length > 0 || ai.enabled;
  const set = (patch) => onChange(A.normalizeAi({ ...ai, ...patch }));
  const tid = 'sw-ai-t';
  const did = 'sw-ai-d';
  const portBox = full
    ? h('input', {
        id: 'aiPort',
        class: 'input ai-port',
        type: 'number',
        min: 1,
        max: 65535,
        inputmode: 'numeric',
        placeholder: '8000',
        value: ai.kind === 'custom' && ai.port ? String(ai.port) : '',
        'data-key': 'ai-port',
      })
    : null;
  const lookAgain = () => {
    const raw = portBox ? portBox.value.trim() : '';
    const port = Number(raw);
    if (raw && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      toast('Enter a port from 1 to 65535.');
      portBox.focus();
      return;
    }
    onDetect(raw ? port : 0);
  };

  return h(
    'div',
    { class: 'ai-controls' },
    verdictEl(detect, servers),
    h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row__text' },
        h('div', { class: 'switch-row__title', id: tid, text: 'Use the assistant' }),
        h('div', { class: 'switch-row__desc', id: did, text: 'Adds Ask to the sidebar: questions about the catalogs and threads you have open, answered with links to the posts.' }),
      ),
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(ai.enabled),
        'aria-labelledby': tid,
        'aria-describedby': did,
        'data-key': 'switch-ai',
        disabled: !canTurnOn,
        onclick: () => {
          if (ai.enabled) {
            // switched off: the model's memory is freed too
            set({ enabled: false });
            onUnload?.(ai);
            return;
          }
          const pick = current || A.pickModel(ai, servers);
          set(pick ? { enabled: true, kind: pick.kind, port: pick.port, model: pick.model } : { enabled: true });
        },
      }),
    ),
    options.length && ai.enabled
      ? h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'aiModel', text: 'Model' }),
          h(
            'select',
            {
              id: 'aiModel',
              class: 'input',
              'data-key': 'ai-model',
              onchange: (e) => {
                const x = options[Number(e.target.value)];
                if (x) set({ kind: x.kind, port: x.port, model: x.model });
              },
            },
            current ? null : h('option', { value: '', text: ai.model ? `${ai.model} (not found now)` : 'Choose a model', selected: true, disabled: true }),
            options.map((x, i) =>
              h('option', { value: String(i), selected: x === current, translate: 'no', text: `${x.model} · ${A.AI_KIND_LABELS[x.kind] || x.kind}${x.kind === 'custom' ? ` :${x.port}` : ''}` }),
            ),
          ),
          h('p', { class: 'field__hint', text: 'A model of 7 or 8 billion parameters answers well; smaller ones are faster but miss more.' }),
        )
      : null,
    full
      ? h(
          'div',
          { class: 'field' },
          h('div', { class: 'field__label', id: 'seg-ai-reach', text: 'How much one question reads' }),
          h(
            'div',
            { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'seg-ai-reach' },
            [
              { v: 'short', label: 'Less' },
              { v: 'normal', label: 'Normal' },
              { v: 'long', label: 'More' },
            ].map((x) =>
              h(
                'label',
                {},
                h('input', { type: 'radio', name: 'ai-reach', value: x.v, checked: ai.reach === x.v, 'data-key': `ai-reach-${x.v}`, onchange: () => set({ reach: x.v }) }),
                h('span', { text: x.label }),
              ),
            ),
          ),
          h('p', { class: 'field__hint', text: 'More finds more, but each answer takes longer and needs a model with a long context.' }),
        )
      : null,
    full
      ? h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'aiPort', text: 'Another server on this computer (port)' }),
          portBox,
          h('p', { class: 'field__hint', text: 'Ollama, LM Studio, llama.cpp and Jan are found on their usual ports. A server elsewhere on this computer that speaks the OpenAI API: enter its port and press Look again.' }),
        )
      : null,
    full && ai.enabled && onUnload ? memoryEl(ai, detect, onUnload) : null,
    h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn', 'data-key': 'ai-detect', disabled: detect.status === 'checking', onclick: lookAgain }, icon('refresh'), 'Look again')),
    h(
      'div',
      { class: 'callout' },
      icon('shield'),
      h('div', { text: 'Local only: CloverEye talks to the model server on this computer and nowhere else. Questions and posts never leave it, and asking makes no request to the site.' }),
    ),
  );
}
