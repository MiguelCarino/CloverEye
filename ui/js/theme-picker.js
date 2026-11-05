// The theme picker, shared by setup's Look step and Settings → Look: one
// radio group (name="theme") laid out as grouped cards with a small swatch.

import { THEME_GROUPS } from './setup-model.js';
import { h } from './dom.js';

/**
 * @param {object} o
 * @param {string} o.value          the current theme id
 * @param {(id: string) => void} o.onChange
 */
export function themePicker({ value, onChange }) {
  return h(
    'div',
    { class: 'field theme-picker' },
    h('div', { class: 'field__label', id: 'theme-label', text: 'Theme' }),
    h(
      'div',
      { class: 'theme-picker__groups', role: 'radiogroup', 'aria-labelledby': 'theme-label' },
      THEME_GROUPS.map((g) =>
        h(
          'div',
          { class: 'theme-picker__group', role: 'group', 'aria-labelledby': `theme-group-${g.id}` },
          h('div', { class: 'theme-picker__heading', id: `theme-group-${g.id}`, text: g.label }),
          h(
            'div',
            { class: 'theme-picker__grid' },
            g.themes.map((t) =>
              h(
                'label',
                { class: 'theme-card' },
                h('input', {
                  type: 'radio',
                  name: 'theme',
                  value: t.id,
                  checked: t.id === value,
                  'data-key': `theme-${t.id}`,
                  onchange: () => onChange(t.id),
                }),
                h(
                  'span',
                  { class: 'theme-card__swatch', 'aria-hidden': 'true', style: { background: t.swatch[0] } },
                  h('span', { class: 'theme-card__card', style: { background: t.swatch[1] } }, h('span', { class: 'theme-card__text', style: { background: t.swatch[3] } })),
                  h('span', { class: 'theme-card__dot', style: { background: t.swatch[2] } }),
                ),
                h('span', { class: 'theme-card__name', text: t.label }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
