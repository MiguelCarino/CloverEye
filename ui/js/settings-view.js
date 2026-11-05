// Settings, inside the shell. Look (theme, density, text size) and Content
// (NSFW boards, which setup never asks about) save as soon as they change.

import * as M from './setup-model.js';
import { h, icon, toast } from './dom.js';
import { applyLook } from './look.js';
import { askAdult } from './setup.js';
import { themePicker } from './theme-picker.js';

function segmented(key, label, options, value, onChange) {
  const id = `set-seg-${key}`;
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field__label', id, text: label }),
    h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-labelledby': id },
      options.map((o) =>
        h(
          'label',
          {},
          h('input', {
            type: 'radio',
            name: `set-${key}`,
            value: String(o.value),
            checked: o.value === value,
            'data-key': `${key}-${o.value}`,
            onchange: () => onChange(o.value),
          }),
          h('span', { text: o.label }),
        ),
      ),
    ),
  );
}

/**
 * @param {object} o
 * @param {object} o.settings        current settings
 * @param {Array|null} o.boards      board list, if loaded this session
 * @param {(next: object, how?: {redraw?: boolean, focus?: string}) => void} o.onChange  saves and keeps the new settings
 * @param {() => void} o.onRunSetup
 */
export function renderSettings({ settings, boards, onChange, onRunSetup }) {
  const s = settings;
  const look = (mutate) => {
    const next = structuredClone(s);
    mutate(next);
    applyLook(next);
    onChange(next, { redraw: false });
    Object.assign(s, next); // the radios already show it; no redraw needed
  };
  const nsfwOn = M.nsfwVisible(s);
  const confirmed = s.nsfw.confirmedAdultAt ? new Date(s.nsfw.confirmedAdultAt) : null;

  return h(
    'div',
    { class: 'settings' },
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-look' },
      h('h2', { class: 'settings__heading', id: 'set-look', text: 'Look' }),
      themePicker({ value: s.theme, onChange: (v) => look((n) => (n.theme = v)) }),
      segmented(
        'density',
        'Density',
        [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ],
        s.density,
        (v) => look((n) => (n.density = v)),
      ),
      segmented('text', 'Text size', M.TEXT_SCALES, s.textScale, (v) => look((n) => (n.textScale = v))),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-hover-t', text: 'Preview files on hover' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-hover-d',
            text: 'Resting the mouse on a thumbnail shows the full image, or plays the video muted, as large as the window allows.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(s.ui?.hoverPreview !== false),
          'aria-labelledby': 'sw-hover-t',
          'aria-describedby': 'sw-hover-d',
          'data-key': 'switch-hover',
          onclick: () => {
            const next = structuredClone(s);
            next.ui = { ...next.ui, hoverPreview: s.ui?.hoverPreview === false };
            applyLook(next);
            onChange(next, { focus: 'switch-hover' });
          },
        }),
      ),
    ),
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-content' },
      h('h2', { class: 'settings__heading', id: 'set-content', text: 'Content' }),
      h(
        'div',
        { class: 'switch-row' },
        h(
          'div',
          { class: 'switch-row__text' },
          h('div', { class: 'switch-row__title', id: 'sw-nsfw-t', text: 'Show NSFW boards' }),
          h('div', {
            class: 'switch-row__desc',
            id: 'sw-nsfw-d',
            text: 'Boards the site marks as not worksafe. While this is off they never appear in board lists, favourites or search. Turning it on asks you to confirm you are 18 or older; turning it off forgets that.',
          }),
        ),
        h('button', {
          type: 'button',
          class: 'switch',
          role: 'switch',
          'aria-checked': String(nsfwOn),
          'aria-labelledby': 'sw-nsfw-t',
          'aria-describedby': 'sw-nsfw-d',
          'data-key': 'switch-nsfw',
          onclick: (e) => {
            if (M.nsfwVisible(s)) {
              onChange(M.setNsfw(s, false, { boards }), { focus: 'switch-nsfw' });
              toast('NSFW boards hidden');
            } else {
              askAdult(e.currentTarget, () => {
                onChange(M.setNsfw(s, true, { confirmedAdult: true }), { focus: 'switch-nsfw' });
                toast('NSFW boards will be shown');
              });
            }
          },
        }),
      ),
      h(
        'div',
        { class: 'state-line' },
        nsfwOn
          ? h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'All boards, NSFW included')
          : h('span', { class: 'pill pill--ok' }, h('span', { class: 'dot' }), 'Worksafe boards only'),
        nsfwOn && confirmed ? h('span', { text: `18+ confirmed ${confirmed.toLocaleDateString()}` }) : null,
      ),
    ),
    h(
      'section',
      { class: 'settings__section', 'aria-labelledby': 'set-setup' },
      h('h2', { class: 'settings__heading', id: 'set-setup', text: 'Setup' }),
      h('p', { class: 'field__hint', text: 'Walk through the first-time steps again: look, favourites, video, watching, files.' }),
      h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn', 'data-key': 'rerun', onclick: () => onRunSetup() }, icon('refresh'), 'Run setup again')),
    ),
  );
}
